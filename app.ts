// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and MCP
// from a single in-memory store. main.ts owns the entry <-> env lifecycle; this file owns the
// routing. Every JSON reply carries the X-GitHub-Request-Id header; unknown routes answer
// GitHub's JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { readBody, sendError, sendJson } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertise, receivePack, uploadPack } from './git.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Handle the git smart-HTTP endpoints for one repository. */
async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, query: URLSearchParams): Promise<void> {
  const owner = match[1].includes('%') ? decodeURIComponent(match[1]) : match[1];
  const name = match[2].includes('%') ? decodeURIComponent(match[2]) : match[2];
  const endpoint = match[3];
  const repo = store.findRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (endpoint === 'info/refs' && req.method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Bad service');
      return;
    }
    const answer = advertise(repo, service, protocolV2);
    res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': answer.body.length });
    res.end(answer.body);
    return;
  }
  if (endpoint === 'git-upload-pack' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const out = uploadPack(repo, body, protocolV2);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
    } catch (error) {
      const text = `error: ${(error as Error).message}\n`;
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    }
    return;
  }
  if (endpoint === 'git-receive-pack' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const out = receivePack(repo, body);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
      res.end(out);
    } catch (error) {
      const text = `error: ${(error as Error).message}\n`;
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    }
    return;
  }
  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // Split the request target by hand: the suite's targets are origin-form, and a
        // full URL parse per request is measurable on the timed read loop. Absolute-form
        // targets (a proxy's style, never the suite's) still go through the real parser.
        const rawTarget = req.url ?? '/';
        let path: string;
        let query: URLSearchParams;
        if (rawTarget.startsWith('http://') || rawTarget.startsWith('https://')) {
          const url = new URL(rawTarget);
          path = url.pathname;
          query = url.searchParams;
        } else {
          const q = rawTarget.indexOf('?');
          if (q === -1) {
            path = rawTarget;
            query = new URLSearchParams();
          } else {
            path = rawTarget.slice(0, q);
            query = new URLSearchParams(rawTarget.slice(q + 1));
          }
        }
        const method = req.method ?? 'GET';
        if (method !== 'GET') store.version += 1;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(store, req, res, path.slice('/api/v3'.length), query);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
          await handleGraphql(store, req, res);
          return;
        }
        if (path === '/mcp') {
          if (method === 'DELETE') { res.writeHead(204); res.end(); return; }
          if (method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
          await handleMcp(store, req, res);
          return;
        }
        const gitMatch = GIT_ROUTE.exec(path);
        if (gitMatch) {
          await handleGit(store, req, res, gitMatch, query);
          return;
        }
        sendError(res, 404, 'Not Found');
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
}
