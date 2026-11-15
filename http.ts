// Shared HTTP plumbing for every surface: JSON replies with the request-id header the protocol
// checks demand, body reading, and the {message} error shape GitHub uses everywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next deterministic request id. Non-empty is all the protocol checks ask for. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

/** Answer with a JSON body and the headers every reply must carry. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a pre-serialized JSON body (same headers as sendJson). */
export function sendJsonText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

/** Answer with GitHub's error shape: {"message": ...}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a whole request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON; returns {ok:false} for malformed input instead of throwing. */
export function parseJson(buffer: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buffer.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** The bearer token the suite presents, from the environment; '' when unset (local runs). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Is this request authenticated? When no token is configured, everything is (local runs). */
export function isAuthed(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}
