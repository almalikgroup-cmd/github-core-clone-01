// app.ts: the forge's HTTP server — one process serving the health probe, the REST v3 API,
// GraphQL, the MCP endpoint and the git smart-HTTP transport, all over one shared Forge
// store. main.ts owns the env lifecycle; this file owns routing, authentication and the
// cross-cutting reply rules (JSON error bodies, a request id on every API reply).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  RECEIVE_ADVERTISE_TYPE,
  RECEIVE_RESULT_TYPE,
  UPLOAD_ADVERTISE_TYPE,
  UPLOAD_RESULT_TYPE,
  advertiseV0,
  advertiseV2,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
} from './githttp.ts';
import { pktDecode, pktText } from './gitobj.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the forge reads (packs for the benchmark's history stay far under). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The bearer token the suite presents; empty when the env did not set one (local runs). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Whether the request carries the suite's token (any request passes when none is configured). */
function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

/** Read a whole request body, bounded; resolves null when the body is unusable. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        done(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', () => done(null));
    req.on('close', () => done(null));
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  };

  const handleGit = async (req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string, url: URL): Promise<void> => {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const repo = forge.getRepo(owner, repoName);
    if (tail === 'info/refs' && req.method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendBuffer(res, 400, Buffer.from('service not understood\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      if (repo === null) {
        sendBuffer(res, 404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      const protocol = req.headers['git-protocol'] ?? '';
      if (service === 'git-upload-pack' && protocol.includes('version=2')) {
        sendBuffer(res, 200, advertiseV2(), UPLOAD_ADVERTISE_TYPE);
        return;
      }
      sendBuffer(res, 200, advertiseV0(repo, service), service === 'git-upload-pack' ? UPLOAD_ADVERTISE_TYPE : RECEIVE_ADVERTISE_TYPE);
      return;
    }
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (tail === 'git-upload-pack' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) {
        sendBuffer(res, 400, Buffer.from('unreadable request body\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      const protocol = req.headers['git-protocol'] ?? '';
      if (protocol.includes('version=2')) {
        const { lines } = pktDecode(body);
        const first = lines.find((line) => line.kind === 'data');
        const command = first === undefined ? '' : pktText(first).trim();
        if (command === 'command=ls-refs') {
          sendBuffer(res, 200, handleLsRefs(repo, body), UPLOAD_RESULT_TYPE);
          return;
        }
        if (command === 'command=fetch') {
          sendBuffer(res, 200, handleFetchV2(repo, body), UPLOAD_RESULT_TYPE);
          return;
        }
        sendBuffer(res, 400, Buffer.from('unknown protocol v2 command\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      const { lines } = pktDecode(body);
      const hasWant = lines.some((line) => line.kind === 'data' && pktText(line).startsWith('want '));
      if (!hasWant) {
        sendBuffer(res, 400, Buffer.from('malformed upload-pack request\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      sendBuffer(res, 200, handleFetchV0(repo, body), UPLOAD_RESULT_TYPE);
      return;
    }
    if (tail === 'git-receive-pack' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) {
        sendBuffer(res, 400, Buffer.from('unreadable request body\n', 'utf8'), 'text/plain; charset=utf-8');
        return;
      }
      const outcome = handleReceivePack(repo, body);
      sendBuffer(res, outcome.status, outcome.body, outcome.status === 200 ? RECEIVE_RESULT_TYPE : 'text/plain; charset=utf-8');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const requestId = nextRequestId();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
            return;
          }
          const body = await readBody(req);
          const outcome = handleGraphQL(forge, body === null ? '' : body.toString('utf8'));
          sendJson(res, outcome.status, outcome.body, { 'x-github-request-id': requestId });
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          const body = await readBody(req);
          const outcome = handleMcp(forge, body === null ? '' : body.toString('utf8'));
          if (outcome.response === null) {
            res.writeHead(202, { 'content-length': 0 });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.response);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path.slice('/api/v3'.length);
          const isPublic = method === 'GET' && (restPath === '' || restPath === '/' || restPath === '/meta');
          if (!isPublic && !authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
            return;
          }
          let bodyObject: Record<string, unknown> | undefined;
          let malformedBody = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw !== null && raw.length > 0) {
              try {
                const parsed = JSON.parse(raw.toString('utf8')) as unknown;
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) bodyObject = parsed as Record<string, unknown>;
                else malformedBody = true;
              } catch {
                malformedBody = true;
              }
            }
          }
          const restReq: RestRequest = {
            method,
            path: restPath === '/' ? '' : restPath,
            query: url.searchParams,
            body: bodyObject,
            malformedBody,
            host: req.headers.host ?? 'entry',
          };
          const result = handleRest(forge, restReq);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
            return;
          }
          if (result.empty === true) {
            res.writeHead(result.status, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body ?? {}, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          let owner = gitMatch[1] ?? '';
          let repoName = gitMatch[2] ?? '';
          try {
            owner = decodeURIComponent(owner);
            repoName = decodeURIComponent(repoName);
          } catch {
            // keep the raw segments
          }
          await handleGit(req, res, owner, repoName, gitMatch[3] ?? '', url);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (error) {
        // A handler's failure is a 500 with a JSON body, never a hung or crashed process.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${error instanceof Error ? error.message : String(error)}` }, { 'x-github-request-id': requestId });
          else res.end();
        } catch {
          // the socket is already gone
        }
      }
    })();
  });

  return server;
}
