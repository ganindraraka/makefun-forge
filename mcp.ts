// mcp.ts — Model Context Protocol (MCP) JSON-RPC 2.0 endpoint over Streamable HTTP
// for the make.fun github-core-clone-01 git forge.
//
// Runs under:
//   node --experimental-strip-types mcp.ts
// Node 22, stdlib only (node:crypto comes in through restv3.ts), no npm packages.
//
// Public surface:
//   export async function handleMcp(method, headers, body, store)
//     -> { status, body, headers? }
//   `method` is the HTTP verb ("POST"/"GET"/"DELETE"/"OPTIONS"); `body` is the
//   exact request text; `store` is the very same Store the REST surface uses.
//
// The server speaks the modern revision 2026-07-28 over a request-scoped
// application/json response (no session, no GET stream): `server/discover`
// answers the identity, capabilities and supportedVersions in one request, and
// every request carries its revision in `_meta`. It also speaks the handshake
// revisions (2025-11-25 and earlier) via `initialize` +
// `notifications/initialized` with an optional `Mcp-Session-Id`.
//
// Every tool acts on the SAME Store as the REST surface: a repository or issue
// created over MCP reads back over /api/v3 as the same object with the same id,
// because the tool handlers route through restv3.ts's handleRest().

import { handleRest } from './restv3.ts';
import type { Store } from './restv3.ts';

// ---------------------------------------------------------------------------
// Server identity and protocol revisions
// ---------------------------------------------------------------------------

export const MCP_SERVER_NAME = 'makefun-forge-mcp';
export const MCP_SERVER_VERSION = '1.0.0';

/** The current revision this server prefers and declares on every answer. */
export const MCP_PRIMARY_REVISION = '2026-07-28';

/** Every revision the server supports, newest first (the modern discover list). */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The legacy (handshake) revisions: everything but the current one. */
const MCP_LEGACY_REVISIONS: readonly string[] = Object.freeze(
  MCP_SUPPORTED_VERSIONS.filter((v) => v !== MCP_PRIMARY_REVISION),
);

const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

const SERVER_INFO = Object.freeze({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

/** The capabilities object every era reports (the tools capability is mandatory). */
const CAPABILITIES = Object.freeze({
  tools: { listChanged: false },
});

const INSTRUCTIONS =
  'A Model Context Protocol server for the make.fun git forge. It exposes repository, ' +
  'issue and pull-request tools that act on the same store the REST v3 API serves, so a ' +
  'repository created with create_repo is the same object GET /api/v3/repos/{owner}/{repo} ' +
  'returns (identical ids).';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Case-insensitive header lookup over a plain record. */
function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** The first present, non-empty value among `keys` (used to read tool arguments leniently). */
function pick(args: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = pick(args, keys);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function pickNumber(args: Record<string, unknown>, keys: readonly string[]): number | null {
  const value = pick(args, keys);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** The HTTP verbs handleMcp recognises on its `method` argument. */
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

const JSON_HEADERS: Record<string, string> = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
});

// ---------------------------------------------------------------------------
// JSON-RPC envelopes
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function jsonResponse(status: number, body: any, extra?: Record<string, string>) {
  return { status, body, headers: { ...JSON_HEADERS, ...(extra ?? {}) } };
}

// ---------------------------------------------------------------------------
// Tool results (MCP CallToolResult)
// ---------------------------------------------------------------------------

function textBlock(text: string) {
  return { type: 'text', text };
}

/** A successful tool result: a text block (JSON) plus structured content for easy parsing. */
function toolOk(structured: unknown, text?: string) {
  return {
    content: [textBlock(text ?? JSON.stringify(structured, null, 2))],
    structuredContent: structured,
    isError: false,
  };
}

/** A tool execution error: `isError: true` with a readable text message. */
function toolError(message: string) {
  return {
    content: [textBlock(message)],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

interface ToolDefine {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, store: Store, headers: Record<string, string>): unknown;
}

/** Split a possibly single-string `full_name` ("owner/repo") argument. */
function resolveOwnerRepo(
  args: Record<string, unknown>,
): { owner: string | null; repo: string | null } {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  const fullName = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if ((owner === null || repo === null) && fullName !== null && fullName.includes('/')) {
    const parts = fullName.split('/');
    if (owner === null && parts[0]) owner = parts[0];
    if (repo === null && parts[1]) repo = parts[1];
  }
  return { owner, repo };
}

function objSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const strProp = (description: string) => ({ type: 'string', description });
const numProp = (description: string) => ({ type: 'integer', description });

/** Build the frozen tool table once: two tools/list answers are then byte-identical. */
function buildTools(): readonly ToolDefine[] {
  const tools: ToolDefine[] = [
    {
      name: 'create_repo',
      title: 'Create a repository',
      description:
        'Create a repository in the authenticated account. Returns the created repository object. ' +
        'A repository created here is the same object GET /api/v3/repos/{owner}/{repo} returns.',
      inputSchema: objSchema(
        {
          name: strProp('The repository name (required).'),
          description: strProp('A short description of the repository.'),
          private: { type: 'boolean', description: 'Whether the repository is private.' },
          owner: strProp('The account owner; the authenticated login when omitted.'),
        },
        ['name'],
      ),
      run(args, store, headers) {
        const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
        if (name === null) return toolError('create_repo requires a "name" argument.');
        const body: Record<string, unknown> = { name };
        const description = pickString(args, ['description', 'about', 'summary']);
        if (description !== null) body.description = description;
        const isPrivate = pick(args, ['private', 'is_private']);
        if (typeof isPrivate === 'boolean') body.private = isPrivate;
        const res = callRest(store, headers, 'POST', '/user/repos', {}, body);
        return restToToolResult(res, (body) => body);
      },
    },
    {
      name: 'get_repo',
      title: 'Get a repository',
      description:
        'Get a single repository by owner and name. Returns the repository object with its stable id.',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository, without the owner prefix.'),
        },
        ['owner', 'repo'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        if (owner === null || repo === null) return toolError('get_repo requires "owner" and "repo".');
        const res = callRest(store, headers, 'GET', `/repos/${encode(owner)}/${encode(repo)}`, {}, null);
        return restToToolResult(res, (body) => body);
      },
    },
    {
      name: 'create_issue',
      title: 'Create an issue',
      description:
        'Create an issue in a repository. Returns the created issue object, including its number. ' +
        'The issue is visible over GET /api/v3/repos/{owner}/{repo}/issues with the same id.',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository.'),
          title: strProp('The title of the issue (required).'),
          body: strProp('The contents of the issue.'),
        },
        ['owner', 'repo', 'title'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        const title = pickString(args, ['title', 'issue_title', 'subject']);
        if (owner === null || repo === null || title === null) {
          return toolError('create_issue requires "owner", "repo" and "title".');
        }
        const payload: Record<string, unknown> = { title };
        const body = pickString(args, ['body', 'issue_body', 'content', 'text', 'comment']);
        if (body !== null) payload.body = body;
        const res = callRest(store, headers, 'POST', `/repos/${encode(owner)}/${encode(repo)}/issues`, {}, payload);
        return restToToolResult(res, (b) => b);
      },
    },
    {
      name: 'list_issues',
      title: 'List issues',
      description:
        'List the issues a repository holds, optionally filtered by state ("open", "closed" or "all").',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository.'),
          state: strProp('Which issues to return: open, closed or all (default all).'),
        },
        ['owner', 'repo'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        if (owner === null || repo === null) return toolError('list_issues requires "owner" and "repo".');
        const state = (pickString(args, ['state', 'status']) ?? 'all').toLowerCase();
        const res = callRest(store, headers, 'GET', `/repos/${encode(owner)}/${encode(repo)}/issues`, {}, null);
        if (res.status < 200 || res.status >= 300 || !Array.isArray(res.body)) {
          return restToToolResult(res, (b) => b);
        }
        let issues = res.body as Array<Record<string, unknown>>;
        if (state === 'open' || state === 'closed') {
          issues = issues.filter((issue) => issue.state === state);
        }
        const structured = { issues };
        return toolOk(structured, JSON.stringify(structured, null, 2));
      },
    },
    {
      name: 'create_pull_request',
      title: 'Create a pull request',
      description:
        'Open a pull request from a head branch into a base branch. Returns the created pull request ' +
        'object; GET /api/v3/repos/{owner}/{repo}/pulls/{number} reads back the same head and base.',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository.'),
          title: strProp('The title of the pull request (required).'),
          head: strProp('The name of the branch where your changes are implemented.'),
          base: strProp('The name of the branch you want the changes pulled into.'),
          body: strProp('The contents of the pull request.'),
        },
        ['owner', 'repo', 'title', 'head', 'base'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
        const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from']);
        const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into']);
        if (owner === null || repo === null || title === null || head === null || base === null) {
          return toolError('create_pull_request requires "owner", "repo", "title", "head" and "base".');
        }
        const payload: Record<string, unknown> = { title, head, base };
        const body = pickString(args, ['body', 'pr_body', 'description', 'content']);
        if (body !== null) payload.body = body;
        const res = callRest(store, headers, 'POST', `/repos/${encode(owner)}/${encode(repo)}/pulls`, {}, payload);
        return restToToolResult(res, (b) => b);
      },
    },
    {
      name: 'merge_pull_request',
      title: 'Merge a pull request',
      description:
        'Merge an open pull request by number. Returns the merge result (a sha and merged:true); ' +
        'GET /api/v3/repos/{owner}/{repo}/pulls/{number} then reads merged:true.',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository.'),
          pull_number: numProp('The number that identifies the pull request (required).'),
        },
        ['owner', 'repo', 'pull_number'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
        if (owner === null || repo === null || number === null) {
          return toolError('merge_pull_request requires "owner", "repo" and "pull_number".');
        }
        const res = callRest(store, headers, 'PUT', `/repos/${encode(owner)}/${encode(repo)}/pulls/${number}/merge`, {}, {});
        return restToToolResult(res, (b) => (isRecord(b) ? b : { merged: true }));
      },
    },
    {
      name: 'get_issue',
      title: 'Get an issue',
      description: 'Get a single issue of a repository by its number.',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository.'),
          issue_number: numProp('The number that identifies the issue.'),
        },
        ['owner', 'repo', 'issue_number'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        const number = pickNumber(args, ['issue_number', 'number', 'index']);
        if (owner === null || repo === null || number === null) {
          return toolError('get_issue requires "owner", "repo" and "issue_number".');
        }
        const res = callRest(store, headers, 'GET', `/repos/${encode(owner)}/${encode(repo)}/issues/${number}`, {}, null);
        return restToToolResult(res, (b) => b);
      },
    },
    {
      name: 'list_pull_requests',
      title: 'List pull requests',
      description: 'List the pull requests a repository holds, with their head and base refs.',
      inputSchema: objSchema(
        {
          owner: strProp('The account owner of the repository.'),
          repo: strProp('The name of the repository.'),
          state: strProp('Which pull requests to return: open, closed or all (default all).'),
        },
        ['owner', 'repo'],
      ),
      run(args, store, headers) {
        const { owner, repo } = resolveOwnerRepo(args);
        if (owner === null || repo === null) return toolError('list_pull_requests requires "owner" and "repo".');
        const res = callRest(store, headers, 'GET', `/repos/${encode(owner)}/${encode(repo)}/pulls`, {}, null);
        if (res.status < 200 || res.status >= 300 || !Array.isArray(res.body)) {
          return restToToolResult(res, (b) => b);
        }
        const structured = { pulls: res.body };
        return toolOk(structured, JSON.stringify(structured, null, 2));
      },
    },
  ];
  return Object.freeze(tools);
}

const TOOLS: readonly ToolDefine[] = buildTools();

/** The tool table exactly as tools/list answers it, frozen so the bytes never move. */
const TOOLS_LIST: readonly Record<string, unknown>[] = Object.freeze(
  TOOLS.map((tool) =>
    Object.freeze({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }),
  ),
);

/** Normalize a tool name for lookup: lowercase, non-alphanumerics dropped. */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a called tool by exact name, then by normalized suffix (a server prefix is allowed). */
function findTool(name: string | null): ToolDefine | null {
  if (name === null) return null;
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) {
    if (normalizeToolName(tool.name) === wanted) return tool;
  }
  for (const tool of TOOLS) {
    const normalized = normalizeToolName(tool.name);
    if (wanted.length > normalized.length && wanted.endsWith(normalized)) return tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bridge to the REST store (so MCP and REST share one object graph)
// ---------------------------------------------------------------------------

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

interface RestOutcome {
  status: number;
  body: any;
  headers?: Record<string, string>;
}

/**
 * Call the REST router against the very same Store. `method`/`path` are the REST
 * verb and the path without the /api/v3 prefix (exactly what handleRest expects).
 */
function callRest(
  store: Store,
  headers: Record<string, string>,
  method: string,
  path: string,
  query: Record<string, string>,
  body: Record<string, unknown> | null,
): RestOutcome {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, value);
  const text = body === null ? '' : JSON.stringify(body);
  const answer = handleRest(method, path, params, headers, text, store);
  if (answer === null) return { status: 404, body: { message: 'Not Found' } };
  return answer;
}

/** Turn a REST outcome into a tool result: an error result for a non-2xx, else a success. */
function restToToolResult(res: RestOutcome, shape: (body: any) => unknown) {
  if (res.status >= 200 && res.status < 300) {
    return toolOk(shape(res.body));
  }
  const message = isRecord(res.body) && typeof res.body.message === 'string' ? res.body.message : 'Request failed';
  return toolError(`HTTP ${res.status}: ${message}`);
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

function handleDiscover() {
  return rpcResult('discover-1', {
    resultType: 'complete',
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { ...CAPABILITIES },
    serverInfo: { ...SERVER_INFO },
    instructions: INSTRUCTIONS,
    _meta: {
      'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
    },
  });
}

function handleInitialize(id: JsonRpcId, params: Record<string, unknown> | undefined) {
  const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_PRIMARY_REVISION;
  return rpcResult(id, {
    protocolVersion: negotiated,
    capabilities: { ...CAPABILITIES },
    serverInfo: { ...SERVER_INFO },
    instructions: INSTRUCTIONS,
  });
}

function handleToolsList(id: JsonRpcId) {
  // A fresh, structurally-identical copy of the frozen list: byte-for-byte across calls.
  const tools = TOOLS_LIST.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return rpcResult(id, { tools });
}

function handleToolsCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  store: Store,
  headers: Record<string, string>,
) {
  const name = params && typeof params.name === 'string' ? params.name : null;
  const args = params && isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};

  const tool = findTool(name);
  if (tool === null) {
    // An unknown tool name is an invalid-params error, never an HTTP 500.
    return rpcError(id, -32602, `Unknown tool: ${name ?? '(missing name)'}`);
  }

  const schema = tool.inputSchema as { required?: string[] };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    // Missing required arguments answer isError:true (a valid CallToolResult).
    return rpcResult(id, toolError(`${tool.name}: missing required argument(s): ${missing.join(', ')}`));
  }

  try {
    const result = tool.run(args, store, headers);
    return rpcResult(id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rpcResult(id, toolError(`${tool.name} failed: ${message}`));
  }
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

interface ParsedBody {
  ok: true;
  value: unknown;
}
interface ParseFailure {
  ok: false;
}

function parseRequestBody(body: string): ParsedBody | ParseFailure {
  const trimmed = (body ?? '').trim();
  if (trimmed === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Answer one JSON-RPC request object (a value that is not a plain record is a bad request). */
function answerRequest(
  request: unknown,
  store: Store,
  headers: Record<string, string>,
  fallbackMethod: string | null,
): { body: any; notification: boolean } {
  if (!isRecord(request)) {
    return { body: rpcError(null, -32600, 'Invalid Request: not a JSON-RPC object'), notification: false };
  }

  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const id = hasId ? ((request.id as JsonRpcId) ?? null) : null;
  const method =
    typeof request.method === 'string' && request.method !== ''
      ? request.method
      : fallbackMethod;
  const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : undefined;

  // A notification carries no id member: run it, answer nothing.
  const notification = !hasId && method !== null && method.startsWith('notifications/');

  switch (method) {
    case 'server/discover':
      return { body: handleDiscover(), notification: false };
    case 'initialize':
      return { body: handleInitialize(id, params), notification: false };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { body: null, notification: true };
    case 'ping':
      return { body: rpcResult(id, {}), notification: false };
    case 'tools/list':
      return { body: handleToolsList(id), notification: false };
    case 'tools/call':
      return { body: handleToolsCall(id, params, store, headers), notification: false };
    default:
      if (notification) return { body: null, notification: true };
      return { body: rpcError(id, -32601, `Method not found: ${method ?? '(missing method)'}`), notification: false };
  }
}

/**
 * The MCP endpoint. `method` is the HTTP verb; `headers` and `body` are the raw
 * request; `store` is the shared forge Store. Returns `{status, body, headers?}`.
 */
export async function handleMcp(
  method: string,
  headers: Record<string, string>,
  body: string,
  store: Store,
): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  const rawMethod = typeof method === 'string' ? method : '';
  const isVerb = HTTP_VERBS.has(rawMethod.toUpperCase());
  const verb = isVerb ? rawMethod.toUpperCase() : 'POST';
  // When the caller passes a JSON-RPC method instead of an HTTP verb, remember it.
  const fallbackMethod = isVerb || rawMethod === '' ? null : rawMethod;

  if (verb === 'OPTIONS') {
    return {
      status: 204,
      body: null,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Mcp-Param-*',
      },
    };
  }

  if (verb === 'GET') {
    // The 2026-07-28 transport offers no server-initiated GET stream.
    return jsonResponse(405, rpcError(null, -32601, 'Method not allowed: this server offers no GET stream'), {
      Allow: 'POST, DELETE, OPTIONS',
    });
  }

  if (verb === 'DELETE') {
    // No protocol-level session is held; a session goodbye is a no-op.
    return { status: 204, body: null, headers: { 'MCP-Session-Id': 'makefun-forge-mcp' } };
  }

  // ---- authentication --------------------------------------------------
  const authorization = headerOf(headers, 'authorization');
  if (authorization === undefined || authorization.trim() === '') {
    return {
      status: 401,
      body: rpcError(null, -32001, 'Unauthorized: an Authorization header is required'),
      headers: { ...JSON_HEADERS, 'WWW-Authenticate': 'Bearer realm="makefun-forge-mcp"' },
    };
  }

  // ---- parse -----------------------------------------------------------
  const parsed = parseRequestBody(body);
  if (!parsed.ok) {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    return jsonResponse(400, rpcError(null, -32700, 'Parse error: the request body is not valid JSON'));
  }

  const value = parsed.value;

  // A JSON-RPC batch: answer every entry, dropping notifications.
  if (Array.isArray(value)) {
    const answers: any[] = [];
    for (const entry of value) {
      const { body: answer, notification } = answerRequest(entry, store, headers, null);
      if (!notification && answer !== null) answers.push(answer);
    }
    if (answers.length === 0) return { status: 202, body: null, headers: { ...JSON_HEADERS } };
    return jsonResponse(200, answers);
  }

  if (value === null && fallbackMethod === null) {
    return jsonResponse(400, rpcError(null, -32600, 'Invalid Request: an empty body carries no JSON-RPC request'));
  }

  const { body: answer, notification } = answerRequest(value, store, headers, fallbackMethod);
  if (notification) {
    return { status: 202, body: null, headers: { 'MCP-Session-Id': 'makefun-forge-mcp' } };
  }
  return jsonResponse(200, answer);
}

export default handleMcp;
