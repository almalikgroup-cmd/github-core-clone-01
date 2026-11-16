// store.ts: the forge's state — repositories, their object databases and refs, and the issue /
// pull-request / label / comment records the REST, GraphQL and MCP surfaces all share. One
// in-memory store per process: a trial is one fresh process, and the rules keep the runtime
// filesystem read-only, so nothing persists to disk.
//
// Determinism: every timestamp the forge emits derives from MAKEFUN_TRIAL_NOW plus a counter,
// never from the wall clock, so a replayed trial produces byte-identical output.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTree,
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type CommitInfo,
  type TreeEntry,
} from './gitobj.ts';

/** The scenario's viewer: the token's owner, fixed by the sealed scenario. */
export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' } as const;

/** Parse MAKEFUN_TRIAL_NOW (ISO text or epoch seconds/ms) into epoch milliseconds. */
function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1_700_000_000_000;
}

/** A deterministic clock: the trial's opening time, advanced one second per reading. */
export class ForgeClock {
  private baseMs: number;
  private ticks = 0;

  constructor() {
    this.baseMs = trialNowMs();
  }

  /** The next timestamp, epoch seconds (git objects) — strictly increasing per call. */
  nowSec(): number {
    const value = Math.floor(this.baseMs / 1000) + this.ticks;
    this.ticks += 1;
    return value;
  }

  /** An ISO-8601 timestamp for JSON surfaces, from the same tick sequence. */
  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** The head and base tips when the pull request was opened: the merge base and diff base. */
  headShaAtCreate: string;
  baseShaAtCreate: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  comments: CommentRec[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export type NumberedRec = IssueRec | PullRec;

export class Repo {
  readonly objects = new ObjectStore();
  /** Full ref name ("refs/heads/main") -> object id. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  readonly numbered = new Map<number, NumberedRec>();
  nextNumber = 1;

  readonly dbId: number;
  readonly owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;

  constructor(dbId: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string, createdAt: string) {
    this.dbId = dbId;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
  }

  /** The object id a branch points at, or null when the branch does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit the default branch names, or null while the repository is unborn. */
  headCommit(): string | null {
    const tip = this.branchTip(this.defaultBranch);
    return tip === null ? null : peelToCommit(this.objects, tip);
  }
}

export class Forge {
  readonly clock = new ForgeClock();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRecordId = 1;
  private nextCommentId = 1;
  private seq = 0;

  /** The next creation-order sequence number (issues, pulls, comments sort by it). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextRecordIdValue(): number {
    const value = this.nextRecordId;
    this.nextRecordId += 1;
    return value;
  }

  nextCommentIdValue(): number {
    const value = this.nextCommentId;
    this.nextCommentId += 1;
    return value;
  }

  /** Create a repository owned by the viewer; null when the name is taken. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, VIEWER.login, name, description, isPrivate, 'main', this.clock.nowIso());
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** Look a repository up by owner and name; only the viewer's own repositories exist. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }
}

// ------------------------------------------------------------------ history walks

/** Every commit reachable from `tip`, newest generation first (breadth-first over parents). */
export function reachableCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier: string[] = [tip];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (seen.has(sha)) continue;
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(sha);
      order.push(sha);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return order;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  let frontier: string[] = [descendant];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return false;
}

/** A common ancestor of two commits (the merge base), or null when histories are unrelated. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = new Set(reachableCommits(repo, a));
  for (const candidate of reachableCommits(repo, b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

/** The commit info for an object id, or null when it is not a commit in the store. */
export function commitInfo(repo: Repo, sha: string): CommitInfo | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

// ------------------------------------------------------------------ tree flattening and editing

/** Flatten a tree (recursively) into path -> {sha, mode}; empty map for a missing tree. */
export function flattenTree(repo: Repo, treeSha: string | null): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, prefix: string): void => {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) walk(entry.sha, path);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  };
  if (treeSha !== null) walk(treeSha, '');
  return out;
}

/** The root tree id of a commit, or null. */
export function treeOfCommit(repo: Repo, commitSha: string | null): string | null {
  if (commitSha === null) return null;
  const info = commitInfo(repo, commitSha);
  return info === null ? null : info.tree;
}

/**
 * Write `blobSha` at `path` inside the tree `treeSha` (or an empty tree), creating intermediate
 * trees; returns the new root tree id. With `blobSha` null the path is removed (and emptied
 * directories pruned), which is how the contents API deletes a file.
 */
export function treeWithPath(repo: Repo, treeSha: string | null, path: string, blobSha: string | null, mode = '100644'): string {
  const parts = path.split('/').filter((part) => part !== '');
  const write = (currentTree: string | null, depth: number): string => {
    const entries: TreeEntry[] = currentTree === null ? [] : parseTree(repo.objects.get(currentTree)?.data ?? Buffer.alloc(0));
    const name = parts[depth] ?? '';
    const index = entries.findIndex((entry) => entry.name === name);
    if (depth === parts.length - 1) {
      if (blobSha === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode, name, sha: blobSha };
      } else {
        entries.push({ mode, name, sha: blobSha });
      }
    } else {
      const childTree = index >= 0 && isTreeMode(entries[index]?.mode ?? '') ? (entries[index]?.sha ?? null) : null;
      const newChild = write(childTree, depth + 1);
      if (index >= 0) entries[index] = { mode: '40000', name, sha: newChild };
      else entries.push({ mode: '40000', name, sha: newChild });
    }
    return repo.objects.put('tree', buildTree(entries));
  };
  return write(treeSha, 0);
}

/** One directory level of a tree: the entries at `dirPath` ('' for the root), or null. */
export function listTreeLevel(repo: Repo, treeSha: string | null, dirPath: string): TreeEntry[] | null {
  if (treeSha === null) return null;
  if (dirPath === '') {
    const object = repo.objects.get(treeSha);
    return object === undefined ? null : parseTree(object.data);
  }
  const parts = dirPath.split('/');
  let current: string | null = treeSha;
  for (const part of parts) {
    if (current === null) return null;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part);
    if (entry === undefined || !isTreeMode(entry.mode)) return null;
    current = entry.sha;
  }
  if (current === null) return null;
  const object = repo.objects.get(current);
  return object === undefined ? null : parseTree(object.data);
}

/** The blob entry at `path` under a tree, or null. */
export function blobAtPath(repo: Repo, treeSha: string | null, path: string): { sha: string; mode: string } | null {
  return flattenTree(repo, treeSha).get(path) ?? null;
}

// ------------------------------------------------------------------ commits the forge authors

/** Commit `newTree` on `branch`, parented on the branch's current tip; returns the commit id. */
export function commitOnBranch(forge: Forge, repo: Repo, branch: string, newTree: string, message: string): string {
  const tip = repo.branchTip(branch);
  const parent = tip === null ? null : peelToCommit(repo.objects, tip);
  const data = buildCommit({
    tree: newTree,
    parents: parent === null ? [] : [parent],
    name: VIEWER.name,
    email: VIEWER.email,
    timeSec: forge.clock.nowSec(),
    message,
  });
  const sha = repo.objects.put('commit', data);
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}

// ------------------------------------------------------------------ line diffs and merges

/** Split text into lines for diffing; a trailing newline does not make a phantom empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts (LCS based; the files the suite diffs are small). */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const common = dp[0]![0] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

/** The file changes between two commits' trees (the pull-request files view). */
export function diffTrees(repo: Repo, baseCommit: string | null, headCommit: string | null): FileChange[] {
  const base = flattenTree(repo, treeOfCommit(repo, baseCommit));
  const head = flattenTree(repo, treeOfCommit(repo, headCommit));
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before.sha)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after.sha)?.data.toString('utf8') ?? '');
    const counts = diffCounts(oldText, newText);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

/**
 * A three-way tree merge for a squash: apply the (base -> head) changes onto the current base
 * branch tree. Returns the merged tree id, or null when both sides changed one path to
 * different results (a conflict).
 */
export function threeWayMergeTrees(repo: Repo, mergeBaseCommit: string | null, oursCommit: string | null, theirsCommit: string | null): string | null {
  const base = flattenTree(repo, treeOfCommit(repo, mergeBaseCommit));
  const ours = flattenTree(repo, treeOfCommit(repo, oursCommit));
  const theirs = flattenTree(repo, treeOfCommit(repo, theirsCommit));
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  let mergedTree: string | null = treeOfCommit(repo, oursCommit);
  const result = new Map<string, { sha: string; mode: string }>(ours);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameSha = (x?: { sha: string }, y?: { sha: string }): boolean => x?.sha === y?.sha;
    if (sameSha(o, t)) {
      // Both sides agree (including both deleted): ours already holds the answer.
      continue;
    }
    if (sameSha(b, o)) {
      // Only theirs changed it.
      if (t === undefined) result.delete(path);
      else result.set(path, t);
      continue;
    }
    if (sameSha(b, t)) {
      // Only ours changed it: ours already holds the answer.
      continue;
    }
    return null;
  }
  // Rebuild the tree from the merged flat map.
  let root: string | null = null;
  const sortedPaths = [...result.keys()].sort();
  for (const path of sortedPaths) {
    const entry = result.get(path);
    if (entry === undefined) continue;
    root = treeWithPath(repo, root, path, entry.sha, entry.mode);
  }
  if (root === null) root = repo.objects.put('tree', buildTree([]));
  mergedTree = root;
  return mergedTree;
}

/** Peel a ref value through tags for display (branch tips are commits already in practice). */
export function peel(repo: Repo, sha: string): string | null {
  return peelToCommit(repo.objects, sha);
}

export { ZERO_OID, parseTag };
