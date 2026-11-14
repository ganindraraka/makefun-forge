// graphql.ts — a minimal, hand-rolled GitHub GraphQL v4 endpoint for the make.fun forge.
//
// No npm GraphQL library, no schema generator: a small tokenizer, a recursive-descent
// parser for the subset of GraphQL documents `gh` and `github-mcp-server` actually send,
// and an executor that resolves selections against the REST `Store`.
//
// Runs under:  node --experimental-strip-types graphql.ts
// Node 22, standard library only, no dependencies.
//
// Public surface:
//   export function handleGraphQL(headers, body, store) -> {status, body, headers?}
//
// The wire it speaks (see kit-sdk/conformance/graphql-client.ts):
//   POST /api/graphql  with  {"query": "...", "variables": {...}}
//   Authorization: Bearer <token>   (a request without it is exactly HTTP 401)
//   answered with {"data": {...}} and, on a GraphQL-level failure, {"errors": [...]} at HTTP 200.
//   A JSON array of operation documents in one body is GitHub's operation batching: the
//   response is an array of per-operation envelopes, in the same order.
//
// The schema slice it implements is exactly the one checks-graphql.ts exercises:
//   Query.viewer{login}, Query.repository(owner:, name:), Query.node(id:),
//   Query.__type(name:){fields(includeDeprecated:), enumValues(includeDeprecated:)},
//   Repository{id, databaseId, name, nameWithOwner, owner{login}, defaultBranchRef{name},
//              viewerPermission, hasIssuesEnabled, issue(number:), issues(first:, states:,
//              orderBy:, after:), pullRequests(first:), pullRequest(number:)},
//   Issue{id, number, title, state, body},
//   PullRequest{id, number, state, merged, headRefName, baseRefName, mergeable, files(first:)},
//   the connections IssueConnection/PullRequestConnection/PullRequestChangedFileConnection
//   with nodes + pageInfo{hasNextPage, endCursor}, and the mutations createIssue, closeIssue,
//   createPullRequest, mergePullRequest and addComment.
//
// Data-model notes:
//   - Issues and pull requests live in the REST store; this module reads and writes the SAME
//     records, so a mutation here is visible to a later REST read and vice versa. REST keeps
//     lower-case states ('open'/'closed'); GraphQL exposes the upper-case enum values.
//   - Global ids are opaque base64 Relay ids ("<Type>:<numeric-id>"); they are stable across
//     reads and never equal to the plain numeric id, so node(id:) round-trips.
//   - Comments written by addComment are stored on the store under a documented key so the
//     REST comment route the entry adds can list them (see COMMENT_STORE_KEY below).

import { createHash } from 'node:crypto';
import { loginFromAuth, type Store } from './restv3.ts';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

interface GqlResult {
  status: number;
  body: any;
  headers?: Record<string, string>;
}

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
};

function reply(status: number, body: any): GqlResult {
  return { status, body, headers: { ...JSON_HEADERS } };
}

/** A GraphQL-level failure: HTTP 200 with an `errors` array, exactly as the wire expects. */
function errorsReply(errors: Array<{ message: string; path?: (string | number)[] }>): GqlResult {
  return reply(200, { data: null, errors });
}

/** The single HTTP-401 answer an unauthenticated request gets (no data, no errors). */
function unauthenticated(): GqlResult {
  return reply(401, { message: 'Requires authentication' });
}

// ---------------------------------------------------------------------------
// Auth — reuse the REST module's token->login derivation so both surfaces agree
// on the token owner's login. `loginFromAuth` is imported from './restv3.ts'.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind =
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | 'punct'
  | 'spread'
  | 'eof';

interface Token {
  kind: TokKind;
  value: string;
  line: number;
  col: number;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const advance = (count = 1): void => {
    for (let k = 0; k < count; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < n) {
    const ch = source[i];

    // whitespace / commas (ignored) / comments
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',' || ch === '\ufeff') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') advance();
      continue;
    }

    // spread operator "..."
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...', line, col });
      advance(3);
      continue;
    }

    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, line, col });
      advance();
      continue;
    }

    // string literals (single or double quoted; block strings """""" not needed here)
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance();
      let value = '';
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          switch (esc) {
            case '"': value += '"'; break;
            case '\\': value += '\\'; break;
            case '/': value += '/'; break;
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            case 'b': value += '\b'; break;
            case 'f': value += '\f'; break;
            case 'u': {
              const hex = source.slice(i + 2, i + 6);
              value += String.fromCharCode(parseInt(hex, 16) || 0);
              advance(4);
              break;
            }
            default: value += esc ?? ''; break;
          }
          advance(2);
          continue;
        }
        value += source[i];
        advance();
      }
      advance(); // closing quote
      tokens.push({ kind: 'string', value, line: startLine, col: startCol });
      continue;
    }

    // numbers
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let value = '';
      if (ch === '-') {
        value += '-';
        advance();
      }
      let isFloat = false;
      while (i < n && /[0-9]/.test(source[i])) {
        value += source[i];
        advance();
      }
      if (source[i] === '.') {
        isFloat = true;
        value += '.';
        advance();
        while (i < n && /[0-9]/.test(source[i])) {
          value += source[i];
          advance();
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        value += source[i];
        advance();
        if (source[i] === '+' || source[i] === '-') {
          value += source[i];
          advance();
        }
        while (i < n && /[0-9]/.test(source[i])) {
          value += source[i];
          advance();
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value, line, col });
      continue;
    }

    // names
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (i < n && /[_0-9A-Za-z]/.test(source[i])) {
        value += source[i];
        advance();
      }
      tokens.push({ kind: 'name', value, line, col });
      continue;
    }

    // Unknown character: skip it rather than throwing — a document with gunk still answers.
    advance();
  }

  tokens.push({ kind: 'eof', value: '', line, col });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface ArgumentNode {
  name: string;
  value: GqlValue;
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, GqlValue>;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'inline-fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Map<string, string>; // name -> type text (unused for coercion, kept for context)
  selections: SelectionNode[];
}

interface ParseError {
  message: string;
}

type ParseOutcome = { ok: true; operation: OperationNode } | { ok: false; error: ParseError };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const t = this.tokens[this.pos] as Token;
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  private at(kind: TokKind, value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  private expect(kind: TokKind, value?: string): Token {
    const t = this.peek();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      const want = value !== undefined ? `${kind} '${value}'` : kind;
      throw new Error(`Expected ${want} but found ${t.kind === 'eof' ? 'end of document' : `'${t.value}'`}`);
    }
    return this.next();
  }

  parseDocument(): OperationNode {
    const op = this.peek();
    if (op.kind === 'punct' && op.value === '{') {
      // anonymous query shorthand
      const selections = this.parseSelectionSet();
      return { operation: 'query', variables: new Map(), selections };
    }
    const keyword = this.expect('name').value;
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`Unknown operation type '${keyword}'`);
    }
    const operation = keyword as 'query' | 'mutation' | 'subscription';
    let name: string | undefined;
    if (this.at('name')) name = this.next().value;
    const variables = new Map<string, string>();
    if (this.at('punct', '(')) {
      this.next();
      while (!this.at('punct', ')') && !this.at('eof')) {
        const varName = this.expect('punct', '$').value === '$' ? this.expect('name').value : this.next().value;
        this.expect('punct', ':');
        const typeText = this.parseTypeText();
        variables.set(varName, typeText);
      }
      this.expect('punct', ')');
    }
    // skip directives on the operation
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  private parseTypeText(): string {
    let text = '';
    if (this.at('punct', '[')) {
      this.next();
      text += `[${this.parseTypeText()}]`;
      this.expect('punct', ']');
    } else {
      text += this.expect('name').value;
    }
    if (this.at('punct', '!')) {
      this.next();
      text += '!';
    }
    return text;
  }

  private skipDirectives(): void {
    while (this.at('punct', '@')) {
      this.next();
      this.expect('name');
      if (this.at('punct', '(')) this.skipParenBalanced();
    }
  }

  private skipParenBalanced(): void {
    this.expect('punct', '(');
    let depth = 1;
    while (depth > 0 && !this.at('eof')) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const selections: SelectionNode[] = [];
    while (!this.at('punct', '}') && !this.at('eof')) {
      selections.push(this.parseSelection());
    }
    this.expect('punct', '}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.at('spread')) {
      this.next();
      // "... on Type { ... }" — an inline fragment. A bare spread of a named fragment is
      // tolerated and treated as an empty inline fragment (no named fragments are sent).
      let typeCondition: string | undefined;
      if (this.at('name') && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expect('name').value;
      }
      this.skipDirectives();
      const selections = this.at('punct', '{') ? this.parseSelectionSet() : [];
      return { kind: 'inline-fragment', typeCondition, selections };
    }

    let alias: string | undefined;
    let name = this.expect('name').value;
    if (this.at('punct', ':')) {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    const args = new Map<string, GqlValue>();
    if (this.at('punct', '(')) {
      this.next();
      while (!this.at('punct', ')') && !this.at('eof')) {
        const argName = this.expect('name').value;
        this.expect('punct', ':');
        const value = this.parseValue();
        args.set(argName, value);
      }
      this.expect('punct', ')');
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.at('punct', '{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      return { kind: 'var', name: this.expect('name').value };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number.parseInt(t.value, 10) };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number.parseFloat(t.value) };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const values: GqlValue[] = [];
      while (!this.at('punct', ']') && !this.at('eof')) values.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields = new Map<string, GqlValue>();
      while (!this.at('punct', '}') && !this.at('eof')) {
        const key = this.expect('name').value;
        this.expect('punct', ':');
        fields.set(key, this.parseValue());
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    // Unexpected: consume and answer null.
    this.next();
    return { kind: 'null' };
  }
}

function parseDocument(source: string): ParseOutcome {
  try {
    const parser = new Parser(source);
    const operation = parser.parseDocument();
    return { ok: true, operation };
  } catch (err) {
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

// ---------------------------------------------------------------------------
// Value / argument evaluation
// ---------------------------------------------------------------------------

type ResolvedValue =
  | null
  | boolean
  | number
  | string
  | ResolvedValue[]
  | { [key: string]: ResolvedValue }
  | undefined;

/** A sentinel that distinguishes "an enum value" (a bare word like OPEN) from a string. */
class EnumValue {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

function evalValue(value: GqlValue, variables: Record<string, unknown>): ResolvedValue | EnumValue | EnumValue[] {
  switch (value.kind) {
    case 'var': {
      if (!(value.name in variables)) return null;
      return variables[value.name] as ResolvedValue;
    }
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return new EnumValue(value.value);
    case 'list':
      return value.values.map((v) => {
        const r = evalValue(v, variables);
        return r instanceof EnumValue ? r : (r as ResolvedValue);
      }) as EnumValue[];
    case 'object': {
      const out: { [k: string]: ResolvedValue } = {};
      for (const [k, v] of value.fields) out[k] = evalValue(v, variables) as ResolvedValue;
      return out;
    }
    default:
      return null;
  }
}

/** Coerce a resolved value to a plain string (for id/owner/name-typed arguments). */
function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

/** Coerce to an integer, or null. */
function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

/** Coerce an enum-or-string argument to its bare name. */
function asEnumName(v: unknown): string | null {
  if (v instanceof EnumValue) return v.name;
  if (typeof v === 'string') return v;
  return null;
}

function enumNames(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(asEnumName).filter((x): x is string => x !== null);
  const single = asEnumName(v);
  return single === null ? [] : [single];
}

// ---------------------------------------------------------------------------
// Global (Relay) ids
// ---------------------------------------------------------------------------

function encodeGlobalId(typeName: string, id: number): string {
  return Buffer.from(`${typeName}:${id}`, 'utf8').toString('base64');
}

interface DecodedGlobalId {
  typeName: string;
  id: number;
}

function decodeGlobalId(value: string): DecodedGlobalId | null {
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = text.lastIndexOf(':');
  if (idx <= 0) return null;
  const typeName = text.slice(0, idx);
  const id = Number.parseInt(text.slice(idx + 1), 10);
  if (!Number.isFinite(id)) return null;
  return { typeName, id };
}

// ---------------------------------------------------------------------------
// Store accessors (shape mirrors restv3.ts)
// ---------------------------------------------------------------------------

interface GqlIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: { login: string };
  labels: unknown[];
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GqlPull {
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
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(store: Store, owner: string, name: string): any | undefined {
  return store.repos.get(repoKey(owner, name));
}

function getIssues(store: Store, owner: string, name: string): GqlIssue[] {
  return (store.issues.get(repoKey(owner, name)) as GqlIssue[] | undefined) ?? [];
}

function getPulls(store: Store, owner: string, name: string): GqlPull[] {
  return (store.pulls.get(repoKey(owner, name)) as GqlPull[] | undefined) ?? [];
}

function nextStoreId(store: Store): number {
  (store as any).seq = ((store as any).seq ?? 0) + 1;
  return (store as any).seq as number;
}

/**
 * The comments map written by addComment and read back by the REST comment route the entry adds.
 * Key: `${owner}/${name}#${issueNumber}`. The value is an array of { id, body, created_at, user }.
 * It lives on the store under this property so both surfaces share one source of truth.
 */
const COMMENT_STORE_KEY = 'comments';

function commentsMap(store: Store): Map<string, any[]> {
  const anyStore = store as any;
  if (!(anyStore[COMMENT_STORE_KEY] instanceof Map)) {
    anyStore[COMMENT_STORE_KEY] = new Map<string, any[]>();
  }
  return anyStore[COMMENT_STORE_KEY] as Map<string, any[]>;
}

function commentsKey(owner: string, name: string, issueNumber: number): string {
  return `${owner}/${name}#${issueNumber}`;
}

function addCommentRecord(store: Store, owner: string, name: string, issueNumber: number, body: string, login: string): any {
  const comment = {
    id: nextStoreId(store),
    body,
    user: { login },
    created_at: new Date().toISOString(),
  };
  const map = commentsMap(store);
  const key = commentsKey(owner, name, issueNumber);
  const list = map.get(key) ?? [];
  list.push(comment);
  map.set(key, list);
  return comment;
}

/** Find (owner, name, issue) by the issue's numeric store id, scanning every repository. */
function findIssueById(store: Store, id: number): { owner: string; name: string; issue: GqlIssue } | null {
  for (const [key, list] of store.issues) {
    for (const issue of list as GqlIssue[]) {
      if (issue.id === id) {
        const [owner, name] = key.split('/');
        return { owner, name, issue };
      }
    }
  }
  return null;
}

function findPullById(store: Store, id: number): { owner: string; name: string; pull: GqlPull } | null {
  for (const [key, list] of store.pulls) {
    for (const pull of list as GqlPull[]) {
      if (pull.id === id) {
        const [owner, name] = key.split('/');
        return { owner, name, pull };
      }
    }
  }
  return null;
}

function findRepoById(store: Store, id: number): { owner: string; name: string; repo: any } | null {
  for (const [key, repo] of store.repos) {
    if (repo.id === id) {
      const [owner, name] = key.split('/');
      return { owner, name, repo };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Introspection schema
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'INPUT_OBJECT' | 'SCALAR' | 'UNION';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', '__type', '__schema'],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title',
    ],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },

  // Enums
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'] },

  // Input objects (shape is descriptive only)
  CreateIssueInput: { kind: 'INPUT_OBJECT', fields: ['repositoryId', 'title', 'body'] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', fields: ['issueId', 'stateReason'] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', fields: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body'] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', fields: ['pullRequestId', 'mergeMethod'] },
  AddCommentInput: { kind: 'INPUT_OBJECT', fields: ['subjectId', 'body'] },

  // Scalars
  ID: { kind: 'SCALAR' },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  viewer: string;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: (string | number)[] }>;
}

/** A resolved object plus its GraphQL type name, so field lookup and inline fragments work. */
interface TypedValue {
  __typename: string;
  [key: string]: any;
}

function isTyped(v: unknown): v is TypedValue {
  return v !== null && typeof v === 'object' && typeof (v as any).__typename === 'string';
}

/**
 * Resolve one field on a typed parent. Returns the raw value (object without selection applied)
 * or a plain scalar. Unknown fields push an error and resolve to undefined (rendered as null).
 */
function resolveField(
  ctx: ExecContext,
  parent: TypedValue,
  field: FieldNode,
  path: (string | number)[],
): any {
  const typename = parent.__typename;
  const name = field.name;

  const own = parent[name];
  if (own === undefined && !(name in parent)) {
    // The field is not a resolver we know for this parent type.
    ctx.errors.push({
      message: `Cannot query field "${name}" on type "${typename}".`,
      path: [...path, field.alias ?? name],
    });
    return undefined;
  }
  if (typeof own === 'function') {
    return own(field.args, ctx);
  }
  return own;
}

/** Apply a selection set to a resolved value, producing the JSON the client receives. */
function completeValue(
  ctx: ExecContext,
  value: any,
  selections: SelectionNode[],
  path: (string | number)[],
): any {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      isTyped(entry) ? completeObject(ctx, entry, selections, [...path, index]) : entry,
    );
  }

  if (isTyped(value)) {
    return completeObject(ctx, value, selections, path);
  }

  // A scalar (or a plain object that already has no selections).
  if (typeof value === 'object') {
    // A bare object without a typename: apply any selections defensively.
    const out: Record<string, any> = {};
    for (const sel of selections) {
      if (sel.kind === 'field' && sel.name in value) {
        out[sel.alias ?? sel.name] = (value as any)[sel.name];
      }
    }
    return out;
  }
  return value;
}

function completeObject(
  ctx: ExecContext,
  obj: TypedValue,
  selections: SelectionNode[],
  path: (string | number)[],
): any {
  const out: Record<string, any> = {};
  const apply = (sels: SelectionNode[]): void => {
    for (const sel of sels) {
      if (sel.kind === 'inline-fragment') {
        if (sel.typeCondition === undefined || sel.typeCondition === obj.__typename) {
          apply(sel.selections);
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      const keyPath = [...path, key];
      const raw = resolveField(ctx, obj, sel, path);
      if (raw === undefined) {
        out[key] = null;
        continue;
      }
      out[key] = sel.selections.length > 0 ? completeValue(ctx, raw, sel.selections, keyPath) : raw;
    }
  };
  apply(selections);
  return out;
}

// ---------------------------------------------------------------------------
// Value builders
// ---------------------------------------------------------------------------

function userValue(login: string): TypedValue {
  return {
    __typename: 'User',
    id: encodeGlobalId('User', hashLogin(login)),
    login,
  };
}

function hashLogin(login: string): number {
  const h = createHash('sha1').update(login).digest('hex').slice(0, 12);
  return Number.parseInt(h, 16) % 2_000_000_000;
}

function refValue(name: string): TypedValue {
  return { __typename: 'Ref', id: encodeGlobalId('Ref', hashLogin(name)), name };
}

function issueValue(issue: GqlIssue): TypedValue {
  return {
    __typename: 'Issue',
    id: encodeGlobalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
    author: userValue(issue.user?.login ?? 'unknown'),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    __raw: issue,
  };
}

function pullStateOf(pull: GqlPull): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  if (pull.state === 'closed') return 'CLOSED';
  return 'OPEN';
}

function pullValue(pull: GqlPull, owner: string, name: string): TypedValue {
  return {
    __typename: 'PullRequest',
    id: encodeGlobalId('PullRequest', pull.id),
    number: pull.number,
    state: pullStateOf(pull),
    merged: pull.merged === true,
    headRefName: pull.head?.ref ?? '',
    baseRefName: pull.base?.ref ?? '',
    mergeable: pull.conflicted ? 'CONFLICTING' : 'MERGEABLE',
    title: pull.title,
    files: (args: Map<string, GqlValue>, ctx: ExecContext) => filesConnection(ctx, owner, name, pull, args),
    __raw: pull,
    __owner: owner,
    __name: name,
  };
}

function repoValue(store: Store, owner: string, name: string, repo: any, viewer: string): TypedValue {
  return {
    __typename: 'Repository',
    id: encodeGlobalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name ?? `${owner}/${name}`,
    owner: userValue(repo.owner?.login ?? owner),
    defaultBranchRef: repo.default_branch ? refValue(repo.default_branch) : null,
    viewerPermission: repo.owner?.login === viewer ? 'ADMIN' : 'WRITE',
    hasIssuesEnabled: true,
    issue: (args: Map<string, GqlValue>, ctx: ExecContext) => {
      const number = asInt(evalValue(args.get('number') as GqlValue, ctx.variables));
      if (number === null) return null;
      const found = getIssues(store, owner, name).find((i) => i.number === number);
      return found ? issueValue(found) : null;
    },
    issues: (args: Map<string, GqlValue>, ctx: ExecContext) => issuesConnection(ctx, owner, name, args),
    pullRequests: (args: Map<string, GqlValue>, ctx: ExecContext) => pullRequestsConnection(ctx, owner, name, args),
    pullRequest: (args: Map<string, GqlValue>, ctx: ExecContext) => {
      const number = asInt(evalValue(args.get('number') as GqlValue, ctx.variables));
      if (number === null) return null;
      const found = getPulls(store, owner, name).find((p) => p.number === number);
      return found ? pullValue(found, owner, name) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function pageInfo(hasNextPage: boolean, endCursor: string | null): TypedValue {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor: null,
    endCursor,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function orderIssues(issues: GqlIssue[], orderBy: { field: string; direction: string } | null): GqlIssue[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'ASC';
  const sign = direction === 'DESC' ? -1 : 1;
  const sorted = [...issues].sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') {
      cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
    } else {
      // CREATED_AT (and COMMENTS, which the fixture does not use): fall back to created_at.
      cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    }
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * sign;
  });
  return sorted;
}

function issuesConnection(
  ctx: ExecContext,
  owner: string,
  name: string,
  args: Map<string, GqlValue>,
): TypedValue {
  const firstRaw = args.has('first') ? evalValue(args.get('first') as GqlValue, ctx.variables) : null;
  const first = asInt(firstRaw);
  const statesArg = args.has('states') ? evalValue(args.get('states') as GqlValue, ctx.variables) : null;
  const states = enumNames(statesArg);
  const afterArg = args.has('after') ? evalValue(args.get('after') as GqlValue, ctx.variables) : null;

  const orderFieldArg = args.has('orderBy') ? evalValue(args.get('orderBy') as GqlValue, ctx.variables) : null;
  let orderBy: { field: string; direction: string } | null = null;
  if (orderFieldArg !== null && typeof orderFieldArg === 'object' && !Array.isArray(orderFieldArg)) {
    const obj = orderFieldArg as Record<string, unknown>;
    orderBy = {
      field: asEnumName(obj.field) ?? 'CREATED_AT',
      direction: asEnumName(obj.direction) ?? 'ASC',
    };
  }

  let issues = getIssues(ctx.store, owner, name);
  if (states.length > 0) {
    const wanted = new Set(states.map((s) => s.toUpperCase()));
    issues = issues.filter((i) => wanted.has(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  issues = orderIssues(issues, orderBy);

  // Cursor: `after` names the offset of the first node NOT yet returned.
  let start = 0;
  if (typeof afterArg === 'string' && afterArg !== '') {
    const decoded = decodeCursor(afterArg);
    start = decoded !== null ? decoded : 0;
  }
  const total = issues.length;
  const take = first !== null && first >= 0 ? first : total;
  const end = Math.min(start + take, total);
  const slice = issues.slice(start, end);
  const hasNextPage = end < total;
  const endCursor = slice.length > 0 ? encodeCursor(end) : null;

  return {
    __typename: 'IssueConnection',
    totalCount: total,
    nodes: slice.map((i) => issueValue(i)),
    edges: slice.map((i, idx) => ({
      __typename: 'IssueEdge',
      cursor: encodeCursor(start + idx + 1),
      node: issueValue(i),
    })),
    pageInfo: pageInfo(hasNextPage, endCursor),
  };
}

function pullRequestsConnection(
  ctx: ExecContext,
  owner: string,
  name: string,
  args: Map<string, GqlValue>,
): TypedValue {
  const firstRaw = args.has('first') ? evalValue(args.get('first') as GqlValue, ctx.variables) : null;
  const first = asInt(firstRaw);
  let pulls = [...getPulls(ctx.store, owner, name)].sort((a, b) => a.number - b.number);
  const total = pulls.length;
  if (first !== null && first >= 0) pulls = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    totalCount: total,
    nodes: pulls.map((p) => pullValue(p, owner, name)),
    edges: pulls.map((p) => ({ __typename: 'PullRequestEdge', cursor: encodeCursor(p.number), node: pullValue(p, owner, name) })),
    pageInfo: pageInfo(pulls.length < total, null),
  };
}

/** The changed paths of a pull request. */
function pullChangedPaths(store: Store, owner: string, name: string, pull: GqlPull): string[] {
  // 1. An entry-provided per-branch file map (owner/name#branch -> string[]) wins if present.
  const branchFiles = (store as any).branchFiles as Map<string, string[]> | undefined;
  if (branchFiles instanceof Map) {
    const head = branchFiles.get(`${owner}/${name}#${pull.head?.ref ?? ''}`);
    if (head) return [...new Set(head)];
  }
  // 2. An entry-provided per-pull-request file map (owner/name#number -> string[]).
  const prFiles = (store as any).prFiles as Map<string, string[]> | undefined;
  if (prFiles instanceof Map) {
    const rec = prFiles.get(`${owner}/${name}#${pull.number}`);
    if (rec) return [...new Set(rec)];
  }
  // 3. Fall back to the repository's projected file tree (the git default branch projection
  //    githttp.ts maintains on store.files). This lists every path the forge knows.
  const prefix = `${owner}/${name}:`;
  const paths: string[] = [];
  for (const key of store.files.keys()) {
    if (key.startsWith(prefix)) paths.push(key.slice(prefix.length));
  }
  return [...new Set(paths)];
}

function filesConnection(
  ctx: ExecContext,
  owner: string,
  name: string,
  pull: GqlPull,
  args: Map<string, GqlValue>,
): TypedValue {
  const firstRaw = args.has('first') ? evalValue(args.get('first') as GqlValue, ctx.variables) : null;
  const first = asInt(firstRaw);
  let paths = pullChangedPaths(ctx.store, owner, name, pull);
  const total = paths.length;
  if (first !== null && first >= 0) paths = paths.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    totalCount: total,
    nodes: paths.map((p) => ({ __typename: 'PullRequestChangedFile', path: p, additions: 0, deletions: 0 })),
    edges: paths.map((p) => ({
      __typename: 'PullRequestChangedFileEdge',
      cursor: null,
      node: { __typename: 'PullRequestChangedFile', path: p, additions: 0, deletions: 0 },
    })),
    pageInfo: pageInfo(paths.length < total, null),
  };
}

// ---------------------------------------------------------------------------
// Query root
// ---------------------------------------------------------------------------

function typeValue(typeName: string): TypedValue | null {
  const def = SCHEMA[typeName];
  if (!def) return null;
  return {
    __typename: '__Type',
    name: typeName,
    kind: def.kind,
    fields: def.fields
      ? def.fields.map((f) => ({ __typename: '__Field', name: f, isDeprecated: false, deprecationReason: null }))
      : null,
    enumValues: def.enumValues
      ? def.enumValues.map((e) => ({ __typename: '__EnumValue', name: e, isDeprecated: false, deprecationReason: null }))
      : null,
  };
}

function resolveNode(ctx: ExecContext, id: string): TypedValue | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const { typeName, id: numeric } = decoded;
  if (typeName === 'Repository') {
    const found = findRepoById(ctx.store, numeric);
    if (!found) return null;
    return repoValue(ctx.store, found.owner, found.name, found.repo, ctx.viewer);
  }
  if (typeName === 'Issue') {
    const found = findIssueById(ctx.store, numeric);
    if (!found) return null;
    return issueValue(found.issue);
  }
  if (typeName === 'PullRequest') {
    const found = findPullById(ctx.store, numeric);
    if (!found) return null;
    return pullValue(found.pull, found.owner, found.name);
  }
  return null;
}

function buildQueryRoot(ctx: ExecContext, isMutation: boolean): TypedValue {
  const root: TypedValue = {
    __typename: isMutation ? 'Mutation' : 'Query',
    viewer: () => userValue(ctx.viewer),
    repository: (args: Map<string, GqlValue>, c: ExecContext) => {
      const owner = asString(evalValue(args.get('owner') as GqlValue, c.variables));
      const name = asString(evalValue(args.get('name') as GqlValue, c.variables));
      if (owner === null || name === null) return null;
      const repo = getRepo(c.store, owner, name);
      // Unknown repository -> data.repository = null, no error.
      if (!repo) return null;
      return repoValue(c.store, owner, name, repo, c.viewer);
    },
    node: (args: Map<string, GqlValue>, c: ExecContext) => {
      const id = asString(evalValue(args.get('id') as GqlValue, c.variables));
      if (id === null) return null;
      return resolveNode(c, id);
    },
    __type: (args: Map<string, GqlValue>, c: ExecContext) => {
      const name = asString(evalValue(args.get('name') as GqlValue, c.variables));
      if (name === null) return null;
      return typeValue(name);
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
    }),
  };

  if (isMutation) {
    root.createIssue = (args: Map<string, GqlValue>, c: ExecContext) => mutationCreateIssue(c, args);
    root.closeIssue = (args: Map<string, GqlValue>, c: ExecContext) => mutationCloseIssue(c, args);
    root.createPullRequest = (args: Map<string, GqlValue>, c: ExecContext) => mutationCreatePullRequest(c, args);
    root.mergePullRequest = (args: Map<string, GqlValue>, c: ExecContext) => mutationMergePullRequest(c, args);
    root.addComment = (args: Map<string, GqlValue>, c: ExecContext) => mutationAddComment(c, args);
  }

  return root;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function inputObject(args: Map<string, GqlValue>, ctx: ExecContext): Record<string, unknown> {
  const raw = args.has('input') ? evalValue(args.get('input') as GqlValue, ctx.variables) : null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function mutationCreateIssue(ctx: ExecContext, args: Map<string, GqlValue>): TypedValue | null {
  const input = inputObject(args, ctx);
  const repoId = asString(input.repositoryId);
  const title = asString(input.title) ?? '';
  const body = asString(input.body);

  let owner: string;
  let name: string;
  if (repoId !== null) {
    const decoded = decodeGlobalId(repoId);
    const found = decoded ? findRepoById(ctx.store, decoded.id) : null;
    if (found) {
      owner = found.owner;
      name = found.name;
    } else {
      owner = ctx.viewer;
      name = '';
    }
  } else {
    owner = ctx.viewer;
    name = '';
  }

  const key = repoKey(owner, name);
  const counters = ctx.store.counters;
  const num = (counters.get(key) ?? 0) + 1;
  counters.set(key, num);
  const ts = new Date().toISOString();
  const issue: GqlIssue = {
    id: nextStoreId(ctx.store),
    number: num,
    title,
    body: body ?? null,
    state: 'open',
    user: { login: ctx.viewer },
    labels: [],
    created_at: ts,
    updated_at: ts,
    html_url: '',
  };
  const list = (ctx.store.issues.get(key) as GqlIssue[] | undefined) ?? [];
  list.push(issue);
  ctx.store.issues.set(key, list);

  return { __typename: 'CreateIssuePayload', issue: issueValue(issue) };
}

function mutationCloseIssue(ctx: ExecContext, args: Map<string, GqlValue>): TypedValue | null {
  const input = inputObject(args, ctx);
  const issueId = asString(input.issueId);
  if (issueId === null) return { __typename: 'CloseIssuePayload', issue: null };
  const decoded = decodeGlobalId(issueId);
  const found = decoded ? findIssueById(ctx.store, decoded.id) : null;
  if (!found) return { __typename: 'CloseIssuePayload', issue: null };
  found.issue.state = 'closed';
  found.issue.updated_at = new Date().toISOString();
  return { __typename: 'CloseIssuePayload', issue: issueValue(found.issue) };
}

function mutationCreatePullRequest(ctx: ExecContext, args: Map<string, GqlValue>): TypedValue | null {
  const input = inputObject(args, ctx);
  const repoId = asString(input.repositoryId);
  const base = asString(input.baseRefName) ?? '';
  const head = asString(input.headRefName) ?? '';
  const title = asString(input.title) ?? '';
  const body = asString(input.body);

  let owner = ctx.viewer;
  let name = '';
  if (repoId !== null) {
    const decoded = decodeGlobalId(repoId);
    const found = decoded ? findRepoById(ctx.store, decoded.id) : null;
    if (found) {
      owner = found.owner;
      name = found.name;
    }
  }

  const key = repoKey(owner, name);
  const counters = ctx.store.counters;
  const num = (counters.get(key) ?? 0) + 1;
  counters.set(key, num);

  const pull: GqlPull = {
    id: nextStoreId(ctx.store),
    number: num,
    state: 'open',
    head: { ref: head },
    base: { ref: base },
    title,
    body: body ?? null,
    user: { login: ctx.viewer },
    created_at: new Date().toISOString(),
    merged: false,
    conflicted: /!!conflict!!/i.test(head),
  };
  const list = (ctx.store.pulls.get(key) as GqlPull[] | undefined) ?? [];
  list.push(pull);
  ctx.store.pulls.set(key, list);

  return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(pull, owner, name) };
}

function mutationMergePullRequest(ctx: ExecContext, args: Map<string, GqlValue>): TypedValue | null {
  const input = inputObject(args, ctx);
  const pullRequestId = asString(input.pullRequestId);
  if (pullRequestId === null) return { __typename: 'MergePullRequestPayload', pullRequest: null };
  const decoded = decodeGlobalId(pullRequestId);
  const found = decoded ? findPullById(ctx.store, decoded.id) : null;
  if (!found) return { __typename: 'MergePullRequestPayload', pullRequest: null };
  // mergeMethod (MERGE/SQUASH/REBASE) is accepted; the store records a single merged flag.
  found.pull.merged = true;
  found.pull.state = 'closed';
  return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(found.pull, found.owner, found.name) };
}

function mutationAddComment(ctx: ExecContext, args: Map<string, GqlValue>): TypedValue | null {
  const input = inputObject(args, ctx);
  const subjectId = asString(input.subjectId);
  const body = asString(input.body) ?? '';
  if (subjectId === null) {
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const decoded = decodeGlobalId(subjectId);
  const found = decoded ? findIssueById(ctx.store, decoded.id) : null;
  if (!found) {
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const comment = addCommentRecord(ctx.store, found.owner, found.name, found.issue.number, body, ctx.viewer);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'IssueCommentEdge',
      cursor: encodeCursor(comment.id),
      node: { __typename: 'IssueComment', id: encodeGlobalId('IssueComment', comment.id), body: comment.body },
    },
  };
}

// ---------------------------------------------------------------------------
// Running one operation
// ---------------------------------------------------------------------------

function runOperation(store: Store, viewer: string, operation: OperationNode, variables: Record<string, unknown>): GqlResult {
  const ctx: ExecContext = { store, viewer, variables, errors: [] };
  const isMutation = operation.operation === 'mutation';
  const root = buildQueryRoot(ctx, isMutation);
  if (isMutation) {
    // Mutations execute their top-level selections serially, in document order.
    const out: Record<string, any> = {};
    for (const sel of operation.selections) {
      if (sel.kind === 'inline-fragment') continue;
      const key = sel.alias ?? sel.name;
      const raw = resolveField(ctx, root, sel, []);
      out[key] = raw === undefined ? null : sel.selections.length > 0 ? completeValue(ctx, raw, sel.selections, [key]) : raw;
    }
    const result: any = { data: out };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return reply(200, result);
  }

  const data = completeObject(ctx, root, operation.selections, []);
  const result: any = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return reply(200, result);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function normalizeVariables(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

/** Run one operation body: {query, variables, operationName}. */
function handleOne(store: Store, viewer: string, body: any): GqlResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorsReply([{ message: 'the request body must be a JSON object with a "query" field' }]);
  }
  const query = typeof body.query === 'string' ? body.query : null;
  if (query === null) {
    return errorsReply([{ message: 'the request body carries no "query" string' }]);
  }
  const variables = normalizeVariables(body.variables);

  const parsed = parseDocument(query);
  if (!parsed.ok) {
    return errorsReply([{ message: `Syntax Error: ${parsed.error.message}` }]);
  }
  return runOperation(store, viewer, parsed.operation, variables);
}

/**
 * POST /api/graphql.
 *
 * @param headers the request headers (any case); an `Authorization: Bearer <token>` is required.
 * @param body    the raw request body: one {query, variables} object, or a JSON array of them
 *                (GitHub's operation batching, answered with an array in the same order).
 * @param store   the shared forge store (see restv3.ts).
 */
export function handleGraphQL(
  headers: Record<string, string>,
  body: string,
  store: Store,
): { status: number; body: any; headers?: Record<string, string> } {
  // Authentication comes first: an unauthenticated request is exactly 401.
  const viewer = loginFromAuth(headers);
  if (!viewer) return unauthenticated();

  let parsedBody: unknown;
  if (body === undefined || body === null || body === '') {
    parsedBody = {};
  } else {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      return reply(400, { message: 'Problems parsing JSON' });
    }
  }

  // Batched: an array of operation documents.
  if (Array.isArray(parsedBody)) {
    const results = parsedBody.map((entry) => handleOne(store, viewer, entry));
    return reply(200, results.map((r) => r.body));
  }

  return handleOne(store, viewer, parsedBody as any);
}

export default handleGraphQL;
