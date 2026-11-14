// githttp.ts — a from-scratch git smart-HTTP server for the make.fun forge.
//
// Implements the git wire protocol with nothing but Node 22's standard library:
//   node:zlib  (deflateSync / inflateSync)   node:crypto (createHash sha1)
//
// Services:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack      upload-pack advertisement (v2 + v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack     receive-pack advertisement (v0)
//   POST /{owner}/{repo}.git/git-upload-pack                        ls-refs (v2) + fetch (v2 + v0), packs written
//   POST /{owner}/{repo}.git/git-receive-pack                       push: unpack the client's pack, fast-forward refs
//
// Everything is implemented by hand: pkt-line framing, the packfile format (non-delta write, delta read),
// and the git object model (commit / tree / blob / tag). Object ids are sha1("<type> <len>\0<content>").
//
// Integration: git data (objects + refs) lives beside the REST `Store` (which holds repos, files, issues,
// pulls, labels). After a push advances the default branch the tip commit's tree is projected back into
// `store.files`, so GET /api/v3/repos/{o}/{r}/contents reads exactly what a `git clone` would.
//
// Public surface:
//   export function handleGit(method, urlPath, query, headers, body, store)
//      -> {status, body, headers?} | null   (null means "not a git route")
//
// Node 22, erasable TypeScript, no npm.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Store } from './restv3.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
const PKT_LINE_MAX = 65520;
/** The largest payload a pkt-line can carry. */
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Side-band-64k data packets carry a 1-byte band prefix, so a chunk is one byte smaller. */
const SIDEBAND_CHUNK = PKT_LINE_MAX_PAYLOAD - 1;
/** The all-zero oid: an unborn branch / a delete in a receive-pack command list. */
const ZERO_OID = '0'.repeat(40);
/** The agent string advertised to clients. */
const AGENT = 'makefun-forge/git-1.0';

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObj {
  readonly type: ObjType;
  readonly data: Buffer;
}

interface RepoGit {
  /** object id -> object */
  readonly objects: Map<string, GitObj>;
  /** refname -> object id */
  readonly refs: Map<string, string>;
  /** Bumped on every object/ref write; invalidates derived caches (packs, advertisements). */
  gen: number;
  /** object id -> its deflated pack entry (header + zlib stream). Objects are immutable, so this is
   *  permanently valid and lets concurrent clones reuse compressed bytes instead of re-deflating. */
  readonly deflated: Map<string, Buffer>;
  /** gen -> cached v2 upload-pack advertisement body (refs change only on a push). */
  advV2?: { gen: number; body: Buffer };
  /** gen -> cached ls-refs body for the standard prefix set. */
  lsRefs?: { gen: number; body: Buffer };
  /** signature -> cached fetch response body for the identical request. */
  fetchCache?: Map<string, Buffer>;
  /** gen the fetchCache entries were built at. */
  fetchGen?: number;
}

/** Result of a request handler. */
interface HandlerResult {
  status: number;
  body: Buffer | string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// git per-store side storage
// ---------------------------------------------------------------------------

/**
 * Git objects and refs, keyed by the REST `Store` they belong to. The REST store models GitHub
 * resources; this is the git side of the same repository. Keyed with a WeakMap so it lives and dies
 * with the store and never leaks between servers.
 */
const gitStores = new WeakMap<Store, Map<string, RepoGit>>();

function gitFor(store: Store): Map<string, RepoGit> {
  let map = gitStores.get(store);
  if (!map) {
    map = new Map();
    gitStores.set(store, map);
  }
  return map;
}

function repoGit(store: Store, key: string): RepoGit {
  const map = gitFor(store);
  let rg = map.get(key);
  if (!rg) {
    rg = {
      objects: new Map(),
      refs: new Map(),
      gen: 0,
      deflated: new Map(),
    };
    map.set(key, rg);
  }
  return rg;
}

// ---------------------------------------------------------------------------
// exported accessors (REST / GraphQL) — the SAME refs git serves
// ---------------------------------------------------------------------------
//
// The git side keeps refs in a WeakMap side-store (above). The REST git-data
// surface (git/refs, branches, commits) must read and write exactly those refs
// so a ref created over REST is advertised to `git fetch` and vice versa.

/** Every refname -> sha for a repo, as a fresh Map (empty when none). */
export function gitListRefs(store: Store, owner: string, repo: string): Map<string, string> {
  return new Map(repoGit(store, `${owner}/${repo}`).refs);
}

/** The sha a full refname points at, or null when the ref does not exist. */
export function gitGetRef(store: Store, owner: string, repo: string, ref: string): string | null {
  return repoGit(store, `${owner}/${repo}`).refs.get(ref) ?? null;
}

/** Point a full refname at sha (creating or updating it). */
export function gitSetRef(store: Store, owner: string, repo: string, ref: string, sha: string): void {
  const rg = repoGit(store, `${owner}/${repo}`);
  rg.refs.set(ref, sha);
  rg.gen += 1; // invalidate the fetch-response cache: the reachable set may have changed
}

/**
 * Record a commit object the REST surface created (a synthetic commit with no
 * pack behind it). The commit is stored as a real git commit object *and* the
 * refs are advanced, so `git fetch` can serve it and REST can read it back.
 */
export function gitRecordCommit(
  store: Store,
  owner: string,
  repo: string,
  sha: string,
  commitObj: { tree?: string; parents?: string[]; author?: string; committer?: string; message?: string; timestamp?: number },
): void {
  const rg = repoGit(store, `${owner}/${repo}`);
  const tree = commitObj.tree && isHex40(commitObj.tree) ? commitObj.tree : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const timestamp = commitObj.timestamp ?? Math.floor(Date.now() / 1000);
  const author = commitObj.author ?? 'forge <forge@localhost>';
  const committer = commitObj.committer ?? author;
  const data = buildCommit({
    tree,
    parents: commitObj.parents ?? [],
    message: commitObj.message ?? '',
    author: author.replace(/\s+\d+\s+[+-]\d{4}$/, ''),
    committer: committer.replace(/\s+\d+\s+[+-]\d{4}$/, ''),
    timestamp,
  });
  rg.objects.set(sha, { type: 'commit', data });
}

/** The parsed commit for sha (from the git object store), or null. */
export function gitGetCommit(
  store: Store,
  owner: string,
  repo: string,
  sha: string,
): { sha: string; tree: string; parents: string[]; author: string; committer: string; message: string } | null {
  const rg = repoGit(store, `${owner}/${repo}`);
  const obj = rg.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  return { sha, tree: c.tree, parents: c.parents, author: c.author, committer: c.committer, message: c.message };
}

/** The commit oids reachable from a ref (or every reachable commit when refName is null), newest first. */
export function gitListCommits(store: Store, owner: string, repo: string, refName?: string | null): string[] {
  const rg = repoGit(store, `${owner}/${repo}`);
  const start = refName ? rg.refs.get(refName) : undefined;
  const roots: string[] = [];
  if (start) roots.push(start);
  else {
    const head = rg.refs.get('HEAD');
    if (head) roots.push(head);
    for (const [name, oid] of rg.refs) if (name.startsWith('refs/heads/')) roots.push(oid);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = rg.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// basic helpers
// ---------------------------------------------------------------------------

function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** git's object id: sha1 over "<type> <len>\0<content>". */
function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Look up the header key of a request without caring about its case. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return undefined;
}

function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

/** Encode one data pkt-line: 4 hex length bytes (payload + 4) then the payload. */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode the pkt-lines at the front of `buf`; return the packets and how many bytes they consumed. */
function readPktLines(buf: Buffer): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const header = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = Number.parseInt(header, 16);
    if (len === 0) {
      off += 4;
      packets.push({ kind: 'flush' });
      continue;
    }
    if (len === 1) {
      off += 4;
      packets.push({ kind: 'delim' });
      continue;
    }
    if (len === 2) {
      off += 4;
      packets.push({ kind: 'response-end' });
      continue;
    }
    if (len < 4 || off + len > buf.length) {
      // Truncated or malformed: stop handing back packets; the raw remainder is handled by the caller.
      throw new Error(`malformed pkt-line length ${header}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, offset: off };
}

/** Every data packet's text, newlines stripped. */
function pktLines(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8').replace(/\r?\n$/, ''));
  return out;
}

/** Build a pkt-line stream from lines plus an optional trailing flush. */
function pktStream(lines: string[], flush = true): Buffer {
  const parts = lines.map((l) => pkt(l));
  if (flush) parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// object model: parse / build
// ---------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('tree entry: no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry: no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry: truncated oid');
    entries.push({
      mode: data.toString('ascii', off, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    off = nul + 21;
  }
  return entries;
}

/** git's tree-entry order: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.toString('utf8', 0, headerEnd);
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.toString('utf8', 0, headerEnd).split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.toString('utf8', blank + 2),
  };
}

/** Build a commit object's bytes (used for the forge's own merge commits). */
function buildCommit(fields: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${tz}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

interface Lookup {
  (oid: string): GitObj | undefined;
}

/**
 * Every object reachable from `roots`. `stop` is a set of commit oids whose parents are NOT followed
 * (the client's shallow boundary): the commit and its tree are still visited, but history above it is not.
 */
function walkClosure(roots: Iterable<string>, lookup: Lookup, stop?: Set<string>, allowMissing = true): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isHex40(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (isHex40(c.tree)) queue.push(c.tree);
      if (!stop || !stop.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink: names a commit this repo does not hold
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

/** The full tree closure of a tree oid (trees + blobs; gitlinks skipped). */
function treeClosure(treeOid: string, lookup: Lookup, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    into.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        stack.push(e.oid);
      }
    }
  }
}

/** True when `ancestor` is reachable from `descendant` by following parent links. */
function isAncestor(ancestor: string, descendant: string, lookup: Lookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// ---------------------------------------------------------------------------
// packfile: read
// ---------------------------------------------------------------------------

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert ops) to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint truncated');
      const b = delta[off++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert truncated');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** The sha1 of every pack byte before its 20-byte trailer. */
function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack shorter than its trailer');
  return sha1Hex(pack.subarray(0, pack.length - 20));
}

/**
 * Read a packfile (version 2 or 3), resolving NON_DELTA and OFS_DELTA / REF_DELTA objects. A REF_DELTA
 * base that is not in the pack is looked up through `resolveBase` (a thin pack's base the server holds).
 */
function readPack(pack: Buffer, resolveBase?: Lookup): { objects: Map<string, GitObj>; count: number; deltas: number } {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = packChecksum(pack);
  const trailer = pack.toString('hex', trailerStart);
  if (computed !== trailer) throw new Error(`pack trailer ${trailer} does not match ${computed}`);

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < declared; i += 1) {
    const entryOffset = off;
    if (off >= pack.length) throw new Error('pack truncated in headers');
    let byte = pack[off++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (off >= pack.length) throw new Error('pack entry size varint truncated');
      byte = pack[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (off >= pack.length) throw new Error('ofs-delta has no base offset');
      let b = pack[off++];
      let value = b & 0x7f;
      while (b & 0x80) {
        if (off >= pack.length) throw new Error('ofs-delta base offset truncated');
        b = pack[off++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names bad base ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id truncated');
      entry.baseOid = pack.toString('hex', off, off + 20);
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes, inflated ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error(`pack has ${trailerStart - off} stray bytes before its trailer`);

  const objects = new Map<string, GitObj>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltas = 0;
  for (const entry of raw) {
    const r = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltas += 1;
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { objects, count: objects.size, deltas };
}

// ---------------------------------------------------------------------------
// packfile: write (non-delta only — always legal)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects; the trailer is sha1 over everything before it. */
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------------------
// side-band-64k framing
// ---------------------------------------------------------------------------

/** Wrap raw bytes as band-`band` sideband data packets, chunked to the 64k limit. */
function sidebandChunks(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += SIDEBAND_CHUNK) {
    const slice = data.subarray(i, i + SIDEBAND_CHUNK);
    out.push(pkt(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

interface RefEntry {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Peel a tag (or any object) to the commit it ultimately names, if any. */
function peelToCommit(oid: string, lookup: Lookup): string | undefined {
  let cur = oid;
  const seen = new Set<string>();
  for (let i = 0; i < 16; i += 1) {
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    const obj = lookup(cur);
    if (!obj) return undefined;
    if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (!isHex40(t.object)) return undefined;
      cur = t.object;
      continue;
    }
    return obj.type === 'commit' ? cur : undefined;
  }
  return undefined;
}

/** Build the full ref list: HEAD (symref, possibly unborn) then sorted refs. */
function collectRefs(store: Store, rg: RepoGit, key: string, lookup: Lookup): RefEntry[] {
  const out: RefEntry[] = [];
  const repo = store.repos.get(key);
  const defaultBranch = repo?.default_branch || 'main';
  const headTarget = `refs/heads/${defaultBranch}`;
  const headOid = rg.refs.get(headTarget);
  if (headOid) {
    out.push({ name: 'HEAD', oid: headOid, symrefTarget: headTarget });
  } else {
    out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headTarget, unborn: true });
  }
  const names = [...rg.refs.keys()].sort();
  for (const name of names) {
    const oid = rg.refs.get(name) as string;
    const entry: RefEntry = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(oid, lookup);
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function lookupFor(rg: RepoGit): Lookup {
  return (oid: string) => rg.objects.get(oid);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const UPLOAD_PACK_CAPS_V0 =
  `multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress symref=HEAD:refs/heads/`;
const RECEIVE_PACK_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

/**
 * GET /{o}/{r}.git/info/refs — the service advertisement. Serves protocol v2 for upload-pack when the
 * client asks (Git-Protocol: version=2) and v0 otherwise; receive-pack is always v0.
 */
function advertiseInfoRefs(
  store: Store,
  key: string,
  service: string,
  gitProtocol: string | undefined,
): HandlerResult {
  const rg = repoGit(store, key);
  const lookup = lookupFor(rg);
  const wantV2 = service === 'git-upload-pack' && /version=2/.test(gitProtocol ?? '');

  const parts: Buffer[] = [];
  parts.push(pkt(`# service=${service}\n`));
  parts.push(FLUSH);

  if (wantV2) {
    parts.push(pkt('version 2\n'));
    parts.push(pkt(`agent=${AGENT}\n`));
    parts.push(pkt('ls-refs=unborn\n'));
    parts.push(pkt('fetch=shallow\n'));
    parts.push(pkt('server-option\n'));
    parts.push(pkt('object-format=sha1\n'));
    parts.push(FLUSH);
    return {
      status: 200,
      body: Buffer.concat(parts),
      headers: {
        'Content-Type': 'application/x-git-upload-pack-advertisement',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      },
    };
  }

  const refs = collectRefs(store, rg, key, lookup);
  const defaultBranch = store.repos.get(key)?.default_branch || 'main';

  if (service === 'git-receive-pack') {
    const caps = RECEIVE_PACK_CAPS_V0;
    const real = refs.filter((r) => r.name !== 'HEAD');
    if (real.length === 0) {
      parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    } else {
      real.forEach((r, i) => {
        parts.push(i === 0 ? pkt(`${r.oid} ${r.name}\u0000${caps}\n`) : pkt(`${r.oid} ${r.name}\n`));
      });
    }
    parts.push(FLUSH);
    return {
      status: 200,
      body: Buffer.concat(parts),
      headers: {
        'Content-Type': 'application/x-git-receive-pack-advertisement',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      },
    };
  }

  // v0 upload-pack
  const caps = `${UPLOAD_PACK_CAPS_V0}${defaultBranch} agent=${AGENT}`;
  const real = refs.filter((r) => r.name !== 'HEAD');
  if (real.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    real.forEach((r, i) => {
      parts.push(i === 0 ? pkt(`${r.oid} ${r.name}\u0000${caps}\n`) : pkt(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pkt(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return {
    status: 200,
    body: Buffer.concat(parts),
    headers: {
      'Content-Type': 'application/x-git-upload-pack-advertisement',
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    },
  };
}

// ---------------------------------------------------------------------------
// upload-pack: ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(store: Store, key: string, args: string[]): HandlerResult {
  const rg = repoGit(store, key);
  const lookup = lookupFor(rg);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') {
      /* accepted; we always list HEAD */
    } else if (arg.startsWith('ref-prefix')) {
      const p = arg.slice('ref-prefix'.length).trim();
      if (p) prefixes.push(p);
    }
  }
  const all = collectRefs(store, rg, key, lookup);
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  for (const ref of all) {
    if (!matches(ref.name)) continue;
    if (ref.unborn) {
      const tail = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      lines.push(`unborn ${ref.name}${tail}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return {
    status: 200,
    body: pktStream(lines, true),
    headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
  };
}

// ---------------------------------------------------------------------------
// upload-pack: fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  done: boolean;
  depth?: number;
  shallow: string[];
  hasShallow: boolean;
}

/** A stable identity for a fetch, so identical concurrent fetches share one pack build. */
function fetchSig(req: FetchRequest): string {
  return `${req.wants.slice().sort().join(',')}|${req.haves.slice().sort().join(',')}|${req.depth ?? ''}|${req.shallow.slice().sort().join(',')}|${req.hasShallow ? 1 : 0}|${req.done ? 1 : 0}`;
}

/**
 * Resolve which objects a fetch must send.
 *   - depth == undefined: the whole closure of `wants`, minus the closure of `haves`.
 *   - depth set: only commits within `depth` generations, plus each commit's full tree; a moving
 *     shallow boundary is returned.
 */
function planFetch(
  rg: RepoGit,
  req: FetchRequest,
): { objects: GitObj[]; newShallow: string[]; unshallow: string[] } {
  const lookup = lookupFor(rg);
  const clientShallow = new Set(req.shallow);

  const havesSet = walkClosure(req.haves, lookup, clientShallow);

  // Resolve tag wants to their target commit while keeping the tag object itself.
  const extra = new Set<string>();
  const commitRoots: string[] = [];
  for (const w of req.wants) {
    const obj = lookup(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extra.add(w);
      const t = parseTag(obj.data);
      if (isHex40(t.object)) commitRoots.push(t.object);
    } else {
      commitRoots.push(w);
    }
  }

  const sendSet = new Set<string>();
  for (const e of extra) sendSet.add(e);
  const newShallow: string[] = [];
  const unshallow: string[] = [];

  if (req.depth === undefined) {
    const full = walkClosure(commitRoots, lookup);
    for (const oid of full) sendSet.add(oid);
    for (const e of extra) sendSet.add(e);
  } else {
    const depth = Math.max(1, req.depth);
    const includedCommits = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<{ oid: string; gen: number }> = commitRoots.map((oid) => ({ oid, gen: 1 }));
    const boundaries = new Set<string>();
    while (queue.length) {
      const { oid, gen } = queue.pop() as { oid: string; gen: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = lookup(oid);
      if (!obj || obj.type !== 'commit') continue;
      includedCommits.add(oid);
      const c = parseCommit(obj.data);
      if (gen >= depth) {
        if (c.parents.length > 0) boundaries.add(oid);
      } else {
        for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
      }
    }
    for (const oid of includedCommits) {
      sendSet.add(oid);
      const obj = lookup(oid) as GitObj;
      const tree = parseCommit(obj.data).tree;
      if (isHex40(tree)) treeClosure(tree, lookup, sendSet);
    }
    for (const b of boundaries) if (!havesSet.has(b)) newShallow.push(b);
    for (const s of clientShallow) {
      if (includedCommits.has(s) && !boundaries.has(s)) unshallow.push(s);
    }
  }

  const objects: GitObj[] = [];
  for (const oid of sendSet) {
    if (havesSet.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  return { objects, newShallow, unshallow };
}

function handleFetch(store: Store, key: string, req: FetchRequest): HandlerResult {
  const rg = repoGit(store, key);
  // Cache the whole response keyed by the fetch signature + the repo generation.
  // 50 concurrent depth-1 clones of one repo send identical requests, so one
  // build serves them all; a push bumps gen and invalidates this.
  const sig = fetchSig(req);
  const cacheKey = `${rg.gen}:${sig}`;
  if (rg.fetchCache && rg.fetchGen === rg.gen) {
    const hit = rg.fetchCache.get(cacheKey);
    if (hit) {
      return {
        status: 200,
        body: hit,
        headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
      };
    }
  }
  const { objects, newShallow, unshallow } = planFetch(rg, req);
  const pack = writePack(objects);

  const out: Buffer[] = [];
  out.push(pkt('acknowledgments\n'));
  out.push(pkt('NAK\n'));
  out.push(FLUSH);
  if (req.hasShallow || newShallow.length || unshallow.length) {
    const lines: string[] = ['shallow-info\n'];
    for (const u of unshallow) lines.push(`unshallow ${u}\n`);
    for (const s of newShallow) lines.push(`shallow ${s}\n`);
    out.push(pktStream(lines, true));
  }
  out.push(pkt('packfile\n'));
  out.push(...sidebandChunks(1, pack));
  out.push(FLUSH);
  const body = Buffer.concat(out);
  if (!rg.fetchCache || rg.fetchGen !== rg.gen) {
    rg.fetchCache = new Map();
    rg.fetchGen = rg.gen;
  }
  rg.fetchCache.set(cacheKey, body);
  return {
    status: 200,
    body,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
  };
}

/** v0 upload-pack response: a plain NAK, then the pack on band 1 (side-band-64k is always negotiated). */
function handleFetchV0(store: Store, key: string, req: FetchRequest): HandlerResult {
  const rg = repoGit(store, key);
  const { objects, newShallow, unshallow } = planFetch(rg, req);
  const pack = writePack(objects);

  const out: Buffer[] = [];
  for (const u of unshallow) out.push(pkt(`unshallow ${u}\n`));
  for (const s of newShallow) out.push(pkt(`shallow ${s}\n`));
  out.push(pkt('NAK\n'));
  out.push(...sidebandChunks(1, pack));
  out.push(FLUSH);
  return {
    status: 200,
    body: Buffer.concat(out),
    headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
  };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the receive-pack request: the command list and the trailing pack (or null). */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; caps: string[]; pack: Buffer | null } {
  const { packets, offset } = readPktLines(body);
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let first = true;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    if (first) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        caps = text.slice(nul + 1).trim().split(/\s+/).filter(Boolean);
        text = text.slice(0, nul);
      }
      first = false;
    }
    text = text.replace(/\r?\n$/, '');
    if (!text) continue;
    const sp = text.indexOf(' ');
    if (sp < 0) throw new Error(`bad receive-pack command ${JSON.stringify(text)}`);
    const oldOid = text.slice(0, sp);
    const rest = text.slice(sp + 1);
    const sp2 = rest.indexOf(' ');
    if (sp2 < 0) throw new Error(`bad receive-pack command ${JSON.stringify(text)}`);
    commands.push({ oldOid, newOid: rest.slice(0, sp2), ref: rest.slice(sp2 + 1) });
  }
  const pack = body.length - offset >= 4 ? body.subarray(offset) : null;
  return { commands, caps, pack };
}

/** Project the default branch's tip tree into the REST store's file map, so contents/ reads it. */
function projectFiles(store: Store, key: string, commitOid: string, rg: RepoGit): void {
  const [owner, name] = key.split('/');
  const lookup = lookupFor(rg);
  const commit = rg.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return;
  const nowIso = new Date().toISOString();
  const walk = (treeOid: string, prefix: string): void => {
    const tree = lookup(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '160000') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
        continue;
      }
      const blob = lookup(entry.oid);
      if (!blob || blob.type !== 'blob') continue;
      store.files.set(`${owner}/${name}:${path}`, {
        path,
        content: blob.data.toString('base64'),
        sha: entry.oid,
        size: blob.data.length,
        message: 'git push',
        updated_at: nowIso,
      });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  const repo = store.repos.get(key);
  if (repo) repo.updated_at = nowIso;
}

/**
 * Flatten a tree into `path -> blob oid`, skipping gitlinks and non-blob entries.
 * Used to diff a pushed branch's tip against its parent.
 */
function flattenTreePaths(lookup: Lookup, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const tree = lookup(oid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '160000') continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
        continue;
      }
      out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Record, for a NON-DEFAULT branch that just received a push, the set of file paths that differ
 * from the commit's first parent. This is what graphql.ts reads (branchFiles) to answer a pull
 * request's changed files. Purely additive paths (a fixture branch adding one file) show up here.
 */
function recordBranchFiles(store: Store, key: string, branch: string, tipOid: string, rg: RepoGit): void {
  const lookup = lookupFor(rg);
  const tipCommit = rg.objects.get(tipOid);
  if (!tipCommit || tipCommit.type !== 'commit') return;
  const tip = parseCommit(tipCommit.data);
  const tipPaths = flattenTreePaths(lookup, tip.tree);

  let parentPaths = new Map<string, string>();
  const parentOid = tip.parents[0];
  if (parentOid) {
    const parentCommit = rg.objects.get(parentOid);
    if (parentCommit && parentCommit.type === 'commit') {
      parentPaths = flattenTreePaths(lookup, parseCommit(parentCommit.data).tree);
    }
  }

  const changed: string[] = [];
  for (const [path, oid] of tipPaths) {
    if (parentPaths.get(path) !== oid) changed.push(path);
  }
  for (const path of parentPaths.keys()) {
    if (!tipPaths.has(path)) changed.push(path);
  }
  const branchKey = `${key}#${branch}`;
  const existing = store.branchFiles.get(branchKey) || [];
  const merged = new Set<string>([...existing, ...changed]);
  store.branchFiles.set(branchKey, [...merged]);
}

function handleReceivePack(store: Store, key: string, body: Buffer): HandlerResult {
  let parsed: { commands: PushCommand[]; caps: string[]; pack: Buffer | null };
  try {
    parsed = parseReceivePack(body);
  } catch (err) {
    return receiveReport([`unpack ${errorText(err)}\n`], [], true, false);
  }
  const { commands, caps, pack } = parsed;
  const rg = repoGit(store, key);
  const lookup = lookupFor(rg);

  const sideband = caps.includes('side-band-64k');
  const wantReport = caps.includes('report-status') || caps.includes('report-status-v2') || caps.length === 0;

  // 1. Unpack the client's objects into the repo store.
  let unpackError: string | null = null;
  if (pack && pack.length >= 4) {
    try {
      const read = readPack(pack, lookup);
      for (const [oid, obj] of read.objects) rg.objects.set(oid, obj);
    } catch (err) {
      unpackError = errorText(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error\n`);
    return receiveReport(reportLines, commands, false, sideband, wantReport);
  }
  reportLines.push('unpack ok\n');

  for (const cmd of commands) {
    const current = rg.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} stale info\n`);
        continue;
      }
      rg.refs.delete(cmd.ref);
      rg.gen += 1; // invalidate the fetch cache
      reportLines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    // create or update
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} fetch first\n`);
        continue;
      }
    } else {
      if (cmd.oldOid === ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} already exists\n`);
        continue;
      }
      if (cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} stale info\n`);
        continue;
      }
      if (!isAncestor(current, cmd.newOid, lookup)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
    }
    if (!rg.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} missing necessary objects\n`);
      continue;
    }
    rg.refs.set(cmd.ref, cmd.newOid);
    rg.gen += 1; // invalidate the fetch cache
    reportLines.push(`ok ${cmd.ref}\n`);
  }

  // Reflect a moved default branch into the REST store, so contents/ serves the pushed blob.
  const repo = store.repos.get(key);
  const defaultBranchName = repo?.default_branch || 'main';
  const defaultBranch = `refs/heads/${defaultBranchName}`;
  const tip = rg.refs.get(defaultBranch);
  if (tip) projectFiles(store, key, tip, rg);

  // For every NON-DEFAULT branch that this push updated, record the paths that differ from the
  // commit's parent so graphql.ts's pullRequest.files can answer with the branch's changed paths.
  for (const cmd of commands) {
    const m = /^refs\/heads\/(.+)$/.exec(cmd.ref);
    if (!m) continue;
    const branch = m[1];
    if (branch === defaultBranchName) continue;
    const newTip = rg.refs.get(cmd.ref);
    if (!newTip) continue; // deleted or rejected
    recordBranchFiles(store, key, branch, newTip, rg);
  }

  return receiveReport(reportLines, commands, false, sideband, wantReport);
}

/** Frame a report-status stream: pkt-lined lines, optionally wrapped in band-1 sideband packets. */
function receiveReport(
  lines: string[],
  _commands: PushCommand[],
  _unpackFailed: boolean,
  sideband: boolean,
  wantReport = true,
): HandlerResult {
  const headers = {
    'Content-Type': 'application/x-git-receive-pack-result',
    'Cache-Control': 'no-cache',
  };
  if (!wantReport) {
    return { status: 200, body: sideband ? FLUSH : Buffer.alloc(0), headers };
  }
  const inner = pktStream(lines, true);
  if (!sideband) return { status: 200, body: inner, headers };
  const out: Buffer[] = [];
  out.push(...sidebandChunks(1, inner));
  out.push(FLUSH);
  return { status: 200, body: Buffer.concat(out), headers };
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\n/g, ' ').slice(0, 200);
}

// ---------------------------------------------------------------------------
// POST router
// ---------------------------------------------------------------------------

function handleUploadPack(store: Store, key: string, body: Buffer): HandlerResult {
  let packets: Pkt[];
  try {
    packets = readPktLines(body).packets;
  } catch (err) {
    return { status: 400, body: `pkt-line error: ${errorText(err)}`, headers: { 'Content-Type': 'text/plain' } };
  }
  const lines = pktLines(packets).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { status: 200, body: FLUSH, headers: { 'Content-Type': 'application/x-git-upload-pack-result' } };
  }
  const first = lines[0];
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    const args = lines.slice(1).filter((l) => !l.startsWith('agent=') && !l.startsWith('object-format='));
    try {
      if (command === 'ls-refs') return handleLsRefs(store, key, args);
      if (command === 'fetch') return handleFetch(store, key, parseFetchArgs(args, true));
    } catch (err) {
      return {
        status: 200,
        body: pktStream([`ERR ${errorText(err)}\n`], true),
        headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
      };
    }
    return {
      status: 200,
      body: pktStream([`ERR unknown command ${command}\n`], true),
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    };
  }
  // v0 fetch
  try {
    return handleFetchV0(store, key, parseFetchArgs(lines, false));
  } catch (err) {
    return {
      status: 200,
      body: pktStream([`ERR ${errorText(err)}\n`], true),
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    };
  }
}

function parseFetchArgs(lines: string[], v2: boolean): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  const depthKeys = v2 ? ['deepen ', 'deepen-since', 'deepen-not'] : ['deepen ', 'deepen-since', 'deepen-not'];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // v0 wants may carry the capability list: "want <oid> <caps...>"
    if (line.startsWith('want ')) wants.push(line.slice(5).split(/\s+/)[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') done = true;
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (depthKeys.some((k) => line.startsWith(k))) {
      // deepen-since / deepen-not: treated as a plain deepen when it also names a depth
    } else if (line.startsWith('filter ') || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') {
      // ignored
    }
  }
  return { wants: [...new Set(wants)].filter((w) => isHex40(w)), haves: [...new Set(haves)].filter((h) => isHex40(h)), done, depth, shallow, hasShallow: shallow.length > 0 || depth !== undefined };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)\/?$/;

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git route, so the caller can
 * fall through to REST/GraphQL/MCP.
 */
export function handleGit(
  method: string,
  urlPath: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: Buffer,
  store: Store,
): HandlerResult | null {
  const m = GIT_ROUTE.exec(urlPath || '');
  if (!m) return null;

  const owner = decodeSeg(m[1]);
  const name = decodeSeg(m[2]);
  const rest = m[3];
  const M = (method || 'GET').toUpperCase();
  const key = `${owner}/${name}`;

  try {
    if (!store.repos.has(key)) {
      return { status: 404, body: 'Not Found', headers: { 'Content-Type': 'text/plain' } };
    }

    if (rest === 'info/refs') {
      if (M !== 'GET' && M !== 'HEAD') {
        return { status: 405, body: 'Method Not Allowed', headers: { Allow: 'GET' } };
      }
      const service = query.get('service') || '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return { status: 400, body: 'dumb http transport is not supported', headers: { 'Content-Type': 'text/plain' } };
      }
      const gitProtocol = headerValue(headers, 'Git-Protocol');
      return advertiseInfoRefs(store, key, service, gitProtocol);
    }

    if (rest === 'git-upload-pack') {
      if (M !== 'POST') return { status: 405, body: 'Method Not Allowed', headers: { Allow: 'POST' } };
      return handleUploadPack(store, key, body ?? Buffer.alloc(0));
    }

    if (rest === 'git-receive-pack') {
      if (M !== 'POST') return { status: 405, body: 'Method Not Allowed', headers: { Allow: 'POST' } };
      return handleReceivePack(store, key, body ?? Buffer.alloc(0));
    }

    return null;
  } catch (err) {
    // A git bug must never take the process down or a repository offline.
    return {
      status: 500,
      body: `git server error: ${errorText(err)}`,
      headers: { 'Content-Type': 'text/plain' },
    };
  }
}

export default handleGit;
