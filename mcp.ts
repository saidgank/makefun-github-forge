// The MCP endpoint: streamable HTTP, no sessions, one JSON body per POST. It speaks the modern
// server/discover handshake (and legacy initialize), and its six tools act on the same store
// the REST and GraphQL surfaces read, so an object created here is the same object everywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { isAuthed, readBody, sendError } from './http.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const PREFERRED_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: true, required } };
}

const STRING = { type: 'string' };
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the given owner.', {
    owner: STRING, name: STRING, description: STRING, private: { type: 'boolean' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: STRING, repo: STRING,
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: STRING, repo: STRING, title: STRING, body: STRING,
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    owner: STRING, repo: STRING, state: STRING,
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch to a base branch.', {
    owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING,
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number.', {
    owner: STRING, repo: STRING, pull_number: { type: 'integer' },
  }, ['owner', 'repo', 'pull_number']),
];

const ALIASES: Record<string, string> = {
  create_repository: 'create_repo', repo_create: 'create_repo', repos_create: 'create_repo', repository_create: 'create_repo',
  get_repository: 'get_repo', repo_get: 'get_repo', repos_get: 'get_repo', repository_get: 'get_repo',
  issue_create: 'create_issue', issues_create: 'create_issue',
  issues_list: 'list_issues', issue_list: 'list_issues',
  pull_request_create: 'create_pull_request', pulls_create: 'create_pull_request', create_pr: 'create_pull_request', pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request', pulls_merge: 'merge_pull_request', merge_pr: 'merge_pull_request', pr_merge: 'merge_pull_request',
};

interface RpcResult {
  status: number;
  payload?: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): RpcResult {
  return { status: 200, payload: { jsonrpc: '2.0', id, error: { code, message } } };
}

function rpcOk(id: unknown, result: unknown): RpcResult {
  return { status: 200, payload: { jsonrpc: '2.0', id, result } };
}

function toolResult(structured: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): RpcResult | { result: Record<string, unknown> } {
  const canonical = ALIASES[name] ?? name;
  const def = TOOLS.find((t) => t.name === canonical);
  if (!def) return { error: rpcError(undefined, -32602, `Unknown tool: ${name}`) } as never;
  const required = (def.inputSchema.required as string[]) ?? [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === '') {
      return { error: rpcError(undefined, -32602, `Missing required argument: ${field}`) } as never;
    }
  }
  const owner = String(args.owner ?? store.viewerLogin);
  const repoName = String(args.repo ?? '');
  const findRepo = (): Repo | undefined => (repoName === '' ? undefined : store.findRepo(owner, repoName));

  switch (canonical) {
    case 'create_repo': {
      const repoNameNew = String(args.name ?? '');
      const existing = store.viewerRepos().find((r) => r.name === repoNameNew);
      const repo = existing ?? store.createRepo(owner, repoNameNew, args.private === true, String(args.description ?? ''));
      return { result: toolResult({ ...repoJson(repo) }) };
    }
    case 'get_repo': {
      const repo = findRepo();
      if (!repo) return { result: toolFailure(`Repository not found: ${owner}/${repoName}`) };
      return { result: toolResult({ ...repoJson(repo) }) };
    }
    case 'create_issue': {
      const repo = findRepo();
      if (!repo) return { result: toolFailure(`Repository not found: ${owner}/${repoName}`) };
      const issue: Issue = {
        number: repo.nextNumber, title: String(args.title ?? ''), body: String(args.body ?? ''),
        state: 'open', labels: [], comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { result: toolResult({ ...issueJson(repo, issue) }) };
    }
    case 'list_issues': {
      const repo = findRepo();
      if (!repo) return { result: toolFailure(`Repository not found: ${owner}/${repoName}`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      const list = issues.map((i) => ({ number: i.number, title: i.title, state: i.state, body: i.body }));
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(list) }],
          structuredContent: { issues: list },
          isError: false,
        },
      };
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (!repo) return { result: toolFailure(`Repository not found: ${owner}/${repoName}`) };
      const pull: Pull = {
        number: repo.nextNumber, title: String(args.title ?? ''), body: String(args.body ?? ''),
        headRef: String(args.head ?? ''), baseRef: String(args.base ?? ''),
        state: 'open', merged: false, mergedAt: '', mergeCommitSha: '',
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { result: toolResult({ ...pullJson(repo, pull) }) };
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (!repo) return { result: toolFailure(`Repository not found: ${owner}/${repoName}`) };
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.get(number);
      if (!pull) return { result: toolFailure(`Pull request not found: ${number}`) };
      if (pull.state === 'open') {
        const merged = mergePull(store, repo, pull, 'squash');
        if (merged === 'conflict') return { result: toolFailure('Pull request is not mergeable') };
      }
      return { result: toolResult({ ...pullJson(repo, pull) }) };
    }
  }
  return { error: rpcError(undefined, -32602, `Unknown tool: ${name}`) } as never;
}

/** Handle one JSON-RPC request object. */
function handleRpc(store: Store, request: Record<string, unknown>): RpcResult {
  const id = request.id;
  const method = String(request.method ?? '');
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcOk(id, {
      resultType: 'complete',
      supportedVersions: [PREFERRED_REVISION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return rpcOk(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const outcome = callTool(store, name, args) as { result?: Record<string, unknown>; error?: RpcResult };
    if (outcome.error) {
      const error = outcome.error;
      return { status: error.status, payload: { jsonrpc: '2.0', id, error: (error.payload as { error: unknown }).error } };
    }
    return rpcOk(id, outcome.result);
  }
  if (method === 'ping') return rpcOk(id, {});
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle POST /mcp. Authentication is decided before any tool exists: no token, HTTP 401. */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const payload = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    const text = `${JSON.stringify(payload)}\n`;
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  // A notification (no id) is acknowledged with 202 and no body.
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as Record<string, unknown>).id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleRpc(store, entry as Record<string, unknown>).payload);
    const text = `${JSON.stringify(results)}\n`;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  const outcome = handleRpc(store, parsed as Record<string, unknown>);
  const text = `${JSON.stringify(outcome.payload)}\n`;
  res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
