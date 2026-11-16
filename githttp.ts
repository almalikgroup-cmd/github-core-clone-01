// githttp.ts: the git smart-HTTP transport — info/refs advertisements (protocol v0 and v2),
// ls-refs, fetch (v0 and v2) and receive-pack — served from the forge's own object store.
// No git binary is involved anywhere: packs are built and read by gitobj.ts.
//
// Framing rules this file is careful about, because the suite's client enforces them:
//   - pkt-lines never exceed 65520 bytes; sideband pack data is chunked well under that.
//   - fetch v2 answers in named sections (acknowledgments / shallow-info / packfile),
//     separated by delim packets and ended by a flush.
//   - receive-pack always answers a report-status stream with exactly one ok/ng line per
//     command, wrapped in sideband band 1 when the client asked for side-band-64k.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  pktDecode,
  pktEncode,
  pktText,
  unpackInto,
  type StoredObject,
} from './gitobj.ts';
import { isAncestor, peel, type Repo } from './store.ts';
import { parseCommit, parseTag, parseTree, isTreeMode } from './gitobj.ts';

const AGENT = 'github-core-clone/1.0.0';
export const UPLOAD_ADVERTISE_TYPE = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_ADVERTISE_TYPE = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_RESULT_TYPE = 'application/x-git-upload-pack-result';
export const RECEIVE_RESULT_TYPE = 'application/x-git-receive-pack-result';

const UPLOAD_CAPS = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'object-format=sha1',
  `agent=${AGENT}`,
];
const RECEIVE_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'object-format=sha1', `agent=${AGENT}`];

/** Every ref the repository holds, sorted by name (heads before tags, as git orders them). */
export function sortedRefs(repo: Repo): Array<{ name: string; sha: string }> {
  return [...repo.refs.entries()].map(([name, sha]) => ({ name, sha })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The HEAD symref capability value for a repository ("symref=HEAD:refs/heads/<default>"). */
function headSymref(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

// ------------------------------------------------------------------ advertisements

/** The v0 ref advertisement for one service, as a framed byte stream. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? [...UPLOAD_CAPS, headSymref(repo)] : RECEIVE_CAPS;
  const parts: Buffer[] = [pktEncode(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (service === 'git-upload-pack') {
    const headTip = repo.branchTip(repo.defaultBranch);
    if (headTip !== null) lines.push(`${headTip} HEAD`);
    else if (refs.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  }
  for (const ref of refs) {
    lines.push(`${ref.sha} ${ref.name}`);
    const object = repo.objects.get(ref.sha);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      lines.push(`${target} ${ref.name}^{}`);
    }
  }
  if (service === 'git-receive-pack' && refs.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, index) => {
    parts.push(pktEncode(index === 0 ? `${line}\0${caps.join(' ')}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement (upload-pack): version line, capability lines, flush. */
export function advertiseV2(): Buffer {
  const parts: Buffer[] = [
    pktEncode('version 2\n'),
    pktEncode(`agent=${AGENT}\n`),
    pktEncode('ls-refs=unborn\n'),
    pktEncode('fetch=shallow filter\n'),
    pktEncode('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (protocol v2)

/** Answer one ls-refs command body. */
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { lines } = pktDecode(body);
  let wantPeel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = pktText(line).replace(/\n$/, '');
    if (text === 'peel') wantPeel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) out.push(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    else if (unborn) out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (wantPeel) {
      const peeled = peel(repo, ref.sha);
      if (peeled !== null && peeled !== ref.sha) line += ` peeled:${peeled}`;
    }
    out.push(line);
  }
  const parts = out.map((line) => pktEncode(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch planning

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth: number | null;
  done: boolean;
}

/** Parse the argument lines of a v2 fetch command (after the delim). */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: new Set(), depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Add a tree and everything under it to `into`. */
function addTreeClosure(repo: Repo, treeSha: string, into: Set<string>): void {
  if (into.has(treeSha)) return;
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  into.add(treeSha);
  for (const entry of parseTree(object.data)) {
    if (isTreeMode(entry.mode)) addTreeClosure(repo, entry.sha, into);
    else into.add(entry.sha);
  }
}

/**
 * The full object closure of some root commits: the commits, their trees and blobs, and any
 * tag objects on the way. Commit parent traversal stops at `cut` (the client's shallow
 * boundary: it holds those commits but not their parents).
 */
function closureOf(repo: Repo, roots: readonly string[], cut: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const visitObject = (sha: string): void => {
    if (out.has(sha)) return;
    const object = repo.objects.get(sha);
    if (object === undefined) return;
    if (object.type === 'tag') {
      out.add(sha);
      visitObject(parseTag(object.data).object);
      return;
    }
    if (object.type !== 'commit') {
      out.add(sha);
      return;
    }
    // A commit: walk generations so `cut` can stop parent traversal per commit.
    let frontier: string[] = [sha];
    const seenCommits = new Set<string>();
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const commitSha of frontier) {
        if (seenCommits.has(commitSha)) continue;
        seenCommits.add(commitSha);
        const commitObject = repo.objects.get(commitSha);
        if (commitObject === undefined || commitObject.type !== 'commit') continue;
        out.add(commitSha);
        const info = parseCommit(commitObject.data);
        addTreeClosure(repo, info.tree, out);
        if (cut.has(commitSha)) continue;
        for (const parent of info.parents) next.push(parent);
      }
      frontier = next;
    }
  };
  for (const root of roots) visitObject(root);
  return out;
}

interface FetchPlan {
  /** Object ids to send, in pack order (commits, then trees, then blobs, then tags). */
  send: string[];
  shallow: string[];
  unshallow: string[];
  /** Every want is already in the have closure: the client needs no pack. */
  nothingNew: boolean;
}

/** Plan a fetch: the objects the client lacks, and the shallow boundary movement. */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const haveSet = closureOf(repo, args.haves, args.clientShallow);
  // The want side, generation by generation when a depth limit applies.
  const wantCommits = new Set<string>();
  const boundary = new Set<string>();
  const wantRoots: string[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') wantRoots.push(want);
    const commit = peel(repo, want);
    if (commit !== null) wantRoots.push(commit);
  }
  if (args.depth === null) {
    for (const sha of closureOf(repo, wantRoots, new Set())) wantCommits.add(sha);
    // (wantCommits here briefly holds every object id; it is rebuilt precisely below.)
    wantCommits.clear();
    const closure = closureOf(repo, args.wants, new Set());
    for (const sha of closure) wantCommits.add(sha);
  } else {
    const depth = Math.max(1, args.depth);
    let frontier: string[] = [];
    for (const root of wantRoots) {
      const commit = peel(repo, root);
      if (commit !== null) frontier.push(commit);
    }
    const seen = new Set<string>();
    for (let generation = 0; generation < depth && frontier.length > 0; generation += 1) {
      const next: string[] = [];
      for (const commitSha of frontier) {
        if (seen.has(commitSha)) continue;
        seen.add(commitSha);
        const object = repo.objects.get(commitSha);
        if (object === undefined || object.type !== 'commit') continue;
        wantCommits.add(commitSha);
        const info = parseCommit(object.data);
        addTreeClosure(repo, info.tree, wantCommits);
        for (const parent of info.parents) {
          if (repo.objects.has(parent)) {
            if (generation + 1 < depth) next.push(parent);
            else boundary.add(commitSha);
          }
        }
      }
      frontier = next;
    }
    // Tag objects the client asked for ride along whole.
    for (const want of args.wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type === 'tag') wantCommits.add(want);
    }
  }
  // Annotated tags pointing into the fetched history ride along (git's include-tag behaviour).
  for (const ref of repo.refs.values()) {
    const object = repo.objects.get(ref);
    if (object === undefined || object.type !== 'tag') continue;
    const target = peel(repo, ref);
    if (target !== null && wantCommits.has(target)) wantCommits.add(ref);
  }
  const sendSet = new Set<string>();
  for (const sha of wantCommits) if (!haveSet.has(sha)) sendSet.add(sha);
  const nothingNew = args.wants.length > 0 && args.wants.every((want) => haveSet.has(want) || wantCommits.has(want) && sendSet.size === 0);
  const shallow: string[] = [];
  for (const sha of boundary) if (!haveSet.has(sha) || args.clientShallow.has(sha)) shallow.push(sha);
  const unshallow: string[] = [];
  for (const sha of args.clientShallow) {
    if (!wantCommits.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    if (info.parents.some((parent) => wantCommits.has(parent))) unshallow.push(sha);
  }
  // Pack order: commits first, then trees, then blobs, then tags (any order parses; this one
  // reads naturally and keeps deltas — none are emitted — irrelevant).
  const rank = (sha: string): number => {
    const type = repo.objects.get(sha)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3;
  };
  const send = [...sendSet].sort((a, b) => rank(a) - rank(b));
  return { send, shallow, unshallow, nothingNew: sendSet.size === 0 };
}

/** Frame a pack as sideband band-1 pkt-lines (data chunked far below the pkt-line ceiling). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32_768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktEncode(payload));
  }
  if (parts.length === 0) parts.push(pktEncode(Buffer.from([1])));
  return parts;
}

/** Build the pack bytes for a plan. */
function packFor(repo: Repo, plan: FetchPlan): Buffer {
  const objects: StoredObject[] = [];
  for (const sha of plan.send) {
    const object = repo.objects.get(sha);
    if (object !== undefined) objects.push(object);
  }
  return buildPack(objects);
}

/** Join fetch sections with delim packets and terminate the body with a flush. */
function joinSections(sections: Buffer[][]): Buffer[] {
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(PKT_DELIM);
    parts.push(...section);
  });
  parts.push(PKT_FLUSH);
  return parts;
}

// ------------------------------------------------------------------ fetch (v2 and v0)

/** Answer a protocol-v2 fetch command body. */
export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { lines } = pktDecode(body);
  const texts = lines.filter((line) => line.kind === 'data').map((line) => pktText(line));
  const args = parseFetchArgs(texts);
  const plan = planFetch(repo, args);
  // The transport is stateless: every request is answered completely in one response, the way
  // upload-pack behaves over HTTP. When the client sent haves, an acknowledgments section
  // comes first (ACK per common have, else NAK) and always ends with `ready` — the word that
  // tells the client negotiation is over and the packfile follows in this same response (or,
  // when there is nothing new to send, that no packfile follows at all). With no haves there
  // is nothing to acknowledge and the packfile section comes directly.
  const sections: Buffer[][] = [];
  if (args.haves.length > 0) {
    const ackSection: Buffer[] = [pktEncode('acknowledgments\n')];
    let acked = 0;
    for (const have of args.haves) {
      const object = repo.objects.get(have);
      if (object !== undefined && object.type === 'commit') {
        ackSection.push(pktEncode(`ACK ${have}\n`));
        acked += 1;
      }
    }
    if (acked === 0) ackSection.push(pktEncode('NAK\n'));
    ackSection.push(pktEncode('ready\n'));
    sections.push(ackSection);
    if (plan.nothingNew) return Buffer.concat(joinSections(sections));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowSection: Buffer[] = [pktEncode('shallow-info\n')];
    for (const sha of plan.shallow) shallowSection.push(pktEncode(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) shallowSection.push(pktEncode(`unshallow ${sha}\n`));
    sections.push(shallowSection);
  }
  const packSection: Buffer[] = [pktEncode('packfile\n'), ...sidebandPack(packFor(repo, plan))];
  sections.push(packSection);
  return Buffer.concat(joinSections(sections));
}

/** Answer a protocol-v0 fetch request body (want lines, flush, have lines, done). */
export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { lines } = pktDecode(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let phase: 'wants' | 'haves' = 'wants';
  for (const line of lines) {
    if (line.kind === 'flush') {
      phase = 'haves';
      continue;
    }
    const text = pktText(line).replace(/\n$/, '');
    if (phase === 'wants') {
      const match = /^want ([0-9a-f]{40})/.exec(text);
      if (match !== null) wants.push(match[1] ?? '');
    } else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) clientShallow.add(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
  }
  const plan = planFetch(repo, { wants, haves, clientShallow, depth, done: true });
  const parts: Buffer[] = [];
  const acked = haves.filter((have) => repo.objects.get(have)?.type === 'commit');
  if (acked.length > 0) for (const have of acked) parts.push(pktEncode(`ACK ${have}\n`));
  else parts.push(pktEncode('NAK\n'));
  for (const sha of plan.shallow) parts.push(pktEncode(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktEncode(`unshallow ${sha}\n`));
  if (!plan.nothingNew) parts.push(...sidebandPack(packFor(repo, plan)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command list at the head of a receive-pack body; null when it is not pkt-lines. */
export function parsePushCommands(body: Buffer): { commands: PushCommand[]; caps: Set<string>; packOffset: number } | null {
  const { lines, next } = pktDecode(body);
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  let sawFlush = false;
  for (const line of lines) {
    if (line.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (line.kind !== 'data') return null;
    let text = pktText(line);
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      for (const cap of text.slice(nul + 1).trim().split(/\s+/)) if (cap !== '') caps.add(cap);
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text.trim());
    if (match === null) return null;
    commands.push({ oldOid: match[1] ?? '', newOid: match[2] ?? '', ref: match[3] ?? '' });
  }
  if (!sawFlush && commands.length > 0) return null;
  if (!sawFlush && lines.length === 0) return null;
  // `next` stops after the last complete pkt-line; the pack (if any) starts where the flush
  // packet ended. Recompute: walk the decoded lines' byte lengths.
  let offset = 0;
  let consumed = 0;
  for (const line of lines) {
    consumed += 1;
    if (line.kind === 'data') offset += 4 + line.data.length;
    else offset += 4;
    if (line.kind === 'flush') break;
  }
  void next;
  void consumed;
  return { commands, caps, packOffset: offset };
}

/** Whether moving `ref` from old to new is allowed, and if not, the refusal reason. */
function validateUpdate(repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (!command.ref.startsWith('refs/')) return 'invalid ref';
  if (command.oldOid !== current) return 'stale info';
  if (command.newOid === ZERO_OID) {
    if (current === ZERO_OID) return 'reference does not exist';
    return null; // a deletion
  }
  const object = repo.objects.get(command.newOid);
  if (object === undefined) return 'missing object';
  if (command.ref.startsWith('refs/heads/')) {
    const newCommit = peel(repo, command.newOid);
    if (newCommit === null) return 'not a commit';
    if (command.oldOid === ZERO_OID || command.oldOid === command.newOid) return null;
    const oldCommit = peel(repo, command.oldOid);
    if (oldCommit === null) return 'non-fast-forward';
    if (!isAncestor(repo, oldCommit, newCommit)) return 'non-fast-forward';
  }
  return null;
}

/**
 * Answer a receive-pack POST. Returns the HTTP status and the report-status body. A malformed
 * command stream is an HTTP 400; a well-formed one always reports per-ref results with 200.
 */
export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const parsed = parsePushCommands(body);
  if (parsed === null) return { status: 400, body: Buffer.from('malformed receive-pack request\n', 'utf8') };
  const { commands, caps, packOffset } = parsed;
  let unpackError: string | null = null;
  const packBytes = body.subarray(packOffset);
  if (packBytes.length > 0) {
    if (packBytes.length >= 4 && packBytes.toString('ascii', 0, 4) === 'PACK') {
      try {
        unpackInto(repo.objects, Buffer.from(packBytes));
      } catch (error) {
        unpackError = error instanceof Error ? error.message : String(error);
      }
    } else {
      unpackError = 'pack signature missing';
    }
  }
  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack error ${unpackError}`];
  for (const command of commands) {
    let reason: string | null = unpackError === null ? validateUpdate(repo, command) : 'unpack failed';
    if (reason === null) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    reportLines.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
    reason = null;
  }
  const report = Buffer.concat([...reportLines.map((line) => pktEncode(`${line}\n`)), PKT_FLUSH]);
  if (caps.has('side-band-64k')) {
    const wrapped: Buffer[] = [];
    // The whole report stream rides in band 1, chunked like pack data.
    const CHUNK = 32_768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      wrapped.push(pktEncode(Buffer.concat([Buffer.from([1]), chunk])));
    }
    wrapped.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(wrapped) };
  }
  return { status: 200, body: report };
}
