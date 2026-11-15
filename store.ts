// The forge's store: every repository, issue, pull request and git object lives here, in memory,
// in one process. Nothing in this file reads a wall clock or a random source: a logical clock and
// sequential counters make every run of the same request sequence produce the same bytes, which
// the contest's replay comparison depends on.

import { createHash } from 'node:crypto';

/** One git object: its type and its raw (uncompressed) content. */
export interface GitObject {
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly data: Buffer;
}

/** A parsed commit object. */
export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorLine: string;
  readonly committerLine: string;
  readonly message: string;
}

/** One entry of a parsed tree object. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** The zero object id, used for unborn refs and deletions. */
export const ZERO_OID = '0'.repeat(40);

/** SHA-1 of a buffer, hex. The forge's only hash. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object with the given type and content. */
export function objectId(type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Parse a commit object's raw bytes. Tolerant of missing fields; the forge stores what it is given. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

/** Parse a tree object's raw bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries back to raw bytes. Entries are written in the order given. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree ordering: entries sort by name, directories as if their name ended in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** A label on a repository. */
export interface Label {
  name: string;
  color: string;
}

/** A comment on an issue or pull request. */
export interface Comment {
  id: number;
  body: string;
}

/** An issue. Pull requests share the per-repo number sequence, as on GitHub. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

/** A pull request. */
export interface Pull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
}

/** One repository: its metadata, its REST resources and its whole git object store. */
export class Repo {
  readonly databaseId: number;
  owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  headTarget: string;

  constructor(databaseId: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.databaseId = databaseId;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = 'main';
    this.headTarget = 'refs/heads/main';
  }

  /** Store an object (computing its id) and return the id. Idempotent. */
  putObject(type: GitObject['type'], data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (received in a pack). */
  putObjectWithId(oid: string, type: GitObject['type'], data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** The commit a ref or 'HEAD' names, resolved through the symref. */
  refOid(ref: string): string | undefined {
    if (ref === 'HEAD') {
      const target = this.refs.get(this.headTarget);
      return target;
    }
    return this.refs.get(ref);
  }

  /** Walk a tree by path segments; returns the entry found, or undefined. */
  treeEntryAt(treeOid: string, segments: readonly string[]): TreeEntry | undefined {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (!entry) return undefined;
      if (i === segments.length - 1) return entry;
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** The blob bytes at a path on a ref, or undefined when absent. */
  blobAt(ref: string, path: string): { oid: string; data: Buffer } | undefined {
    const tip = this.refOid(ref);
    if (!tip) return undefined;
    const commit = this.objects.get(tip);
    if (!commit || commit.type !== 'commit') return undefined;
    const tree = parseCommit(commit.data).tree;
    const entry = this.treeEntryAt(tree, path.split('/'));
    if (!entry || entry.mode === '40000') return undefined;
    const blob = this.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return undefined;
    return { oid: entry.oid, data: blob.data };
  }

  /**
   * Replace (or remove, when blobOid is null) the file at `segments` under `treeOid`, rebuilding
   * the tree chain. Returns the new tree oid. Missing intermediate directories are created.
   */
  updateTree(treeOid: string | undefined, segments: readonly string[], blobOid: string | null): string {
    const existing = treeOid ? this.objects.get(treeOid) : undefined;
    const entries: TreeEntry[] = existing && existing.type === 'tree' ? [...parseTree(existing.data)] : [];
    const [head, ...rest] = segments;
    const index = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index === -1) {
        entries.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        entries[index] = { mode: '100644', name: head, oid: blobOid };
      }
    } else {
      const childOid = index === -1 ? undefined : entries[index].oid;
      const newChild = this.updateTree(childOid, rest, blobOid);
      const childObj = this.objects.get(newChild);
      const childEmpty = blobOid === null && childObj !== undefined && childObj.type === 'tree' && parseTree(childObj.data).length === 0;
      if (childEmpty) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index === -1) entries.push({ mode: '40000', name: head, oid: newChild });
      else entries[index] = { mode: '40000', name: head, oid: newChild };
    }
    return this.putObject('tree', buildTree(sortTreeEntries(entries)));
  }

  /** Is `ancestor` reachable from `descendant` by walking commit parents? */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** Commits reachable from a tip, newest first (topological by discovery, parents after children). */
  commitHistory(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'commit') continue;
      order.push(current);
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return order;
  }
}

/** The whole forge state. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private clockTick = 0;
  /** The viewer's login, learned from the first owner name that addresses a viewer repo. */
  viewerLogin = '';

  /** A deterministic timestamp: a logical clock starting 2026-01-01, one second per call. */
  nowIso(): string {
    this.clockTick += 1;
    const base = Date.UTC(2026, 0, 1, 0, 0, 0) + this.clockTick * 1000;
    return new Date(base).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A deterministic epoch (seconds) for git author/committer lines the forge itself writes. */
  nowEpoch(): number {
    return 1767225600 + this.clockTick;
  }

  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Learn the viewer's login the first time an owner name successfully addresses a repo. */
  private bindViewer(owner: string): void {
    if (this.viewerLogin === '' && owner !== '') this.viewerLogin = owner;
  }

  /** Create a repository owned by the viewer (owner may still be the placeholder ''). */
  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  /**
   * Find a repository by the owner/name a request used. Repos created through /user/repos are
   * stored under the placeholder owner ''; the first concrete owner that addresses one binds as
   * the viewer's login and adopts it. A different owner afterwards does not resolve (404).
   */
  findRepo(owner: string, name: string): Repo | undefined {
    const direct = this.repos.get(this.key(owner, name));
    if (direct) {
      this.bindViewer(owner);
      return direct;
    }
    const unowned = this.repos.get(this.key('', name));
    if (unowned) {
      if (this.viewerLogin === '' || this.viewerLogin === owner) {
        this.bindViewer(owner);
        this.repos.delete(this.key('', name));
        unowned.owner = owner;
        this.repos.set(this.key(owner, name), unowned);
        return unowned;
      }
      return undefined;
    }
    return undefined;
  }

  /** The viewer's own repositories, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
}
