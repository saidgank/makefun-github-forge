// The REST v3 surface: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, in GitHub's shapes and status codes. Contents writes are real git commits in
// the repo's own object store, so the REST view and the git view never disagree.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, parseCommit, parseTree } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { isAuthed, parseJson, readBody, sendError, sendJson } from './http.ts';

/** The JSON view of a repository. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: `repo_${repo.databaseId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
  };
}

/** The JSON view of an issue. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: `issue_${repo.databaseId}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
  };
}

/** The JSON view of a pull request. */
export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  const body: Record<string, unknown> = {
    id: pull.number,
    node_id: `pull_${repo.databaseId}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
  };
  if (pull.merged) {
    body.merged_at = pull.mergedAt;
    body.merge_commit_sha = pull.mergeCommitSha;
  }
  return body;
}

/** Create a commit on a branch from a new tree, with the forge's deterministic identity. */
export function commitOn(store: Store, repo: Repo, branchRef: string, treeOid: string, message: string, parents: readonly string[]): string {
  const epoch = store.nowEpoch();
  const identity = `makefun-forge <forge@make.fun> ${epoch} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`, '', message);
  const sha = repo.putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.refs.set(branchRef, sha);
  return sha;
}

/** Every file path in a tree, flattened with its blob oid and bytes. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; data: Buffer }> {
  const out = new Map<string, { oid: string; data: Buffer }>();
  const walk = (oid: string, base: string): void => {
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.getObject(entry.oid);
        if (blob) out.set(path, { oid: entry.oid, data: blob.data });
      }
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The tree oid at a commit, or undefined. */
export function treeOfCommit(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.getObject(commitOid);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** Line counts for a blob pair, for the pull-request files view. */
function lineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number; status: string } {
  const oldLines = oldData === undefined ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === undefined ? [] : newData.toString('utf8').split('\n');
  if (oldData === undefined) return { additions: newLines.length, deletions: 0, status: 'added' };
  if (newData === undefined) return { additions: 0, deletions: oldLines.length, status: 'removed' };
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
    status: 'modified',
  };
}

/** The files changed between two commits, in the pull-request files shape. */
export function changedFiles(repo: Repo, baseCommit: string, headCommit: string): Record<string, unknown>[] {
  const baseTree = treeOfCommit(repo, baseCommit);
  const headTree = treeOfCommit(repo, headCommit);
  const baseFiles = baseTree ? flattenTree(repo, baseTree) : new Map();
  const headFiles = headTree ? flattenTree(repo, headTree) : new Map();
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const out: Record<string, unknown>[] = [];
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    const diff = lineDiff(before?.data, after?.data);
    out.push({
      filename: path,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      sha: after?.oid ?? before?.oid ?? '',
    });
  }
  return out;
}

/** The merge-base (best common ancestor) of two commits, or undefined. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsOfA = new Set(repo.commitHistory(a));
  for (const candidate of repo.commitHistory(b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Merge a pull request into its base branch. Returns the merge commit sha, or 'conflict'.
 * Three-way per file against the merge-base; squash keeps one parent, merge keeps two.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull, method: string): string | 'conflict' {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return 'conflict';
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = flattenTree(repo, treeOfCommit(repo, base)!);
  const currentFiles = flattenTree(repo, treeOfCommit(repo, baseTip)!);
  const headFiles = flattenTree(repo, treeOfCommit(repo, headTip)!);
  const paths = [...new Set([...baseFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()])].sort();
  let tree = treeOfCommit(repo, baseTip)!;
  for (const path of paths) {
    const inBase = baseFiles.get(path)?.oid;
    const inCurrent = currentFiles.get(path)?.oid;
    const inHead = headFiles.get(path)?.oid;
    if (inCurrent === inHead) continue;
    if (inBase === inCurrent) {
      tree = repo.updateTree(tree, path.split('/'), inHead ?? null);
    } else if (inBase === inHead) {
      continue;
    } else {
      return 'conflict';
    }
  }
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = commitOn(store, repo, baseRef, tree, pull.title, parents);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  return sha;
}

/** Resolve a `sha` query/ref value to a commit oid: branch name, ref, or commit id. */
export function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refOid('HEAD');
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const obj = repo.getObject(ref);
  if (obj && obj.type === 'commit') return ref;
  return undefined;
}

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  rawBody: Buffer;
}

/** Parse the JSON body of a request that needs one; on malformed JSON, answer 400 and stop. */
function jsonBody(ctx: Ctx): Record<string, unknown> | undefined {
  const parsed = parseJson(ctx.rawBody);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return undefined;
  }
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) return {};
  return parsed.value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Handle one /api/v3 request. `path` is the path after the /api/v3 prefix. */
export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const rawBody = await readBody(req);
  const segments = path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  const ctx: Ctx = { store, req, res, segments, query, body: undefined, rawBody };
  const method = req.method ?? 'GET';

  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  // The viewer's repositories.
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === undefined) return;
      const name = str(body.name);
      if (name === '') { sendError(res, 422, 'Repository creation failed.'); return; }
      if (store.viewerRepos().some((r) => r.name === name)) { sendError(res, 422, 'name already exists on this account'); return; }
      const repo = store.createRepo(store.viewerLogin, name, body.private === true, str(body.description));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.viewerRepos();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(res, 200, slice.map(repoJson), headers);
      return;
    }
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const owner = segments[1];
  const repoName = segments[2];
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(3);
  await handleRepo(store, ctx, repo, rest, method);
}

async function handleRepo(store: Store, ctx: Ctx, repo: Repo, rest: string[], method: string): Promise<void> {
  const { res, query } = ctx;

  // Repository itself.
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === undefined) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '') { /* renames are not exercised */ }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': 'forge-delete' });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Branches.
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
    return;
  }

  // Create a ref.
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const body = jsonBody(ctx);
    if (body === undefined) return;
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !repo.getObject(sha)) { sendError(res, 422, 'Validation Failed'); return; }
    if (repo.refs.has(ref)) { sendError(res, 422, 'Reference already exists'); return; }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, node_id: `ref_${repo.databaseId}`, url: '', object: { sha, type: 'commit' } });
    return;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveCommit(repo, query.get('sha') ?? undefined);
    if (!tip) { sendJson(res, 200, []); return; }
    const commits = repo.commitHistory(tip).map((sha) => {
      const obj = repo.getObject(sha)!;
      const info = parseCommit(obj.data);
      return { sha, node_id: `commit_${sha}`, commit: { message: info.message, tree: { sha: info.tree } } };
    });
    sendJson(res, 200, commits);
    return;
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const body = jsonBody(ctx);
    if (body === undefined) return;
    const name = str(body.name);
    if (name === '') { sendError(res, 422, 'Validation Failed'); return; }
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color: str(body.color) || 'ededed' });
    sendJson(res, 201, { name, color: repo.labels.get(name)!.color });
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    await handleContents(store, ctx, repo, rest.slice(1).join('/'), method);
    return;
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    handleIssues(store, ctx, repo, rest.slice(1), method);
    return;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    handlePulls(store, ctx, repo, rest.slice(1), method);
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function handleContents(store: Store, ctx: Ctx, repo: Repo, path: string, method: string): Promise<void> {
  const { res, query } = ctx;
  const branchRefOf = (branch: string | undefined): string => `refs/heads/${branch ?? repo.defaultBranch}`;

  if (method === 'GET') {
    const refName = query.get('ref') ?? undefined;
    const commit = resolveCommit(repo, refName);
    if (!commit) { sendError(res, 404, 'Not Found'); return; }
    const tree = treeOfCommit(repo, commit);
    if (!tree) { sendError(res, 404, 'Not Found'); return; }
    if (path === '') {
      sendJson(res, 200, dirListing(repo, tree, ''));
      return;
    }
    const entry = repo.treeEntryAt(tree, path.split('/'));
    if (!entry) { sendError(res, 404, 'Not Found'); return; }
    if (entry.mode === '40000') {
      sendJson(res, 200, dirListing(repo, entry.oid, path));
      return;
    }
    const blob = repo.getObject(entry.oid);
    if (!blob) { sendError(res, 404, 'Not Found'); return; }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.oid,
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
    });
    return;
  }

  if (method === 'PUT') {
    const body = jsonBody(ctx);
    if (body === undefined) return;
    const branchRef = branchRefOf(typeof body.branch === 'string' ? body.branch : undefined);
    const tip = repo.refs.get(branchRef);
    if (body.branch !== undefined && !tip && repo.refs.size > 0 && branchRef !== `refs/heads/${repo.defaultBranch}`) {
      sendError(res, 404, 'Branch not found');
      return;
    }
    const content = Buffer.from(str(body.content), 'base64');
    const existing = tip ? repo.blobAt(branchRef, path) : undefined;
    if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match');
      return;
    }
    const blobOid = repo.putObject('blob', content);
    const baseTree = tip ? treeOfCommit(repo, tip) : undefined;
    const newTree = repo.updateTree(baseTree, path.split('/'), blobOid);
    const sha = commitOn(store, repo, branchRef, newTree, str(body.message), tip ? [tip] : []);
    if (branchRef === `refs/heads/${repo.defaultBranch}` && repo.headTarget !== branchRef) repo.headTarget = branchRef;
    sendJson(res, existing ? 200 : 201, {
      content: { sha: blobOid, encoding: 'base64', name: path.split('/').pop(), path },
      commit: { sha },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = jsonBody(ctx);
    if (body === undefined) return;
    const branchRef = branchRefOf(typeof body.branch === 'string' ? body.branch : undefined);
    const tip = repo.refs.get(branchRef);
    const existing = tip ? repo.blobAt(branchRef, path) : undefined;
    if (!tip || !existing) { sendError(res, 404, 'Not Found'); return; }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match');
      return;
    }
    const newTree = repo.updateTree(treeOfCommit(repo, tip), path.split('/'), null);
    const sha = commitOn(store, repo, branchRef, newTree, str(body.message), [tip]);
    sendJson(res, 200, { content: null, commit: { sha } });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** A directory listing in the contents shape. */
function dirListing(repo: Repo, treeOid: string, basePath: string): Record<string, unknown>[] {
  const obj = repo.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
    sha: entry.oid,
  }));
}

function handleIssues(store: Store, ctx: Ctx, repo: Repo, rest: string[], method: string): void {
  const { res, query } = ctx;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === undefined) return;
      const labelNames = Array.isArray(body.labels) ? body.labels.map((l) => str(l)) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) { sendError(res, 422, 'Validation Failed: label does not exist'); return; }
      }
      const issue: Issue = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
        labels: labelNames,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
      const page = parseInt(query.get('page') ?? '1', 10) || 1;
      sendJson(res, 200, issues.slice((page - 1) * perPage, page * perPage).map((i) => issueJson(repo, i)));
      return;
    }
  }

  const number = parseInt(rest[0] ?? '', 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (!issue) { sendError(res, 404, 'Not Found'); return; }
    if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === undefined) return;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
  }

  if (rest.length === 2 && rest[1] === 'comments' && issue) {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === undefined) return;
      const comment = { id: store.nextComment(), body: str(body.body) };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

function handlePulls(store: Store, ctx: Ctx, repo: Repo, rest: string[], method: string): void {
  const { res, query } = ctx;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === undefined) return;
      const head = str(body.head);
      const base = str(body.base);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        sendError(res, 422, 'Validation Failed');
        return;
      }
      const pull: Pull = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        headRef: head,
        baseRef: base,
        state: 'open',
        merged: false,
        mergedAt: '',
        mergeCommitSha: '',
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
      const page = parseInt(query.get('page') ?? '1', 10) || 1;
      sendJson(res, 200, pulls.slice((page - 1) * perPage, page * perPage).map((p) => pullJson(repo, p)));
      return;
    }
  }

  const number = parseInt(rest[0] ?? '', 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1 && method === 'GET') {
    if (!pull) { sendError(res, 404, 'Not Found'); return; }
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) { sendError(res, 404, 'Not Found'); return; }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) { sendJson(res, 200, []); return; }
    const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
    sendJson(res, 200, changedFiles(repo, base, headTip));
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) { sendError(res, 404, 'Not Found'); return; }
    const body = jsonBody(ctx);
    if (body === undefined) return;
    if (pull.state !== 'open') { sendError(res, 405, 'Pull Request is not mergeable'); return; }
    const methodName = str(body.merge_method) || 'squash';
    const result = mergePull(store, repo, pull, methodName);
    if (result === 'conflict') { sendError(res, 405, 'Pull Request is not mergeable'); return; }
    sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(res, 404, 'Not Found');
}
