// A small GraphQL executor covering exactly the v4 surface the suite speaks: the viewer's
// login, repositories, issues and pull requests (queries, connections with cursor pagination,
// and the five mutations gh and github-mcp-server send), node(id:) global ids, and __type
// introspection. Errors follow GitHub's convention: HTTP 200 with an errors array whose
// message names the offending field.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { isAuthed, parseJson, readBody, sendError, sendJson } from './http.ts';
import { changedFiles, mergeBase, mergePull } from './rest.ts';

// ------------------------------------------------------------------ global ids

export function repoGid(repo: Repo): string {
  return `repo_${repo.databaseId}`;
}
export function issueGid(repo: Repo, issue: Issue): string {
  return `issue_${repo.databaseId}_${issue.number}`;
}
export function pullGid(repo: Repo, pull: Pull): string {
  return `pull_${repo.databaseId}_${pull.number}`;
}
export function commentGid(id: number): string {
  return `comment_${id}`;
}

function repoByGid(store: Store, gid: string): Repo | undefined {
  const match = /^repo_(\d+)$/.exec(gid);
  if (!match) return undefined;
  const id = parseInt(match[1], 10);
  return store.viewerRepos().find((r) => r.databaseId === id);
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias?: string;
  args: { name: string; value: Value }[];
  selection?: SelectionItem[];
}

type SelectionItem =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionItem[] };

interface Operation {
  type: 'query' | 'mutation';
  selection: SelectionItem[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$!='.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') { out += source[j + 1]; j += 2; }
        else { out += source[j]; j += 1; }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (!match) throw new Error(`unexpected character ${ch}`);
    tokens.push(match[0]);
    i += match[0].length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }
  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        if (this.peek() !== '(' && this.peek() !== '{') this.next(); // operation name
        if (this.peek() === '(') this.skipBalanced();
        operations.push({ type, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        // Named fragments are not exercised; skip their definitions.
        while (this.pos < this.tokens.length && this.peek() !== '{') this.next();
        this.skipBalanced();
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '{' || token === '[') depth += 1;
      if (token === ')' || token === '}' || token === ']') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): SelectionItem[] {
    this.expect('{');
    const items: SelectionItem[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          items.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          // Fragment spread: not exercised; skip the name.
          this.next();
        }
        continue;
      }
      items.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return items;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selection: SelectionItem[] | undefined;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name];
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'bool': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema

interface Typed {
  __type: string;
  [key: string]: unknown;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'url', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typed(type: string, props: Record<string, unknown>): Typed {
  return { __type: type, ...props };
}

// ------------------------------------------------------------------ execution

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function issueTyped(repo: Repo, issue: Issue): Typed {
  return typed('Issue', { repo, issue });
}
function pullTyped(repo: Repo, pull: Pull): Typed {
  return typed('PullRequest', { repo, pull });
}
function repoTyped(repo: Repo): Typed {
  return typed('Repository', { repo });
}

function paginateIssues(repo: Repo, args: Record<string, unknown>): Typed {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const descending = orderBy?.direction !== 'ASC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const first = typeof args.first === 'number' ? args.first : issues.length;
  let start = 0;
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after.startsWith('cursor_')) {
    const afterNumber = parseInt(after.slice('cursor_'.length), 10);
    const index = issues.findIndex((i) => i.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const page = issues.slice(start, start + first);
  const hasNext = start + first < issues.length;
  const endCursor = page.length > 0 ? `cursor_${page[page.length - 1].number}` : (typeof after === 'string' ? after : '');
  return typed('IssueConnection', {
    nodes: page.map((i) => issueTyped(repo, i)),
    pageInfo: typed('PageInfo', { hasNextPage: hasNext, hasPreviousPage: start > 0, startCursor: page.length ? `cursor_${page[0].number}` : '', endCursor }),
  });
}

function resolveField(ctx: ExecCtx, source: Typed | null, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  const store = ctx.store;
  const typeName = source === null ? (ctx as unknown as { rootType: string }).rootType : source.__type;

  if (field.name === '__typename') return typeName;
  if (field.name === '__type') {
    const name = String(args.name ?? '');
    if (TYPE_FIELDS[name]) return typed('__Type', { name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name], enumNames: undefined });
    if (ENUM_VALUES[name]) return typed('__Type', { name, kind: 'ENUM', fieldNames: undefined, enumNames: ENUM_VALUES[name] });
    return null;
  }

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return typed('User', { login: store.viewerLogin || 'viewer' });
      if (field.name === 'repository') {
        const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoTyped(repo) : null;
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const repo = repoByGid(store, id);
        if (repo) return repoTyped(repo);
        const issueMatch = /^issue_(\d+)_(\d+)$/.exec(id);
        if (issueMatch) {
          const owner = store.viewerRepos().find((r) => r.databaseId === parseInt(issueMatch[1], 10));
          const issue = owner?.issues.get(parseInt(issueMatch[2], 10));
          if (owner && issue) return issueTyped(owner, issue);
        }
        const pullMatch = /^pull_(\d+)_(\d+)$/.exec(id);
        if (pullMatch) {
          const owner = store.viewerRepos().find((r) => r.databaseId === parseInt(pullMatch[1], 10));
          const pull = owner?.pulls.get(parseInt(pullMatch[2], 10));
          if (owner && pull) return pullTyped(owner, pull);
        }
        return null;
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = args.input as { repositoryId: string; title: string; body?: string };
        const repo = repoByGid(store, String(input.repositoryId));
        if (!repo) return null;
        const issue: Issue = {
          number: repo.nextNumber, title: String(input.title ?? ''), body: String(input.body ?? ''),
          state: 'open', labels: [], comments: [],
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return typed('CreateIssuePayload', { issue: issueTyped(repo, issue) });
      }
      if (field.name === 'closeIssue') {
        const input = args.input as { issueId: string };
        const match = /^issue_(\d+)_(\d+)$/.exec(String(input.issueId));
        if (!match) return null;
        const repo = store.viewerRepos().find((r) => r.databaseId === parseInt(match[1], 10));
        const issue = repo?.issues.get(parseInt(match[2], 10));
        if (!repo || !issue) return null;
        issue.state = 'closed';
        return typed('CloseIssuePayload', { issue: issueTyped(repo, issue) });
      }
      if (field.name === 'addComment') {
        const input = args.input as { subjectId: string; body: string };
        const match = /^issue_(\d+)_(\d+)$/.exec(String(input.subjectId));
        if (!match) return null;
        const repo = store.viewerRepos().find((r) => r.databaseId === parseInt(match[1], 10));
        const issue = repo?.issues.get(parseInt(match[2], 10));
        if (!repo || !issue) return null;
        const comment = { id: store.nextComment(), body: String(input.body ?? '') };
        issue.comments.push(comment);
        const node = typed('IssueComment', { id: commentGid(comment.id), body: comment.body });
        return typed('AddCommentPayload', { commentEdge: typed('IssueCommentEdge', { node }) });
      }
      if (field.name === 'createPullRequest') {
        const input = args.input as { repositoryId: string; baseRefName: string; headRefName: string; title: string; body?: string };
        const repo = repoByGid(store, String(input.repositoryId));
        if (!repo) return null;
        const pull: Pull = {
          number: repo.nextNumber, title: String(input.title ?? ''), body: String(input.body ?? ''),
          headRef: String(input.headRefName), baseRef: String(input.baseRefName),
          state: 'open', merged: false, mergedAt: '', mergeCommitSha: '',
        };
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        return typed('CreatePullRequestPayload', { pullRequest: pullTyped(repo, pull) });
      }
      if (field.name === 'mergePullRequest') {
        const input = args.input as { pullRequestId: string; mergeMethod?: string };
        const match = /^pull_(\d+)_(\d+)$/.exec(String(input.pullRequestId));
        if (!match) return null;
        const repo = store.viewerRepos().find((r) => r.databaseId === parseInt(match[1], 10));
        const pull = repo?.pulls.get(parseInt(match[2], 10));
        if (!repo || !pull) return null;
        if (pull.state === 'open') mergePull(store, repo, pull, String(input.mergeMethod ?? 'SQUASH').toLowerCase());
        return typed('MergePullRequestPayload', { pullRequest: pullTyped(repo, pull) });
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return (source as Typed).login;
      if (field.name === 'id') return `user_1`;
      break;
    }
    case 'Repository': {
      const repo = (source as Typed).repo as Repo;
      switch (field.name) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.databaseId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return typed('User', { login: repo.owner });
        case 'defaultBranchRef': return typed('Ref', { name: repo.defaultBranch });
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueTyped(repo, issue) : null;
        }
        case 'issues': return paginateIssues(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullTyped(repo, pull) : null;
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
          return typed('PullRequestConnection', { nodes: pulls.map((p) => pullTyped(repo, p)) });
        }
      }
      break;
    }
    case 'Issue': {
      const repo = (source as Typed).repo as Repo;
      const issue = (source as Typed).issue as Issue;
      switch (field.name) {
        case 'id': return issueGid(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'repository': return repoTyped(repo);
      }
      break;
    }
    case 'PullRequest': {
      const repo = (source as Typed).repo as Repo;
      const pull = (source as Typed).pull as Pull;
      switch (field.name) {
        case 'id': return pullGid(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'repository': return repoTyped(repo);
        case 'files': {
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
          if (!baseTip || !headTip) return typed('PullRequestConnection', { nodes: [] });
          const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
          const files = changedFiles(repo, base, headTip).map((f) =>
            typed('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: 'ADDED' }));
          const first = typeof args.first === 'number' ? args.first : files.length;
          return typed('FileConnection', { nodes: files.slice(0, first) });
        }
      }
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return (source as Typed).name;
      break;
    }
    case 'PageInfo': {
      if (field.name in (source as Typed)) return (source as Typed)[field.name];
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection': {
      if (field.name === 'nodes') return (source as Typed).nodes;
      if (field.name === 'pageInfo') return (source as Typed).pageInfo;
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name in (source as Typed)) return (source as Typed)[field.name];
      break;
    }
    case 'IssueComment': {
      if (field.name in (source as Typed)) return (source as Typed)[field.name];
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return (source as Typed).issue;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return (source as Typed).commentEdge;
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return (source as Typed).node;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return (source as Typed).pullRequest;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return (source as Typed).name;
      if (field.name === 'kind') return (source as Typed).kind;
      if (field.name === 'fields') {
        const names = (source as Typed).fieldNames as string[] | undefined;
        return names ? names.map((name) => typed('__Field', { name })) : null;
      }
      if (field.name === 'enumValues') {
        const names = (source as Typed).enumNames as string[] | undefined;
        return names ? names.map((name) => typed('__EnumValue', { name })) : null;
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return (source as Typed).name;
      break;
    }
  }

  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
  return null;
}

function executeSelection(ctx: ExecCtx, source: Typed | null, selection: SelectionItem[], rootType: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'fragment') {
      const sourceType = source === null ? rootType : source.__type;
      if (item.typeCondition === sourceType) {
        Object.assign(out, executeSelection(ctx, source, item.selection, rootType));
      }
      continue;
    }
    const field = item.field;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, source, field);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Typed).__type !== undefined && field.selection) {
      out[key] = executeSelection(ctx, value as Typed, field.selection, rootType);
    } else if (Array.isArray(value) && field.selection) {
      out[key] = value.map((entry) =>
        entry !== null && typeof entry === 'object' && (entry as Typed).__type !== undefined
          ? executeSelection(ctx, entry as Typed, field.selection!, rootType)
          : entry);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Execute one GraphQL operation body ({query, variables}) and return the envelope. */
export function executeGraphql(store: Store, body: { query?: unknown; variables?: unknown }): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Parse error: ${(error as Error).message}` }] };
  }
  const operation = operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const ctx = { store, variables, errors: [] as { message: string }[], rootType } as unknown as ExecCtx;
  const data = executeSelection(ctx, null, operation.selection, rootType);
  const envelope: Record<string, unknown> = { data };
  if ((ctx as unknown as { errors: { message: string }[] }).errors.length > 0) {
    envelope.errors = (ctx as unknown as { errors: { message: string }[] }).errors;
  }
  return envelope;
}

/** Handle POST /api/graphql, including batched array bodies. */
export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    sendJson(res, 200, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((entry) => executeGraphql(store, entry as { query?: unknown; variables?: unknown }));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, executeGraphql(store, parsed.value as { query?: unknown; variables?: unknown }));
}
