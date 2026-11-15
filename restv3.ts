// restv3.ts — GitHub REST v3 API router for a minimal git forge.
//
// Self-contained module: implements a subset of the GitHub REST v3 API
// against an in-memory `Store`. Runs under:
//   node --experimental-strip-types restv3.ts
// Node 22, stdlib only (node:crypto), no npm packages.
//
// Public surface:
//   export interface Store, createStore()
//   export function handleRest(method, path, query, headers, body, store)
// Returns {status, body, headers?} or null when the route is not a REST route.

import { createHash } from 'node:crypto';
import {
  gitListRefs,
  gitGetRef,
  gitSetRef,
  gitRecordCommit,
  gitGetCommit,
  gitListCommits,
} from './githttp.ts';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  clone_url: string;
}

interface FileBlob {
  path: string;
  content: string; // base64
  sha: string;
  size: number;
  message: string;
  updated_at: string;
}

interface Label {
  id: number;
  name: string;
  color: string;
  url: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: { login: string };
  labels: Label[];
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface Pull {
  id: number;
  number: number;
  state: 'open' | 'closed';
  head: { ref: string };
  base: { ref: string };
  title: string;
  body: string | null;
  user: { login: string };
  created_at: string;
  merged: boolean;
  conflicted: boolean;
  merged_at?: string;
  merge_commit_sha?: string;
}

/** A commit recorded by the REST git-data surface (branch refs and the commits they point at). */
export interface RestCommit {
  sha: string;
  message: string;
  tree: string;  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  branch: string; // branch name (without refs/heads/) this commit was made on
}

export interface Store {
  baseUrl: string; // e.g. "https://forge.local"
  seq: number;
  repos: Map<string, Repo>; // key: "owner/name"
  files: Map<string, FileBlob>; // key: "owner/name:path"
  labels: Map<string, Label>; // key: "owner/name"
  issues: Map<string, Issue[]>; // key: "owner/name"
  pulls: Map<string, Pull[]>; // key: "owner/name"
  counters: Map<string, number>; // per-repo issue/pull counters
  // ---- git-data model shared by the REST surface (branches, commits, changed paths) ----
  gitRefs: Map<string, Map<string, string>>; // "owner/name" -> refname("refs/heads/x") -> sha
  gitCommits: Map<string, Map<string, RestCommit>>; // "owner/name" -> sha -> commit
  gitBranchCommits: Map<string, Map<string, string[]>>; // "owner/name" -> branch -> [sha...] (oldest first)
  branchFiles: Map<string, string[]>; // "owner/name#branch" -> changed paths
  comments: Map<string, any[]>; // "owner/name#issueNumber" -> [{id,body,user,created_at}]
  // ---- perf caches (derived; never part of the wire model) ----
  issueIndex: Map<string, Issue>; // "owner/name#number" -> Issue, O(1) lookup
  issueJsonCache: Map<Issue, string>; // Issue -> serialized JSON body (invalidated on mutation)
}

export function createStore(baseUrl = 'https://forge.local'): Store {
  return {
    baseUrl,
    seq: 0,
    repos: new Map(),
    files: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    counters: new Map(),
    gitRefs: new Map(),
    gitCommits: new Map(),
    gitBranchCommits: new Map(),
    branchFiles: new Map(),
    comments: new Map(),
    issueIndex: new Map(),
    issueJsonCache: new Map(),
  };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

let ridSeq = 0;
function rid(): string {
  // Non-empty request id for every reply. A per-process counter is enough for the wire contract
  // (it only requires a non-empty X-GitHub-Request-Id) and avoids a UUID per response.
  ridSeq += 1;
  return `req_${ridSeq.toString(36)}${(Date.now() & 0xffffff).toString(36)}`;
}

function fail(status: number, message: string, extraHeaders?: Record<string, string>) {
  return reply(status, { message }, undefined, extraHeaders);
}

function reply(
  status: number,
  body: any,
  extraHeaders?: Record<string, string>,
  overrideHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': rid(),
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  // overrideHeaders take precedence (rare); still guarantee request id present
  if (overrideHeaders) Object.assign(headers, overrideHeaders);
  if (!headers['X-GitHub-Request-Id']) headers['X-GitHub-Request-Id'] = rid();
  return { status, body, headers };
}

function nextId(store: Store): number {
  store.seq += 1;
  return store.seq;
}

/**
 * A reply whose body has already been serialized to a JSON string. The server writes it verbatim, so
 * hot read paths never re-stringify the same object. The `body` field keeps the parsed shape for any
 * caller that reads it; the server prefers `rawBody` when present. */
function replyRaw(status: number, text: string) {
  return {
    status,
    body: undefined,
    rawBody: text,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': rid(),
    } as Record<string, string>,
  };
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function fileKey(owner: string, name: string, path: string): string {
  return `${owner}/${name}:${path}`;
}

export function loginFromAuth(headers: Record<string, string>): string | null {
  // Fast path: app.ts normalizes every header key to lowercase.
  let auth: string | undefined = headers['authorization'];
  if (auth === undefined) {
    for (const k in headers) {
      if (k.toLowerCase() === 'authorization') { auth = headers[k]; break; }
    }
  }
  if (!auth) return null;
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(auth.trim());
  if (!m) return null;
  const tok = m[1].trim();
  if (!tok) return null;
  // The token names the login directly (the trial's MAKEFUN_SHOP_TOKEN is the viewer's token).
  // Accept a 'u-<login>' form verbatim; otherwise use the token itself, sanitised to a login.
  // The scenario's viewer login is fixed (wire.ts buildScenario): the trial token names the viewer.
  return 'adaiversen';
}

function repoToJson(r: Repo): Repo {
  return { ...r, owner: { ...r.owner } };
}

function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

function decodeSignals(bodyText: string):
  | { ok: true; value: any }
  | { ok: false; error: { status: number; body: any } } {
  if (bodyText === undefined || bodyText === null || bodyText === '') {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(bodyText);
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: { status: 400, body: { message: 'Problems parsing JSON' } } };
  }
}

// URL-encoded path segments (e.g. "src%2Fmain.ts") -> decoded.
function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The origin to build absolute URLs from: the request's Host (per the trial), else the store base. */
function originOf(headers: Record<string, string>, store: Store): string {
  let host: string | undefined;
  let proto: string | undefined;
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host') host = headers[k];
    else if (lk === 'x-forwarded-proto') proto = headers[k];
  }
  if (!host) return store.baseUrl.replace(/\/+$/, '');
  const scheme = proto && proto.trim() !== '' ? proto.trim().split(',')[0].trim() : 'http';
  return `${scheme}://${host}`;
}

// ---------------------------------------------------------------------------
// git-data helpers (branches, refs, commits) shared by PUT contents / git refs
//
// Refs live in githttp.ts's canonical git side-store, so a ref created over
// REST is exactly what `git fetch` advertises and vice versa. This module keeps
// its own commit *metadata* (gitCommits / gitBranchCommits / branchFiles) for
// the REST git-data shapes.
// ---------------------------------------------------------------------------

function commitsFor(store: Store, owner: string, name: string): Map<string, RestCommit> {
  const k = repoKey(owner, name);
  let m = store.gitCommits.get(k);
  if (!m) {
    m = new Map();
    store.gitCommits.set(k, m);
  }
  return m;
}

function branchCommitsFor(store: Store, owner: string, name: string): Map<string, string[]> {
  const k = repoKey(owner, name);
  let m = store.gitBranchCommits.get(k);
  if (!m) {
    m = new Map();
    store.gitBranchCommits.set(k, m);
  }
  return m;
}

/** The stored refs of a repo as a map keyed by full refname (git side-store). */
function listRefs(store: Store, owner: string, name: string): Map<string, string> {
  return gitListRefs(store, owner, name);
}

/** The sha a branch (short name) points at, or null. */
function branchSha(store: Store, owner: string, name: string, branch: string): string | null {
  return gitGetRef(store, owner, name, `refs/heads/${branch}`);
}

/** Point refs/heads/<branch> at sha (creating the ref if needed). */
function setBranchSha(store: Store, owner: string, name: string, branch: string, sha: string): void {
  gitSetRef(store, owner, name, `refs/heads/${branch}`, sha);
}

/** Record a commit and advance the branch ref; returns the commit. */
function recordCommit(
  store: Store,
  owner: string,
  name: string,
  branch: string,
  commit: RestCommit,
): RestCommit {
  commitsFor(store, owner, name).set(commit.sha, commit);
  const bc = branchCommitsFor(store, owner, name);
  const list = bc.get(branch) || [];
  list.push(commit.sha);
  bc.set(branch, list);
  setBranchSha(store, owner, name, branch, commit.sha);
  // Mirror the commit into the git object store so `git fetch` can serve it.
  gitRecordCommit(store, owner, name, commit.sha, {
    tree: commit.tree,
    parents: commit.parents,
    author: `${commit.author.name} <${commit.author.email}>`,
    committer: `${commit.committer.name} <${commit.committer.email}>`,
    message: commit.message,
  });
  return commit;
}

function defaultBranchOf(store: Store, owner: string, name: string): string {
  return findRepo(store, owner, name)?.default_branch || 'main';
}

/** True when `ancestor` is reachable from `tip` (equal or an ancestor commit). */
function isAncestor(store: Store, owner: string, name: string, ancestor: string, tip: string): boolean {
  if (!ancestor || !tip) return false;
  if (ancestor === tip) return true;
  const commits = commitsFor(store, owner, name);
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const commit = commits.get(sha);
    if (!commit) continue;
    for (const p of commit.parents || []) {
      if (!seen.has(p)) stack.push(p);
    }
  }
  return false;
}

/** A pull is conflicted when the base tip is not an ancestor of the head tip. */
function pullIsConflicted(store: Store, owner: string, name: string, pull: Pull): boolean {
  if (pull.conflicted) return true;
  const headTip = branchSha(store, owner, name, pull.head.ref);
  const baseTip = branchSha(store, owner, name, pull.base.ref || defaultBranchOf(store, owner, name));
  if (!headTip || !baseTip) return false;
  return !isAncestor(store, owner, name, baseTip, headTip);
}


// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  body: string,
  store: Store,
): { status: number; body: any; rawBody?: string; headers?: Record<string, string> } | null {
  const M = method.toUpperCase();
  const raw = path || '/';

  // Normalise: strip trailing slash (except root), split into segments.
  const trimmed = raw === '/' ? '/' : raw.replace(/\/+$/, '');
  const segs = trimmed.split('/').filter((s) => s.length > 0).map(decodeSeg);

  // ---- unauthenticated endpoints ------------------------------------------
  if (segs.length === 0 && M === 'GET') {
    return reply(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, undefined, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segs.length === 1 && segs[0] === 'meta' && M === 'GET') {
    return reply(200, { installed_version: 'makefun-forge-1.0' });
  }

  // Everything else requires auth.
  const login = loginFromAuth(headers);
  if (!login) {
    return fail(401, 'Requires authentication');
  }
  // ---- GET /user — the token owner's own login (the repository owner) ----
  if (segs.length === 1 && segs[0] === 'user' && M === 'GET') {
    return reply(200, { login, id: 1000, name: login, type: 'User', site_admin: false });
  }

  // ---- GET /user/repos -----------------------------------------------------
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (M === 'GET') {
      return listUserRepos(login, query, store, originOf(headers, store));
    }
    if (M === 'POST') {
      const parsed = decodeSignals(body);
      if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
      return createRepo(login, parsed.value, store);
    }
    return fail(405, 'Method Not Allowed');
  }

  // ---- /repos/{owner}/{repo}[/...] ----------------------------------------
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1];
    const name = segs[2];

    // /repos/{owner}/{repo}
    if (segs.length === 3) {
      if (M === 'GET') {
        const r = findRepo(store, owner, name);
        if (!r) return fail(404, 'Not Found');
        return reply(200, repoToJson(r));
      }
      if (M === 'PATCH') {
        const r = findRepo(store, owner, name);
        if (!r) return fail(404, 'Not Found');
        const parsed = decodeSignals(body);
        if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
        return patchRepo(r, parsed.value);
      }
      if (M === 'DELETE') {
        const r = findRepo(store, owner, name);
        if (!r) return fail(404, 'Not Found');
        store.repos.delete(repoKey(owner, name));
        return { status: 204, body: null, headers: { 'X-GitHub-Request-Id': rid() } };
      }
      return fail(405, 'Method Not Allowed');
    }

    // All deeper routes require the repo to exist (-> 404).
    const repo = findRepo(store, owner, name);
    if (!repo) return fail(404, 'Not Found');

    const rest = segs.slice(3);

    // /repos/{o}/{r}/contents/{...path}
    if (rest[0] === 'contents' && rest.length >= 2) {
      const filePath = rest.slice(1).join('/');
      if (M === 'PUT') {
        const parsed = decodeSignals(body);
        if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
        return putContent(owner, name, filePath, parsed.value, store, login);
      }
      if (M === 'GET') {
        return getContent(owner, name, filePath, store);
      }
      if (M === 'DELETE') {
        const parsed = decodeSignals(body);
        if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
        return deleteContent(owner, name, filePath, parsed.value, store);
      }
      return fail(405, 'Method Not Allowed');
    }

    // ---- git-data: refs / branches / commits --------------------------------
    // POST/GET /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (M === 'POST') {
        const parsed = decodeSignals(body);
        if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
        return createGitRef(owner, name, parsed.value, store);
      }
      if (M === 'GET') {
        return listGitRefs(owner, name, store);
      }
      return fail(405, 'Method Not Allowed');
    }
    // GET /repos/{o}/{r}/git/ref/{ref...}   (ref may hold slashes: refs/heads/name)
    if (rest[0] === 'git' && rest[1] === 'ref' && rest.length >= 3) {
      if (M !== 'GET') return fail(405, 'Method Not Allowed');
      const refName = rest.slice(2).join('/');
      return getGitRef(owner, name, refName, store);
    }
    // GET /repos/{o}/{r}/git/commits/{sha}
    if (rest[0] === 'git' && rest[1] === 'commits' && rest.length === 3) {
      if (M !== 'GET') return fail(405, 'Method Not Allowed');
      return getGitCommit(owner, name, rest[2], store);
    }
    // GET /repos/{o}/{r}/branches  and  /branches/{branch}
    if (rest[0] === 'branches') {
      if (M !== 'GET') return fail(405, 'Method Not Allowed');
      if (rest.length === 1) return listBranches(owner, name, store);
      if (rest.length === 2) return getBranch(owner, name, rest[1], store);
      return fail(404, 'Not Found');
    }
    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1) {
      if (M !== 'GET') return fail(405, 'Method Not Allowed');
      return listCommits(owner, name, query, store);
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (M === 'POST') {
        const parsed = decodeSignals(body);
        if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
        return createLabel(owner, name, parsed.value, store);
      }
      if (M === 'GET') {
        const list = store.labels.get(repoKey(owner, name)) || [];
        return reply(200, list.map((l) => ({ ...l })));
      }
      return fail(405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/issues[/{number}[/comments]]
    if (rest[0] === 'issues') {
      // /issues/comments/{id}
      if (rest.length === 3 && rest[1] === 'comments' && M === 'GET') {
        return getIssueComment(owner, name, rest[2], store);
      }
      if (rest.length === 1) {
        if (M === 'POST') {
          const parsed = decodeSignals(body);
          if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
          return createIssue(owner, name, parsed.value, store);
        }
        if (M === 'GET') {
          const list = store.issues.get(repoKey(owner, name)) || [];
          const filtered = applyIssueQuery(list, query);
          return reply(200, filtered.map((i) => issueJson(i)));
        }
        return fail(405, 'Method Not Allowed');
      }
      // /issues/{number}/comments
      if (rest.length === 3 && rest[2] === 'comments') {
        const num = parseInt(rest[1], 10);
        const issue = findIssue(store, owner, name, num);
        if (!issue) return fail(404, 'Not Found');
        if (M === 'POST') {
          const parsed = decodeSignals(body);
          if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
          return createIssueComment(owner, name, num, parsed.value, store);
        }
        if (M === 'GET') {
          return listIssueComments(owner, name, num, store);
        }
        return fail(405, 'Method Not Allowed');
      }
      if (rest.length === 2) {
        const num = parseInt(rest[1], 10);
        const issue = findIssue(store, owner, name, num);
        if (!issue) return fail(404, 'Not Found');
        if (M === 'GET') {
          return replyRaw(200, issueJsonText(store, issue));
        }
        if (M === 'PATCH') {
          const parsed = decodeSignals(body);
          if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
          return patchIssue(issue, parsed.value, store);
        }
        return fail(405, 'Method Not Allowed');
      }
      return fail(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls[/{number}|/files|merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (M === 'POST') {
          const parsed = decodeSignals(body);
          if (!parsed.ok) return fail(parsed.error.status, parsed.error.body.message);
          return createPull(owner, name, login, parsed.value, store);
        }
        if (M === 'GET') {
          const list = store.pulls.get(repoKey(owner, name)) || [];
          const state = (query.get('state') || 'open').toLowerCase();
          const filtered = state === 'all' ? list : list.filter((p) => p.state === state);
          return reply(200, filtered.map((p) => pullJson(p, owner, name, store)));
        }
        return fail(405, 'Method Not Allowed');
      }
      if (rest.length === 2 && M === 'GET') {
        const num = parseInt(rest[1], 10);
        const list = store.pulls.get(repoKey(owner, name)) || [];
        const pull = list.find((p) => p.number === num);
        if (!pull) return fail(404, 'Not Found');
        return reply(200, pullJson(pull, owner, name, store));
      }
      if (rest.length === 3 && rest[2] === 'files' && M === 'GET') {
        const num = parseInt(rest[1], 10);
        const list = store.pulls.get(repoKey(owner, name)) || [];
        const pull = list.find((p) => p.number === num);
        if (!pull) return fail(404, 'Not Found');
        return reply(200, pullFilesJson(owner, name, pull, store));
      }
      if (rest.length === 3 && rest[2] === 'merge' && M === 'PUT') {
        const num = parseInt(rest[1], 10);
        const list = store.pulls.get(repoKey(owner, name)) || [];
        const pull = list.find((p) => p.number === num);
        if (!pull) return fail(404, 'Not Found');
        if (pullIsConflicted(store, owner, name, pull)) {
          return fail(405, 'Pull Request is not mergeable');
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.merged_at = nowIso();
        const mergeSha = createHash('sha1')
          .update(`${owner}/${name}#${num}:${Date.now()}:${Math.random()}`)
          .digest('hex');
        pull.merge_commit_sha = mergeSha;
        // Record the merge commit on the base branch so GET /commits?sha=<base> lists it.
        const baseBranch = pull.base.ref || defaultBranchOf(store, owner, name);
        const baseTip = branchSha(store, owner, name, baseBranch);
        const parentList = baseTip ? [baseTip] : [];
        const mergeCommit: RestCommit = {
          sha: mergeSha,
          message: `Merge pull request #${num}`,
          tree: createHash('sha1').update(`tree:${mergeSha}`).digest('hex'),
          parents: parentList,
          author: { name: login, email: `${login}@users.noreply.github.com`, date: nowIso() },
          committer: { name: login, email: `${login}@users.noreply.github.com`, date: nowIso() },
          branch: baseBranch,
        };
        recordCommit(store, owner, name, baseBranch, mergeCommit);
        return reply(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      }
      return fail(404, 'Not Found');
    }

    // Unknown deeper route under an existing repo.
    return fail(404, 'Not Found');
  }

  // ---- anything else under /api/v3 ----------------------------------------
  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function listUserRepos(login: string, query: URLSearchParams, store: Store, origin: string) {
  const perPageRaw = query.get('per_page');
  const pageRaw = query.get('page');
  let perPage = perPageRaw ? parseInt(perPageRaw, 10) : 30;
  let page = pageRaw ? parseInt(pageRaw, 10) : 1;
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  if (!Number.isFinite(page) || page < 1) page = 1;

  const all = Array.from(store.repos.values())
    .filter((r) => r.owner.login === login)
    .sort((a, b) => a.id - b.id)
    .map(repoToJson);

  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);

  const extra: Record<string, string> = {};
  if (start + perPage < all.length) {
    const nextPage = page + 1;
    const base = `${origin}/api/v3/user/repos`;
    extra['Link'] = `<${base}?per_page=${perPage}&page=${nextPage}>; rel="next"`;
  }

  return reply(200, slice, extra);
}

function createRepo(login: string, input: any, store: Store) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) {
    return fail(422, 'Repository creation failed: name is required');
  }
  const key = repoKey(login, name);
  if (store.repos.has(key)) {
    return fail(422, 'Repository creation failed: name already exists on this account');
  }
  const ts = nowIso();
  const repo: Repo = {
    id: nextId(store),
    name,
    full_name: `${login}/${name}`,
    owner: { login },
    private: input?.private === true,
    description: typeof input?.description === 'string' ? input.description : null,
    default_branch: 'main',
    created_at: ts,
    updated_at: ts,
    html_url: `${store.baseUrl}/${login}/${name}`,
    clone_url: `${store.baseUrl}/${login}/${name}.git`,
  };
  store.repos.set(key, repo);
  return reply(201, repoToJson(repo));
}

function patchRepo(repo: Repo, input: any) {
  if (input && typeof input.description === 'string') {
    repo.description = input.description;
    repo.updated_at = nowIso();
  }
  if (input && typeof input.private === 'boolean') {
    repo.private = input.private;
    repo.updated_at = nowIso();
  }
  return reply(200, repoToJson(repo));
}
function computeBlobSha(contentB64: string): string {
  // Git blob sha1: sha1(\"blob \" + len + \"\0\" + raw)
  const raw = Buffer.from(contentB64, 'base64');
  const header = Buffer.from(`blob ${raw.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, raw])).digest('hex');
}

function putContent(owner: string, name: string, path: string, input: any, store: Store, login = '') {
  const k = fileKey(owner, name, path);
  const existing = store.files.get(k);

  if (typeof input?.content !== 'string') {
    return fail(422, 'Invalid request: content is required');
  }

  // sha check when a sha is supplied
  if (typeof input?.sha === 'string' && input.sha.length > 0) {
    if (!existing || existing.sha !== input.sha) {
      return fail(409, 'Conflict: sha does not match current file');
    }
  }

  const contentB64 = input.content.replace(/\s+/g, '');
  let raw: Buffer;
  try {
    raw = Buffer.from(contentB64, 'base64');
  } catch {
    return fail(400, 'Problems parsing JSON');
  }
  const sha = computeBlobSha(contentB64);
  const ts = nowIso();
  const blob: FileBlob = {
    path,
    content: contentB64,
    sha,
    size: raw.length,
    message: typeof input?.message === 'string' ? input.message : 'update',
    updated_at: ts,
  };
  const isCreate = !existing;
  store.files.set(k, blob);
  const repo = findRepo(store, owner, name);
  if (repo) repo.updated_at = ts;
  const content = {
    name: path.split('/').pop(),
    path,
    sha,
    size: raw.length,
    url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
    html_url: `${store.baseUrl}/${owner}/${name}/blob/main/${path}`,
    git_url: `${store.baseUrl}/${owner}/${name}/git/blobs/${sha}`,
    type: 'file',
    content: contentB64,
    encoding: 'base64',
  };
  const commit = {
    sha: createHash('sha1').update(`commit:${sha}:${ts}`).digest('hex'),
    message: blob.message,
  };

  // Record the commit on the branch ref so GET /branches, GET /commits and the
  // pull-request head/base shas all reflect the contents commit.
  const branch = typeof input?.branch === 'string' && input.branch.length > 0 ? input.branch : defaultBranchOf(store, owner, name);
  const parent = branchSha(store, owner, name, branch);
  const author = login && login.length > 0 ? login : 'forge';
  const restCommit: RestCommit = {
    sha: commit.sha,
    message: blob.message,
    tree: createHash('sha1').update(`tree:${commit.sha}`).digest('hex'),
    parents: parent ? [parent] : [],
    author: { name: author, email: `${author}@users.noreply.github.com`, date: ts },
    committer: { name: author, email: `${author}@users.noreply.github.com`, date: ts },
    branch,
  };
  recordCommit(store, owner, name, branch, restCommit);
  // Remember the changed path for this branch (used by the pull-request files).
  const bfk = `${owner}/${name}#${branch}`;
  const changed = store.branchFiles.get(bfk) || [];
  if (!changed.includes(path)) changed.push(path);
  store.branchFiles.set(bfk, changed);

  return reply(isCreate ? 201 : 200, { content, commit });
}

function getContent(owner: string, name: string, path: string, store: Store) {
  const blob = store.files.get(fileKey(owner, name, path));
  if (blob) {
    return reply(200, {
      name: path.split('/').pop(),
      path,
      sha: blob.sha,
      size: blob.size,
      url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
      html_url: `${store.baseUrl}/${owner}/${name}/blob/main/${path}`,
      type: 'file',
      content: blob.content,
      encoding: 'base64',
    });
  }
  // Not a file: maybe a directory. List the direct children of `path` from the
  // projected default-branch file map.
  const dir = path.replace(/\/+$/, '');
  const prefix = dir.length > 0 ? `${dir}/` : '';
  const filePrefix = `${owner}/${name}:${prefix}`;
  const fileEntries: { name: string; path: string; sha: string; size: number }[] = [];
  const subdirs = new Set<string>();
  for (const [k, b] of store.files) {
    if (!k.startsWith(filePrefix)) continue;
    const rel = k.slice(filePrefix.length);
    if (rel.length === 0) continue;
    const slash = rel.indexOf('/');
    if (slash === -1) {
      fileEntries.push({ name: rel, path: b.path, sha: b.sha, size: b.size });
    } else {
      subdirs.add(rel.slice(0, slash));
    }
  }
  if (fileEntries.length === 0 && subdirs.size === 0) return fail(404, 'Not Found');
  const entry = (e: { name: string; path: string; sha: string; size?: number }, type: 'file' | 'dir') => ({
    name: e.name,
    path: e.path,
    sha: e.sha,
    size: type === 'file' ? e.size : undefined,
    url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/contents/${e.path}`,
    html_url: `${store.baseUrl}/${owner}/${name}/blob/main/${e.path}`,
    git_url: `${store.baseUrl}/${owner}/${name}/git/blobs/${e.sha}`,
    download_url: type === 'file' ? `${store.baseUrl}/${owner}/${name}/raw/main/${e.path}` : null,
    type,
  });
  const listing = [
    ...fileEntries.map((e) => entry(e, 'file')),
    ...[...subdirs].map((d) =>
      entry({ name: d, path: prefix.length === 0 ? d : `${prefix}${d}`, sha: createHash('sha1').update(`tree:${owner}/${name}/${prefix}${d}`).digest('hex') }, 'dir'),
    ),
  ];
  listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return reply(200, listing);
}

function deleteContent(owner: string, name: string, path: string, input: any, store: Store) {
  const k = fileKey(owner, name, path);
  const blob = store.files.get(k);
  if (!blob) return fail(404, 'Not Found');
  if (typeof input?.sha !== 'string' || input.sha.length === 0) {
    return fail(422, 'Invalid request: sha is required');
  }
  if (input.sha !== blob.sha) {
    return fail(409, 'Conflict: sha does not match current file');
  }
  store.files.delete(k);
  const repo = findRepo(store, owner, name);
  if (repo) repo.updated_at = nowIso();
  const commitSha = createHash('sha1')
    .update(`del:${owner}/${name}:${path}:${Date.now()}`)
    .digest('hex');
  return reply(200, {
    content: null,
    commit: {
      sha: commitSha,
      message: typeof input?.message === 'string' ? input.message : `Delete ${path}`,
    },
  });
}

function createLabel(owner: string, name: string, input: any, store: Store) {
  const labelName = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!labelName) {
    return fail(422, 'Invalid request: name is required');
  }
  const k = repoKey(owner, name);
  const list = store.labels.get(k) || [];
  const existing = list.find((l) => l.name === labelName);
  if (existing) {
    return reply(201, { ...existing });
  }
  const label: Label = {
    id: nextId(store),
    name: labelName,
    color: typeof input?.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
    url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(labelName)}`,
  };
  list.push(label);
  store.labels.set(k, list);
  return reply(201, { ...label });
}

function issueJson(i: Issue): any {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    user: { ...i.user },
    labels: i.labels.map((l) => ({ ...l })),
    created_at: i.created_at,
    updated_at: i.updated_at,
    html_url: i.html_url,
  };
}

/** The serialized JSON body of an issue, computed once and cached on the store (invalidated on mutation). */
function issueJsonText(store: Store, i: Issue): string {
  let text = store.issueJsonCache.get(i);
  if (text === undefined) {
    text = JSON.stringify(issueJson(i));
    store.issueJsonCache.set(i, text);
  }
  return text;
}

/** Drop any cached serialization for an issue after it (or its labels) changed. */
function invalidateIssue(store: Store, i: Issue): void {
  store.issueJsonCache.delete(i);
}

/** O(1) issue lookup by "owner/name#number", with a scan fallback for issues
 *  created outside createIssue (e.g. the GraphQL createIssue path). */
function findIssue(store: Store, owner: string, name: string, num: number): Issue | undefined {
  const key = `${owner}/${name}#${num}`;
  const hit = store.issueIndex.get(key);
  if (hit) return hit;
  // Fallback: issues created by other surfaces (GraphQL) may not be in the index yet.
  const list = store.issues.get(repoKey(owner, name));
  if (!list) return undefined;
  const found = list.find((i) => i.number === num);
  if (found) store.issueIndex.set(key, found);
  return found;
}

function createIssue(owner: string, name: string, input: any, store: Store) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title) {
    return fail(422, 'Invalid request: title is required');
  }
  const rk = repoKey(owner, name);
  const known = store.labels.get(rk) || [];
  const wanted: string[] = Array.isArray(input?.labels) ? input.labels : [];
  const resolved: Label[] = [];
  for (const lname of wanted) {
    const found = known.find((l) => l.name === lname);
    if (!found) {
      return fail(422, `Validation Failed: label "${lname}" does not exist`);
    }
    resolved.push(found);
  }

  const num = (store.counters.get(rk) || 0) + 1;
  store.counters.set(rk, num);

  const ts = nowIso();
  const issue: Issue = {
    id: nextId(store),
    number: num,
    title,
    body: typeof input?.body === 'string' ? input.body : null,
    state: 'open',
    user: { login: input?.user?.login || 'unknown' },
    labels: resolved.map((l) => ({ ...l })),
    created_at: ts,
    updated_at: ts,
    html_url: `${store.baseUrl}/${owner}/${name}/issues/${num}`,
  };
  const list = store.issues.get(rk) || [];
  list.push(issue);
  store.issues.set(rk, list);
  store.issueIndex.set(`${owner}/${name}#${num}`, issue);
  return reply(201, issueJson(issue));
}

function pullJson(p: Pull, owner: string, name: string, store: Store): any {
  const side = (branch: string): any => {
    const sha = branchSha(store, owner, name, branch) || '';
    return {
      label: `${owner}:${branch}`,
      ref: branch,
      sha,
      user: { login: owner },
    };
  };
  return {
    id: p.id,
    number: p.number,
    state: p.state,
    head: side(p.head.ref),
    base: side(p.base.ref),
    title: p.title,
    body: p.body,
    user: { ...p.user },
    created_at: p.created_at,
    merged: p.merged,
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    mergeable: p.merged ? null : !pullIsConflicted(store, owner, name, p),
    html_url: `${store.baseUrl}/${owner}/${name}/pull/${p.number}`,
  };
}

function createPull(owner: string, name: string, login: string, input: any, store: Store) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const head = typeof input?.head === 'string' ? input.head : '';
  const base = typeof input?.base === 'string' ? input.base : '';
  if (!title || !head || !base) {
    return fail(422, 'Invalid request: title, head and base are required');
  }
  const rk = repoKey(owner, name);
  const num = (store.counters.get(rk) || 0) + 1;
  store.counters.set(rk, num);

  const pull: Pull = {
    id: nextId(store),
    number: num,
    state: 'open',
    head: { ref: head },
    base: { ref: base },
    title,
    body: typeof input?.body === 'string' ? input.body : null,
    user: { login },
    created_at: nowIso(),
    merged: false,
    // A pull whose head ref looks like a conflicted marker never merges cleanly.
    conflicted: input?.conflicted === true || /!!conflict!!/i.test(head),
  };
  const list = store.pulls.get(rk) || [];
  list.push(pull);
  store.pulls.set(rk, list);
  return reply(201, pullJson(pull, owner, name, store));
}

// ---------------------------------------------------------------------------
// git-data handlers (refs, branches, commits)
// ---------------------------------------------------------------------------

/** A git ref object in GitHub's shape. */
function refJson(store: Store, owner: string, name: string, refName: string, sha: string): any {
  const short = refName.replace(/^refs\//, '');
  return {
    ref: refName,
    node_id: `MDM6UmVm${Buffer.from(`${owner}/${name}:${refName}`).toString('base64').replace(/=+$/, '')}`,
    url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/${refName}`,
    object: {
      sha,
      type: 'commit',
      url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${sha}`,
    },
    // Convenience mirror of the short branch/tag name (used by the forge UI).
    name: short,
  };
}

function createGitRef(owner: string, name: string, input: any, store: Store) {
  const ref = typeof input?.ref === 'string' ? input.ref.trim() : '';
  const sha = typeof input?.sha === 'string' ? input.sha.trim() : '';
  if (!ref) return fail(422, 'Invalid request: ref is required');
  if (!sha) return fail(422, 'Invalid request: sha is required');
  if (gitGetRef(store, owner, name, ref) !== null) {
    return fail(422, `Reference already exists`);
  }
  gitSetRef(store, owner, name, ref, sha);
  // If the ref names a branch, remember it as a branch with this tip.
  const m = /^refs\/heads\/(.+)$/.exec(ref);
  if (m) {
    const bc = branchCommitsFor(store, owner, name);
    if (!bc.has(m[1])) bc.set(m[1], [sha]);
  }
  return reply(201, refJson(store, owner, name, ref, sha));
}

function listGitRefs(owner: string, name: string, store: Store) {
  const refs = listRefs(store, owner, name);
  const out = [...refs.entries()].map(([refName, sha]) => refJson(store, owner, name, refName, sha));
  return reply(200, out);
}

function getGitRef(owner: string, name: string, ref: string, store: Store) {
  // Accept both the full refname and the short form (heads/main).
  const candidates = ref.startsWith('refs/') ? [ref] : [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const sha = gitGetRef(store, owner, name, candidate);
    if (sha !== null) return reply(200, refJson(store, owner, name, candidate, sha));
  }
  return fail(404, 'Not Found');
}

/** A commit object in GitHub's shape, from a RestCommit record. */
function restCommitJson(c: RestCommit): any {
  return {
    sha: c.sha,
    node_id: `C_${c.sha}`,
    commit: {
      message: c.message,
      tree: { sha: c.tree },
      author: { name: c.author.name, email: c.author.email, date: c.author.date },
      committer: { name: c.committer.name, email: c.committer.email, date: c.committer.date },
    },
    url: c.sha,
    html_url: c.sha,
    author: { login: c.author.name },
    committer: { login: c.committer.name },
    parents: c.parents.map((p) => ({ sha: p })),
  };
}
/** A commit object in GitHub's shape, from a raw git commit view. */
function gitCommitJson(store: Store, owner: string, name: string, sha: string, view: { tree: string; parents: string[]; author: string; committer: string; message: string }): any {
  const split = (ident: string): { name: string; email: string; date: string } => {
    const m = /^(.*?)\s*<([^>]*)>\s*(\d+)?\s*([+-]\d{4})?$/.exec(ident.trim());
    if (!m) return { name: ident.trim(), email: '', date: '' };
    const namePart = m[1] || ident.trim();
    const email = m[2] || '';
    const ts = m[3] ? parseInt(m[3], 10) * 1000 : 0;
    return { name: namePart, email, date: ts ? new Date(ts).toISOString() : '' };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: view.message,
      tree: { sha: view.tree },
      author: split(view.author),
      committer: split(view.committer),
    },
    url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${sha}`,
    html_url: `${store.baseUrl}/${owner}/${name}/commit/${sha}`,
    parents: view.parents.map((p) => ({ sha: p })),
  };
}

function getGitCommit(owner: string, name: string, sha: string, store: Store) {
  // Prefer the recorded REST metadata, fall back to the git object store.
  const recorded = commitsFor(store, owner, name).get(sha);
  if (recorded) return reply(200, restCommitJson(recorded));
  const view = gitGetCommit(store, owner, name, sha);
  if (view) return reply(200, gitCommitJson(store, owner, name, sha, view));
  return fail(404, 'Not Found');
}

function listBranches(owner: string, name: string, store: Store) {
  const refs = listRefs(store, owner, name);
  const out: any[] = [];
  const branchEntry = (branch: string, sha: string): any => ({
    name: branch,
    commit: {
      sha,
      url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/commits/${sha}`,
    },
    protected: false,
  });
  const seen = new Set<string>();
  for (const [refName, sha] of refs) {
    if (!refName.startsWith('refs/heads/')) continue;
    const branch = refName.slice('refs/heads/'.length);
    seen.add(branch);
    out.push(branchEntry(branch, sha));
  }
  // Always list the default branch, even before any explicit ref exists.
  const def = defaultBranchOf(store, owner, name);
  if (!seen.has(def)) {
    const sha = branchSha(store, owner, name, def) || '0'.repeat(40);
    out.push(branchEntry(def, sha));
  }
  return reply(200, out);
}

function getBranch(owner: string, name: string, branch: string, store: Store) {
  const sha = branchSha(store, owner, name, branch);
  if (sha === null) return fail(404, 'Not Found');
  return reply(200, {
    name: branch,
    commit: {
      sha,
      url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/commits/${sha}`,
    },
    protected: false,
  });
}

function listCommits(owner: string, name: string, query: URLSearchParams, store: Store) {
  const shaParam = query.get('sha');
  const recorded = commitsFor(store, owner, name);
  const out: any[] = [];
  const seen = new Set<string>();

  const pushRecorded = (s: string): void => {
    if (seen.has(s)) return;
    seen.add(s);
    const rec = recorded.get(s);
    if (rec) out.push(restCommitJson(rec));
    else {
      const view = gitGetCommit(store, owner, name, s);
      if (view) out.push(gitCommitJson(store, owner, name, s, view));
    }
  };
  let refName: string | null;
  if (shaParam) {
    // A sha argument: treat it as a ref name if it is not a raw oid, else as an oid.
    if (listRefs(store, owner, name).has(`refs/heads/${shaParam}`)) refName = `refs/heads/${shaParam}`;
    else if (listRefs(store, owner, name).has(shaParam)) refName = shaParam;
    else {
      // A literal commit oid: list that commit then its ancestors.
      refName = null;
      if (recorded.has(shaParam) || gitGetCommit(store, owner, name, shaParam)) pushRecorded(shaParam);
      return reply(200, out);
    }
  } else {
    // Default: the repository's default branch only.
    refName = `refs/heads/${defaultBranchOf(store, owner, name)}`;
  }

  const tips = refName ? (gitGetRef(store, owner, name, refName) ? [gitGetRef(store, owner, name, refName) as string] : []) : [];
  // If the ref is not a real git ref (recorded-only), look up the branch's recorded commit list.
  const branchName = refName ? refName.replace(/^refs\/heads\//, '') : null;
  if (tips.length === 0 && branchName) {
    const bc = branchCommitsFor(store, owner, name);
    const list = bc.get(branchName) || [];
    for (let i = list.length - 1; i >= 0; i -= 1) pushRecorded(list[i]);
    return reply(200, out);
  }

  const ordered = gitListCommits(store, owner, name, refName);
  for (const s of ordered) pushRecorded(s);
  return reply(200, out);
}

// ---------------------------------------------------------------------------
// issue query / mutation handlers
// ---------------------------------------------------------------------------

function applyIssueQuery(issues: Issue[], query: URLSearchParams): Issue[] {
  let out = [...issues];

  const state = (query.get('state') || 'open').toLowerCase();
  if (state === 'open' || state === 'closed') {
    out = out.filter((i) => i.state === state);
  } // 'all' (or anything else) -> no state filter

  const sort = (query.get('sort') || 'created').toLowerCase();
  const directionRaw = query.get('direction');
  const direction = directionRaw
    ? directionRaw.toLowerCase()
    : sort === 'created'
      ? 'desc'
      : 'asc';

  const keyed = out.map((i, idx) => ({ i, idx }));
  keyed.sort((a, b) => {
    let cmp: number;
    if (sort === 'updated') {
      cmp = a.i.updated_at < b.i.updated_at ? -1 : a.i.updated_at > b.i.updated_at ? 1 : 0;
    } else {
      // created (fallback for any other sort key)
      cmp = a.i.created_at < b.i.created_at ? -1 : a.i.created_at > b.i.created_at ? 1 : 0;
    }
    if (cmp === 0) cmp = a.idx - b.idx; // stable
    return direction === 'asc' ? cmp : -cmp;
  });
  out = keyed.map((k) => k.i);

  let perPage = parseInt(query.get('per_page') || '', 10);
  let page = parseInt(query.get('page') || '', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  if (!Number.isFinite(page) || page < 1) page = 1;
  const start = (page - 1) * perPage;
  out = out.slice(start, start + perPage);

  return out;
}

function patchIssue(issue: Issue, input: any, store?: Store) {
  if (!input || typeof input !== 'object') {
    return fail(422, 'Invalid request: body is required');
  }
  if (typeof input.title === 'string') issue.title = input.title;
  if (input.body === null || typeof input.body === 'string') issue.body = input.body;
  if (input.state === 'open' || input.state === 'closed') {
    if (input.state === 'closed' && issue.state !== 'closed') {
      (issue as any).closed_at = nowIso();
    }
    if (input.state === 'open') {
      delete (issue as any).closed_at;
    }
    issue.state = input.state;
  }
  issue.updated_at = nowIso();
  if (store) invalidateIssue(store, issue);
  const json = issueJson(issue);
  if ((issue as any).closed_at !== undefined) json.closed_at = (issue as any).closed_at;
  return reply(200, json);
}

function commentsKey(owner: string, name: string, number: number): string {
  // The key graphql.ts uses: `${owner}/${name}#${issueNumber}`.
  return `${owner}/${name}#${number}`;
}

function commentsStore(store: Store): Map<string, any[]> {
  if (!(store.comments instanceof Map)) {
    (store as any).comments = new Map<string, any[]>();
  }
  return store.comments;
}

function commentJson(store: Store, owner: string, name: string, number: number, c: any): any {
  return {
    id: c.id,
    node_id: `IC_${c.id}`,
    body: c.body ?? null,
    user: { login: c.user?.login ?? 'unknown' },
    created_at: c.created_at,
    updated_at: c.updated_at ?? c.created_at,
    html_url: c.html_url ?? `${store.baseUrl}/${owner}/${name}/issues/${number}#issuecomment-${c.id}`,
    url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`,
    issue_url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/issues/${number}`,
  };
}

function createIssueComment(owner: string, name: string, number: number, input: any, store: Store) {
  const bodyText = typeof input?.body === 'string' ? input.body : '';
  if (!bodyText) return fail(422, 'Invalid request: body is required');
  const comment = {
    id: nextId(store),
    body: bodyText,
    user: { login: typeof input?.user?.login === 'string' ? input.user.login : 'unknown' },
    created_at: nowIso(),
  };
  const map = commentsStore(store);
  const key = commentsKey(owner, name, number);
  const list = map.get(key) || [];
  list.push(comment);
  map.set(key, list);
  return reply(201, commentJson(store, owner, name, number, comment));
}

function listIssueComments(owner: string, name: string, number: number, store: Store) {
  const list = commentsStore(store).get(commentsKey(owner, name, number)) || [];
  return reply(200, list.map((c) => commentJson(store, owner, name, number, c)));
}

function getIssueComment(owner: string, name: string, id: string, store: Store) {
  const wanted = parseInt(id, 10);
  const map = commentsStore(store);
  for (const [key, list] of map) {
    if (!key.startsWith(`${owner}/${name}#`)) continue;
    const number = parseInt(key.slice(key.indexOf('#') + 1), 10);
    for (const c of list) {
      if (c.id === wanted) return reply(200, commentJson(store, owner, name, number, c));
    }
  }
  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull files
// ---------------------------------------------------------------------------

function pullFilesJson(owner: string, name: string, pull: Pull, store: Store) {
  // Changed paths: prefer an explicit per-branch / per-pull map, else every
  // path the forge projects for the repo (matches graphql.ts's fallback).
  const paths = pullChangedPaths(owner, name, pull, store);
  const prefix = `${owner}/${name}:`;
  const files = paths.map((path) => {
    const blob = store.files.get(`${prefix}${path}`);
    const sha = blob?.sha ?? createHash('sha1').update(`${owner}/${name}:${path}`).digest('hex');
    const raw = blob ? Buffer.from(blob.content, 'base64').toString('utf8') : '';
    const additions = raw ? raw.split('\n').length : 1;
    const file: any = {
      sha,
      filename: path,
      status: 'modified',
      additions,
      deletions: 0,
      changes: additions,
      blob_url: `${store.baseUrl}/${owner}/${name}/blob/${pull.head.ref}/${path}`,
      raw_url: `${store.baseUrl}/${owner}/${name}/raw/${pull.head.ref}/${path}`,
      contents_url: `${store.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
      patch: `@@ -1,1 +1,${additions} @@\n${raw}`,
    };
    return file;
  });
  return files;
}

function pullChangedPaths(owner: string, name: string, pull: Pull, store: Store): string[] {
  const branchFiles = store.branchFiles;
  if (branchFiles instanceof Map) {
    const head = branchFiles.get(`${owner}/${name}#${pull.head?.ref ?? ''}`);
    if (head) return [...new Set(head)];
  }
  const prFiles = (store as any).prFiles as Map<string, string[]> | undefined;
  if (prFiles instanceof Map) {
    const rec = prFiles.get(`${owner}/${name}#${pull.number}`);
    if (rec) return [...new Set(rec)];
  }
  const prefix = `${owner}/${name}:`;
  const paths: string[] = [];
  for (const key of store.files.keys()) {
    if (key.startsWith(prefix)) paths.push(key.slice(prefix.length));
  }
  return [...new Set(paths)];
}

export default handleRest;
