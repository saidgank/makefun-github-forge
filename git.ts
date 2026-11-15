// Git smart HTTP, implemented from the protocol up: pkt-lines, packfiles (read and write,
// including delta resolution), the v2 ls-refs/fetch commands, the v0 fetch, and receive-pack
// with per-ref report-status. Only node:zlib and node:crypto are used; there is no git binary.

import { deflateSync, inflateSync } from 'node:zlib';
import { Repo, ZERO_OID, objectId, parseCommit, parseTree, sha1Hex, type GitObject } from './store.ts';

type ObjectType = GitObject['type'];
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ------------------------------------------------------------------ pkt-lines

/** Encode one pkt-line payload (a Buffer, or null for a flush packet). */
export function pktLine(payload: Buffer | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'ascii');
  const length = payload.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

export const FLUSH = pktLine(null);
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** A cursor over a pkt-line stream. Throws on malformed framing; callers turn that into a 400. */
export class PktReader {
  private offset = 0;
  private readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }

  /** The next payload, 'flush', 'delim', 'end', or undefined at the end of the stream. */
  next(): Buffer | 'flush' | 'delim' | 'end' | undefined {
    if (this.offset >= this.data.length) return undefined;
    if (this.offset + 4 > this.data.length) throw new Error('truncated pkt-line header');
    const header = this.data.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) { this.offset += 4; return 'flush'; }
    if (length === 1) { this.offset += 4; return 'delim'; }
    if (length === 2) { this.offset += 4; return 'end'; }
    if (length < 4 || this.offset + length > this.data.length) throw new Error('bad pkt-line length');
    const payload = this.data.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return payload;
  }

  /** Everything not yet consumed (the raw pack after a push command list). */
  rest(): Buffer {
    return this.data.subarray(this.offset);
  }
}

// ------------------------------------------------------------------ packs

/** Inflate one zlib stream starting at `offset`; returns the data and the offset just past it. */
function inflateAt(data: Buffer, offset: number, expectedSize: number): { out: Buffer; next: number } {
  // The stream's end is the smallest prefix length that inflates to exactly the declared size
  // with its Adler-32 check passing; bracket it starting near the declared size (a pack entry
  // rarely compresses far from its raw length), widening by doubling, then binary-search it.
  let hi = Math.min(data.length, offset + Math.max(64, Math.ceil(expectedSize * 1.05) + 32));
  let lo = offset;
  for (;;) {
    try {
      const out = inflateSync(data.subarray(offset, hi));
      if (out.length === expectedSize) break;
      lo = hi;
    } catch {
      lo = hi;
    }
    if (hi >= data.length) throw new Error('cannot inflate pack entry');
    hi = Math.min(data.length, offset + (hi - offset) * 2 + 16);
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(data.subarray(offset, mid)).length === expectedSize;
    } catch { ok = false; }
    if (ok) hi = mid; else lo = mid;
  }
  return { out: inflateSync(data.subarray(offset, hi)), next: hi };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== resultSize || out.length !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/** Parse a whole packfile into its objects, resolving both delta kinds. */
export function parsePack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: { typeCode: number; data: Buffer; baseOffset?: number; baseOid?: string; start: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset, size);
    offset = inflated.next;
    raw.push({ typeCode, data: inflated.out, baseOffset, baseOid, start });
  }
  const byStart = new Map<number, number>();
  raw.forEach((entry, index) => byStart.set(entry.start, index));
  const resolved: (PackEntry | undefined)[] = raw.map(() => undefined);
  const resolve = (index: number): PackEntry => {
    const memo = resolved[index];
    if (memo) return memo;
    const entry = raw[index];
    let out: PackEntry;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: PackEntry | GitObject;
      if (entry.typeCode === 6) {
        const baseIndex = byStart.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error('ofs-delta base outside pack');
        base = resolve(baseIndex);
      } else {
        const inPack = raw.findIndex((candidate, candidateIndex) => resolved[candidateIndex]?.oid === entry.baseOid);
        if (inPack !== -1) base = resolve(inPack);
        else {
          const external = externalBase?.(entry.baseOid!);
          if (!external) throw new Error('ref-delta base not found');
          base = external;
        }
      }
      const data = applyDelta(base.data, entry.data);
      out = { type: base.type, data, oid: objectId(base.type, data) };
    } else {
      const type = CODE_TYPES[entry.typeCode];
      if (!type) throw new Error('unknown pack object type');
      out = { type, data: entry.data, oid: objectId(type, entry.data) };
    }
    resolved[index] = out;
    return out;
  };
  return raw.map((_, index) => resolve(index));
}

/** Serialise objects into a version-2 packfile with no deltas. */
export function buildPack(entries: readonly PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const typeCode = TYPE_CODES[entry.type];
    let size = entry.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes: number[] = [size > 0 ? first | 0x80 : first];
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      headerBytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(entry.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ reachability

export interface ClosureOptions {
  /** Commits the client already holds: neither they nor their trees/blobs are sent. */
  excludeTips?: readonly string[];
  /** Existing shallow boundary commits the client holds (their tree closure is excluded too). */
  heldShallow?: readonly string[];
  /** Total commit depth from each want tip (1 = tips only). Undefined = unlimited. */
  depth?: number;
}

export interface Closure {
  objects: PackEntry[];
  /** Commits whose parents were cut by the depth limit. */
  boundary: string[];
  /** Held shallow commits that stopped being shallow (their parents are now included). */
  unshallowed: string[];
}

/** Compute the object set for a fetch: closure(wants) minus closure(excludes), depth-limited. */
export function computeClosure(repo: Repo, wants: readonly string[], options: ClosureOptions): Closure {
  const depth = options.depth;
  // Distances (shortest path, in commit generations) from the want tips.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (obj && obj.type === 'tag') {
      const target = peelToCommit(repo, want);
      if (target && !distance.has(target)) { distance.set(target, 0); queue.push(target); }
    } else if (obj && obj.type === 'commit' && !distance.has(want)) {
      distance.set(want, 0);
      queue.push(want);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const d = distance.get(current)!;
    if (depth !== undefined && d + 1 >= depth) continue;
    const obj = repo.getObject(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!distance.has(parent)) {
        distance.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const includedCommits = new Set(distance.keys());
  const boundary: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of distance) {
      if (d === depth - 1) {
        const obj = repo.getObject(oid);
        if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) boundary.push(oid);
      }
    }
  }
  // Exclusion: everything the client already holds. A plain have excludes its whole ancestry;
  // a shallow-held commit excludes only itself and its tree closure — its parents are exactly
  // what a deepen fetch is asking for, so they must stay sendable.
  const excluded = new Set<string>();
  const heldShallowSet = new Set(options.heldShallow ?? []);
  const markExcluded = (tip: string, followParents: boolean): void => {
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (excluded.has(current)) continue;
      const obj = repo.getObject(current);
      if (!obj) continue;
      excluded.add(current);
      if (obj.type === 'commit') {
        stack.push(parseCommit(obj.data).tree);
        if (followParents) for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(tagTarget(obj.data));
      }
    }
  };
  for (const tip of options.excludeTips ?? []) markExcluded(tip, !heldShallowSet.has(tip));
  for (const tip of options.heldShallow ?? []) markExcluded(tip, false);

  const included = new Map<string, PackEntry>();
  const addObject = (oid: string): void => {
    if (included.has(oid) || excluded.has(oid)) return;
    const obj = repo.getObject(oid);
    if (!obj) return;
    included.set(oid, { oid, type: obj.type, data: obj.data });
    if (obj.type === 'commit') addObject(parseCommit(obj.data).tree);
    if (obj.type === 'tree') for (const entry of parseTree(obj.data)) addObject(entry.oid);
    if (obj.type === 'tag') addObject(tagTarget(obj.data));
  };
  // Wants that are tags or blobs/trees go in whole; commits go in when included by the walk.
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (includedCommits.has(want)) addObject(want);
    } else {
      addObject(want);
    }
  }
  for (const oid of includedCommits) addObject(oid);
  const unshallowed: string[] = [];
  for (const held of options.heldShallow ?? []) {
    if (includedCommits.has(held) && !boundary.includes(held)) {
      const obj = repo.getObject(held);
      if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.some((p) => includedCommits.has(p))) unshallowed.push(held);
    }
  }
  const objects = [...included.values()].sort((a, b) => TYPE_CODES[a.type] - TYPE_CODES[b.type] || (a.oid < b.oid ? -1 : 1));
  return { objects, boundary, unshallowed };
}

/** The object id an annotated tag object points at. */
export function tagTarget(data: Buffer): string {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : ZERO_OID;
}

/** Follow tag objects down to the commit they name. */
export function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.getObject(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') { current = tagTarget(obj.data); continue; }
    return undefined;
  }
  return undefined;
}

// ------------------------------------------------------------------ advertisements

const AGENT = 'makefun-forge/1.0';

function uploadCaps(repo: Repo): string {
  return `side-band-64k shallow symref=HEAD:${repo.headTarget} agent=${AGENT}`;
}

function receiveCaps(): string {
  return `report-status side-band-64k delete-refs agent=${AGENT}`;
}

/** Ref lines for a v0 advertisement, capabilities riding on the first line. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (refs.length === 0) {
    lines.push(pktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'utf8')));
    return lines;
  }
  const headOid = repo.refOid('HEAD') ?? ZERO_OID;
  lines.push(pktLine(Buffer.from(`${headOid} HEAD\0${caps}\n`, 'utf8')));
  for (const [ref, oid] of refs) {
    lines.push(pktLine(Buffer.from(`${oid} ${ref}\n`, 'utf8')));
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) lines.push(pktLine(Buffer.from(`${peeled} ${ref}^{}\n`, 'utf8')));
    }
  }
  return lines;
}

/** The info/refs response for a service, honouring a v2 request for upload-pack. */
export function advertise(repo: Repo, service: string, protocolV2: boolean): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && protocolV2) {
    const parts = [
      pktLine(Buffer.from('version 2\n', 'utf8')),
      pktLine(Buffer.from(`agent=${AGENT}\n`, 'utf8')),
      pktLine(Buffer.from('object-format=sha1\n', 'utf8')),
      pktLine(Buffer.from('ls-refs\n', 'utf8')),
      pktLine(Buffer.from('fetch=shallow filter\n', 'utf8')),
      FLUSH,
    ];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  const caps = service === 'git-receive-pack' ? receiveCaps() : uploadCaps(repo);
  const parts = [pktLine(Buffer.from(`# service=${service}\n`, 'utf8')), FLUSH, ...v0RefLines(repo, caps), FLUSH];
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ upload-pack

/** Wrap pack bytes in side-band-64k packets (band 1), each within the pkt-line limit. */
function sidebandWrap(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

/** Parse a v0 fetch request: want section, flush, have section, done, flush. */
function parseV0Fetch(reader: PktReader): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  let first = true;
  for (;;) {
    const item = reader.next();
    if (item === undefined || item === 'flush') break;
    if (item === 'delim' || item === 'end') continue;
    const line = item.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
    first = false;
  }
  void first;
  for (;;) {
    const item = reader.next();
    if (item === undefined || item === 'flush') break;
    if (item === 'delim' || item === 'end') continue;
    const line = item.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Parse a v2 command request: command line, capabilities, delim, arguments, flush. */
function parseV2Request(reader: PktReader): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (;;) {
    const item = reader.next();
    if (item === undefined || item === 'flush') break;
    if (item === 'delim') { inArgs = true; continue; }
    if (item === 'end') break;
    const line = item.toString('utf8').replace(/\n$/, '');
    if (!inArgs && line.startsWith('command=')) command = line.slice(8);
    else if (inArgs) args.push(line);
  }
  return { command, args };
}

/** The v2 ls-refs answer. */
function lsRefs(repo: Repo, argLines: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  if (matches('HEAD')) {
    const headOid = repo.refOid('HEAD');
    if (headOid) {
      lines.push(pktLine(Buffer.from(`${headOid} HEAD${symrefs ? ` symref-target:${repo.headTarget}` : ''}\n`, 'utf8')));
    } else if (symrefs) {
      lines.push(pktLine(Buffer.from(`${ZERO_OID} HEAD symref-target:${repo.headTarget}\n`, 'utf8')));
    }
  }
  void unborn;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let suffix = '';
    if (peel) {
      const obj = repo.getObject(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) suffix = ` peeled:${peeled}`;
      }
    }
    lines.push(pktLine(Buffer.from(`${oid} ${ref}${suffix}\n`, 'utf8')));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/**
 * Fetch responses are pure functions of the request and the repo's refs (objects are
 * content-addressed and immutable), so identical fetches — fifty concurrent shallow clones
 * of one tip, say — are answered from a cache keyed by both. Any ref move changes the key.
 */
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(repo: Repo, args: FetchArgs, v2: boolean): string {
  const refs = [...repo.refs.entries()].map(([ref, oid]) => `${ref}=${oid}`).sort().join(',');
  return [
    repo.databaseId, v2 ? 'v2' : 'v0', args.wants.join(','), args.haves.join(','),
    args.shallow.join(','), args.depth ?? -1, repo.objects.size, refs,
  ].join('|');
}

/** Build the fetch response (v2 sections or v0 lines + sideband) for parsed arguments. */
function fetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  const key = fetchCacheKey(repo, args, v2);
  const cached = fetchCache.get(key);
  if (cached) return cached;
  const built = buildFetchResponse(repo, args, v2);
  if (fetchCache.size > 128) fetchCache.clear();
  fetchCache.set(key, built);
  return built;
}

function buildFetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  const closure = computeClosure(repo, args.wants, {
    excludeTips: args.haves,
    heldShallow: args.shallow,
    depth: args.depth,
  });
  const pack = buildPack(closure.objects);
  const parts: Buffer[] = [];
  if (v2) {
    if (args.haves.length > 0) {
      parts.push(pktLine(Buffer.from('acknowledgments\n', 'utf8')));
      parts.push(pktLine(Buffer.from('NAK\n', 'utf8')));
      parts.push(DELIM);
    }
    if (args.depth !== undefined || args.shallow.length > 0) {
      parts.push(pktLine(Buffer.from('shallow-info\n', 'utf8')));
      for (const oid of closure.boundary) parts.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
      for (const oid of closure.unshallowed) parts.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
      parts.push(DELIM);
    }
    parts.push(pktLine(Buffer.from('packfile\n', 'utf8')));
    parts.push(...sidebandWrap(pack));
    parts.push(FLUSH);
  } else {
    for (const oid of closure.boundary) parts.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
    for (const oid of closure.unshallowed) parts.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
    parts.push(pktLine(Buffer.from('NAK\n', 'utf8')));
    parts.push(...sidebandWrap(pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

/** Handle a POST to git-upload-pack (v2 command or v0 fetch). Returns the response body. */
export function uploadPack(repo: Repo, body: Buffer, protocolV2: boolean): Buffer {
  const reader = new PktReader(body);
  if (protocolV2) {
    const { command, args } = parseV2Request(reader);
    if (command === 'ls-refs') return lsRefs(repo, args);
    if (command === 'fetch') {
      const fetch: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
      for (const line of args) {
        if (line.startsWith('want ')) fetch.wants.push(line.slice(5, 45));
        else if (line.startsWith('have ')) fetch.haves.push(line.slice(5, 45));
        else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8, 48));
        else if (line.startsWith('deepen ')) fetch.depth = parseInt(line.slice(7), 10);
        else if (line === 'done') fetch.done = true;
      }
      return fetchResponse(repo, fetch, true);
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  const args = parseV0Fetch(reader);
  return fetchResponse(repo, args, false);
}

// ------------------------------------------------------------------ receive-pack

export interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle a POST to git-receive-pack. Returns the side-banded report-status body. */
export function receivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const updates: RefUpdate[] = [];
  let capabilities = '';
  for (;;) {
    const item = reader.next();
    if (item === undefined || item === 'flush') break;
    if (item === 'delim' || item === 'end') continue;
    let line = item.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = reader.rest();
  let unpackOk = true;
  const received = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const entries = parsePack(packBytes, (oid) => repo.getObject(oid));
      for (const entry of entries) received.set(entry.oid, { type: entry.type, data: entry.data });
    } catch {
      unpackOk = false;
    }
  }
  // Objects from the pack become visible for ancestry checks, then stay in the store.
  const hadObject = (oid: string): boolean => repo.objects.has(oid) || received.has(oid);
  const getAny = (oid: string): GitObject | undefined => repo.getObject(oid) ?? received.get(oid);
  const isAncestor = (ancestor: string, descendant: string): boolean => {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const obj = getAny(current);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  };
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const update of updates) {
    const current = repo.refs.get(update.ref) ?? ZERO_OID;
    let ok = true;
    let reason: string | undefined;
    if (!unpackOk) {
      ok = false;
      reason = 'unpacker error';
    } else if (update.newOid === ZERO_OID) {
      ok = current !== ZERO_OID || update.oldOid === ZERO_OID;
      if (!ok) reason = 'non-fast-forward';
    } else if (!hadObject(update.newOid)) {
      ok = false;
      reason = 'missing object';
    } else if (update.oldOid !== ZERO_OID && update.oldOid !== current) {
      ok = false;
      reason = 'non-fast-forward';
    } else if (current !== ZERO_OID && update.oldOid !== ZERO_OID) {
      // An update must move the ref forward along history (through tags to their commits).
      const from = peelWith(getAny, current);
      const to = peelWith(getAny, update.newOid);
      if (from && to && from !== to && !isAncestor(from, to)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    results.push({ ref: update.ref, ok, reason });
    if (ok) {
      if (update.newOid === ZERO_OID) repo.refs.delete(update.ref);
      else repo.refs.set(update.ref, update.newOid);
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of received) repo.putObjectWithId(oid, obj.type, obj.data);
  }
  // The report: pkt-framed lines inside side-band 1, when the client asked for the band.
  const reportParts: Buffer[] = [pktLine(Buffer.from(`unpack ${unpackOk ? 'ok' : 'error'}\n`, 'utf8'))];
  for (const result of results) {
    reportParts.push(pktLine(Buffer.from(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'error'}\n`, 'utf8')));
  }
  reportParts.push(FLUSH);
  const report = Buffer.concat(reportParts);
  if (capabilities.includes('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 65516 - 1;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
    }
    packets.push(FLUSH);
    return Buffer.concat(packets);
  }
  return report;
}

/** Peel through tag objects using an arbitrary object source. */
function peelWith(get: (oid: string) => GitObject | undefined, oid: string): string | undefined {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = get(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') { current = tagTarget(obj.data); continue; }
    return undefined;
  }
  return undefined;
}
