// The forge's HTTP surface: one process, four surfaces (git smart HTTP, REST v3,
// GraphQL v4 and MCP), all served from one in-memory store. main.ts owns the
// entry <-> env lifecycle; this is the server it drives.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, handleRest, type Store } from './restv3.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** Shared empty query for requests with no query string (handlers only ever read it). */
const EMPTY_QUERY = new URLSearchParams();
/** The REST v3 path prefix. */
const REST_PREFIX = '/api/v3';
/** A shared empty body buffer for bodyless requests (GET/HEAD). */
const EMPTY_BODY = Buffer.alloc(0);

/** Read the whole request body into a Buffer (works for binary git traffic). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer one request with a JSON body (never HTML). */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const h: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': randomId(),
    ...headers,
  };
  res.writeHead(status, h);
  res.end(text);
}

/** A non-empty request id for every reply (the wire contract requires one on REST). */
let reqIdSeq = 0;
function randomId(): string {
  reqIdSeq += 1;
  return `req_${reqIdSeq.toString(36)}${(Date.now() & 0xffffff).toString(36)}`;
}

/** Lowercase a header map; repeated headers join with ', '. Node's req.headers are already lowercase. */
function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const src = req.headers;
  const out: Record<string, string> = {};
  for (const k in src) {
    const v = src[k];
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Send a raw body (Buffer or string) with explicit headers. */
function sendRaw(res: ServerResponse, status: number, body: Buffer | string, headers: Readonly<Record<string, string>>): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-length': String(buf.length), ...headers });
  res.end(buf);
}

/** Build the server. It binds nothing until the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store: Store = createStore();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    // Split the request target into an (undecoded) path and the raw query string. The path is left
    // percent-encoded: handlers decode each segment themselves, so %2F must not become a separator.
    let path: string;
    let search: string;
    const qIdx = rawUrl.indexOf('?');
    if (qIdx === -1) {
      path = rawUrl;
      search = '';
    } else {
      path = rawUrl.slice(0, qIdx);
      search = rawUrl.slice(qIdx + 1);
    }
    const method = (req.method ?? 'GET').toUpperCase();
    // Only pay for query parsing when there is a query string; the hot read path never has one.
    const query = search === '' ? EMPTY_QUERY : new URLSearchParams(search);
    const headers = normalizeHeaders(req);

    try {
      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- MCP: /mcp (JSON-RPC 2.0 over Streamable HTTP) ----
      if (path === '/mcp') {
        const raw = await readBody(req);
        const out = await handleMcp(method, headers, raw.toString('utf8'), store);
        sendRaw(res, out.status, typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {
          'content-type': 'application/json; charset=utf-8',
          ...(out.headers ?? {}),
        });
        return;
      }

      // ---- GraphQL v4: /api/graphql ----
      if (path === '/api/graphql') {
        const raw = await readBody(req);
        const out = handleGraphQL(headers, raw.toString('utf8'), store);
        sendRaw(res, out.status, typeof out.body === 'string' ? out.body : JSON.stringify(out.body), {
          'content-type': 'application/json; charset=utf-8',
          'x-github-request-id': randomId(),
          ...(out.headers ?? {}),
        });
        return;
      }

      // ---- Git smart HTTP: /{owner}/{repo}.git/... (binary, may be POST) ----
      // A GET (info/refs advertisement) has no body; only read the stream for POST.
      const needsBody = method !== 'GET' && method !== 'HEAD';
      const raw = needsBody ? await readBody(req) : EMPTY_BODY;
      const gitOut = handleGit(method, path, query, headers, raw, store);
      if (gitOut !== null) {
        sendRaw(res, gitOut.status, gitOut.body, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-cache',
          ...(gitOut.headers ?? {}),
        });
        return;
      }

      // ---- REST v3: /api/v3/... ----
      // handleRest expects the path with the /api/v3 prefix stripped.
      const restPath = path.startsWith(REST_PREFIX) ? (path.slice(REST_PREFIX.length) || '/') : path;
      const bodyText = needsBody ? raw.toString('utf8') : '';
      const restOut = handleRest(method, restPath, query, headers, bodyText, store);
      if (restOut !== null) {
        const h: Record<string, string> = { 'x-github-request-id': randomId(), ...(restOut.headers ?? {}) };
        const status = restOut.status;
        if (status === 204) {
          res.writeHead(204, h);
          res.end();
          return;
        }
        if (restOut.rawBody !== undefined) {
          // Already-serialized JSON: write it as-is with an explicit length (no chunked encoding).
          const text = `${restOut.rawBody}\n`;
          const h2: Record<string, string> = { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)), ...h };
          res.writeHead(status, h2);
          res.end(text);
          return;
        }
        sendJson(res, status, restOut.body, h);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // A farm never throws to the client: answer 500 JSON with a message.
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    }
  });
  // Keep a warm client socket around well past a benchmark round: no re-handshake between requests.
  // Disable Nagle so tiny keep-alive replies leave immediately instead of waiting to coalesce.
  server.on('connection', (socket) => socket.setNoDelay(true));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
  return server;
}
