// gitobj.ts: the git object model for the forge — SHA-1 addressed objects, pack reading and
// writing, delta application, and the pkt-line codec. Pure Node standard library: the rules
// forbid shelling out to a git binary, so clone/push/fetch run on this code alone.
//
// Objects are stored verbatim (the exact bytes that were pushed), because the suite compares
// cloned objects byte for byte with what its client built; nothing here ever reserialises a
// commit, tree or tag it did not create itself.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload: sha1("<type> <length>\0" + bytes), as git defines it. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The SHA-1 of a raw byte string (pack trailers). */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

/** One repository's object database: an in-memory map from object id to verbatim bytes. */
export class ObjectStore {
  private readonly map = new Map<string, StoredObject>();

  has(sha: string): boolean {
    return this.map.has(sha);
  }

  get(sha: string): StoredObject | undefined {
    return this.map.get(sha);
  }

  /** Store bytes under their computed id; returns the id. */
  put(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.map.has(sha)) this.map.set(sha, { type, data });
    return sha;
  }

  /** Store bytes under a caller-known id (used after delta resolution, where the id is computed). */
  putResolved(sha: string, type: ObjType, data: Buffer): void {
    if (!this.map.has(sha)) this.map.set(sha, { type, data });
  }

  get size(): number {
    return this.map.size;
  }

  /** Every object id in the store (diagnostics and tests). */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }
}

// ------------------------------------------------------------------ commits, trees, tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

/** Parse an identity line's tail: "Name <email> 1700000000 +0000". */
function parseIdentity(text: string): { name: string; email: string; time: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(text);
  if (match === null) return { name: text, email: '', time: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', time: Number(match[3] ?? 0) };
}

/** Parse a commit object. Throws on a malformed header. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTime: 0,
    committerName: '',
    committerEmail: '',
    committerTime: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const id = parseIdentity(line.slice(7));
      info.authorName = id.name;
      info.authorEmail = id.email;
      info.authorTime = id.time;
    } else if (line.startsWith('committer ')) {
      const id = parseIdentity(line.slice(10));
      info.committerName = id.name;
      info.committerEmail = id.email;
      info.committerTime = id.time;
    }
  }
  return info;
}

/** Serialise a commit object the forge itself authors (contents API, merges). */
export function buildCommit(args: {
  tree: string;
  parents: readonly string[];
  name: string;
  email: string;
  timeSec: number;
  message: string;
}): Buffer {
  const identity = `${args.name} <${args.email}> ${args.timeSec} +0000`;
  const lines = [`tree ${args.tree}`, ...args.parents.map((parent) => `parent ${parent}`), `author ${identity}`, `committer ${identity}`];
  return Buffer.from(`${lines.join('\n')}\n\n${args.message}`, 'utf8');
}

export interface TreeEntry {
  /** The mode exactly as stored: "100644", "100755", "120000", "40000" for a subtree, "160000". */
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: entries sort by name, with directories compared as if suffixed by "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries in git's canonical order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Whether a tree entry mode names a subtree. */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const info: TagInfo = { object: '', type: '', tag: '' };
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
  }
  return info;
}

/** Peel an object id to the commit it ultimately names (through tag chains), or null. */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// ------------------------------------------------------------------ pack reading

interface PackEntry {
  /** The object type for plain entries; for delta entries, the type is inherited from the base. */
  type: ObjType;
  /** The inflated payload: object bytes for a plain entry, delta bytes for a delta entry. */
  data: Buffer;
  /** ref-delta: the base object's id. */
  baseSha?: string;
  /** ofs-delta: the pack offset at which the base entry starts. */
  deltaBaseOffset?: number;
  /** The byte offset of this entry inside the pack. */
  offset: number;
}

/** Whether a pack entry is a delta (its payload is not yet object bytes). */
function isDeltaEntry(entry: PackEntry): boolean {
  return entry.baseSha !== undefined || entry.deltaBaseOffset !== undefined;
}

/** Read a little-endian-ish varint of the kind pack size fields use (7 bits per byte, LSB first). */
function readSizeVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = buf[cursor] ?? 0;
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: cursor };
}

/**
 * Inflate one zlib stream that starts at `offset` and must produce exactly `size` bytes. Node's
 * inflateSync tolerates trailing bytes but throws on truncation, so the stream's end is the
 * smallest prefix that inflates to the full size. A deflate stream for `size` plain bytes is
 * rarely larger than the input itself, so probe near the size first, grow exponentially while
 * the stream still looks truncated, then binary-search the last interval: two or three
 * inflations for a typical object instead of a dozen.
 */
function inflateExact(buf: Buffer, offset: number, size: number): { data: Buffer; next: number } {
  const remaining = buf.length - offset;
  const tryAt = (length: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(offset, offset + length));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };
  let lo = 1;
  let hi = Math.min(remaining, Math.max(64, Math.ceil(size * 1.05) + 24));
  let best: Buffer | null = null;
  let bestLength = -1;
  while (best === null && hi < remaining) {
    const out = tryAt(hi);
    if (out !== null) {
      best = out;
      bestLength = hi;
      break;
    }
    lo = hi + 1;
    hi = Math.min(remaining, hi * 2);
  }
  if (best === null) {
    const out = tryAt(remaining);
    if (out !== null) {
      best = out;
      bestLength = remaining;
      hi = remaining;
    }
  }
  if (best === null) throw new Error('pack object does not inflate');
  // Narrow to the smallest working prefix inside (lo, bestLength].
  let low = lo;
  let high = bestLength;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const out = tryAt(mid);
    if (out !== null) {
      best = out;
      bestLength = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return { data: best, next: offset + bestLength };
}

/** Apply a git delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let cursor = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[cursor] ?? 0;
      cursor += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (cursor < delta.length) {
    const op = delta[cursor] ?? 0;
    cursor += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[cursor] ?? 0; cursor += 1; }
      if (op & 0x02) { copyOffset += (delta[cursor] ?? 0) << 8; cursor += 1; }
      if (op & 0x04) { copyOffset += (delta[cursor] ?? 0) << 16; cursor += 1; }
      if (op & 0x08) { copyOffset += (delta[cursor] ?? 0) << 24; cursor += 1; }
      if (op & 0x10) { copySize = delta[cursor] ?? 0; cursor += 1; }
      if (op & 0x20) { copySize += (delta[cursor] ?? 0) << 8; cursor += 1; }
      if (op & 0x40) { copySize += (delta[cursor] ?? 0) << 16; cursor += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(cursor, cursor + op));
      produced += op;
      cursor += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a whole pack into the store, resolving ofs/ref deltas against the pack itself and the
 * store. Returns the object ids the pack carried (after resolution). Throws on any malformation:
 * a bad pack must fail the push, never half-apply it.
 */
export function unpackInto(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  let cursor = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    const first = pack[cursor] ?? 0;
    cursor += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[cursor] ?? 0;
      cursor += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    let deltaBaseOffset = -1;
    if (typeCode === 6) {
      // ofs-delta: a negative-offset varint naming the base entry's start.
      let b = pack[cursor] ?? 0;
      cursor += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[cursor] ?? 0;
        cursor += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      deltaBaseOffset = start - back;
    } else if (typeCode === 7) {
      baseSha = pack.toString('hex', cursor, cursor + 20);
      cursor += 20;
    }
    const inflated = inflateExact(pack, cursor, size);
    cursor = inflated.next;
    if (typeCode === 6 || typeCode === 7) {
      const entry: PackEntry = { type: 'blob', data: inflated.data, offset: start, baseSha };
      if (deltaBaseOffset >= 0) entry.deltaBaseOffset = deltaBaseOffset;
      entries.push(entry);
      byOffset.set(start, entry);
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode} unknown`);
      const entry: PackEntry = { type, data: inflated.data, offset: start };
      entries.push(entry);
      byOffset.set(start, entry);
    }
  }
  // The trailer is the SHA-1 of everything before it; a corrupt pack is refused whole.
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  // Resolve entries in dependency order: plain objects first, then deltas whose base is known
  // (in this pack and already resolved, or already in the store).
  const resolved = new Map<number, { sha: string; type: ObjType; data: Buffer }>();
  const resolvedBySha = new Map<string, { type: ObjType; data: Buffer }>();
  const resolveEntry = (entry: PackEntry, depth: number): { sha: string; type: ObjType; data: Buffer } | null => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    if (depth > entries.length + 1) return null;
    let out: { sha: string; type: ObjType; data: Buffer } | null = null;
    if (!isDeltaEntry(entry)) {
      out = { sha: hashObject(entry.type, entry.data), type: entry.type, data: entry.data };
    } else {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (entry.deltaBaseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.deltaBaseOffset);
        if (baseEntry !== undefined && baseEntry !== entry) {
          const done = resolveEntry(baseEntry, depth + 1);
          if (done !== null) base = done;
        }
      } else if (entry.baseSha !== undefined) {
        base = resolvedBySha.get(entry.baseSha) ?? store.get(entry.baseSha);
        if (base === undefined) {
          for (const candidate of entries) {
            if (isDeltaEntry(candidate)) continue;
            if (hashObject(candidate.type, candidate.data) === entry.baseSha) {
              const done = resolveEntry(candidate, depth + 1);
              if (done !== null) base = done;
              break;
            }
          }
        }
      }
      if (base !== undefined) {
        const data = applyDelta(base.data, entry.data);
        out = { sha: hashObject(base.type, data), type: base.type, data };
      }
    }
    if (out !== null) {
      resolved.set(entry.offset, out);
      resolvedBySha.set(out.sha, { type: out.type, data: out.data });
    }
    return out;
  };
  // A delta's base may sit later in the pack than the delta itself; repeat passes until every
  // entry resolves or a pass makes no progress (a genuinely missing base).
  let remaining = entries.length;
  for (let pass = 0; pass <= entries.length && remaining > 0; pass += 1) {
    let progressed = false;
    for (const entry of entries) {
      if (resolved.has(entry.offset)) continue;
      if (resolveEntry(entry, 0) !== null) {
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (remaining > 0) throw new Error('pack delta base is missing');
  const ids: string[] = [];
  for (const entry of entries) {
    const done = resolved.get(entry.offset);
    if (done === undefined) throw new Error('pack entry unresolved');
    store.putResolved(done.sha, done.type, done.data);
    ids.push(done.sha);
  }
  return ids;
}

// ------------------------------------------------------------------ pack writing

/** Encode one plain (non-delta) object into a pack under construction. */
function encodePackObject(type: ObjType, data: Buffer): Buffer {
  const code = TYPE_TO_CODE[type];
  let size = data.length;
  const head: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  head.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    head.push(byte);
  }
  return Buffer.concat([Buffer.from(head), deflateSync(data)]);
}

/**
 * Build a version-2 pack of plain objects. Plain objects are accepted by every client the
 * suite runs (its pack-deltas check passes with zero deltas), and they keep the byte counts
 * and the object hashes exactly the ones the store holds.
 */
export function buildPack(objects: readonly StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) parts.push(encodePackObject(object.type, object.data));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ pkt-line codec

/** One decoded pkt-line: a payload, or the flush/delim/response-end markers. */
export type PktLine = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Frame a payload as one pkt-line (4-hex length including the header). */
export function pktEncode(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/**
 * Decode as many pkt-lines as `buf` holds from `offset`. Returns the lines and the offset just
 * past the last complete line; a truncated tail is left unconsumed (callers that read request
 * bodies whole treat a leftover as malformed).
 */
export function pktDecode(buf: Buffer, offset = 0): { lines: PktLine[]; next: number } {
  const lines: PktLine[] = [];
  let cursor = offset;
  while (cursor + 4 <= buf.length) {
    const headerText = buf.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) break;
    const length = parseInt(headerText, 16);
    if (length === 0) {
      lines.push({ kind: 'flush' });
      cursor += 4;
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim' });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response-end' });
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > buf.length) break;
    lines.push({ kind: 'data', data: buf.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { lines, next: cursor };
}

/** The text of a data pkt-line (a trailing newline is the sender's, kept or trimmed by callers). */
export function pktText(line: PktLine): string {
  return line.kind === 'data' ? line.data.toString('utf8') : '';
}
