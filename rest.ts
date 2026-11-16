// rest.ts: the GitHub REST v3 surface — root, meta, user, repositories, contents, git data
// (refs, branches, commits), labels, issues, comments and pull requests. Every handler works
// on the shared Forge store, so an object created here is the same object the git transport,
// GraphQL and MCP surfaces see.
//
// Contract points the suite enforces and this file keeps:
//   - errors are JSON {"message": <non-empty string>} with GitHub's statuses (404 unknown,
//     422 validation, 409 stale contents sha, 405 unmergeable pull request);
//   - issues and pull requests share one per-repository number sequence;
//   - list endpoints honour per_page/page, and /user/repos paginates with a Link header whose
//     rel="next" URL stays on this origin.

import { ZERO_OID, hashObject } from './gitobj.ts';
import {
  VIEWER,
  blobAtPath,
  commitInfo,
  commitOnBranch,
  diffTrees,
  flattenTree,
  isAncestor,
  listTreeLevel,
  mergeBase,
  peel,
  reachableCommits,
  threeWayMergeTrees,
  treeOfCommit,
  treeWithPath,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { parseCommit } from './gitobj.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  /** Extra headers beside the JSON defaults. */
  headers?: Record<string, string>;
  /** A 204: no body at all. */
  empty?: boolean;
}

export interface RestRequest {
  method: string;
  /** The path after /api/v3, e.g. "/repos/adaiversen/x/issues" (no trailing slash). */
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
  /** True when a body was present but not valid JSON (a 400 on routes that read one). */
  malformedBody: boolean;
  /** The request's Host header, for building absolute Link URLs. */
  host: string;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });
const badRequest = (message: string): RestResult => ({ status: 400, body: { message } });

// ------------------------------------------------------------------ JSON views

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    fork: false,
    archived: false,
    disabled: false,
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? null, default: false };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function commentJson(comment: { id: number; body: string; authorLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.authorLogin, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const info = commitInfo(repo, sha);
  const dateOf = (timeSec: number): string => new Date(timeSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    sha,
    commit: {
      author: { name: info?.authorName ?? '', email: info?.authorEmail ?? '', date: dateOf(info?.authorTime ?? 0) },
      committer: { name: info?.committerName ?? '', email: info?.committerEmail ?? '', date: dateOf(info?.committerTime ?? 0) },
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? ZERO_OID },
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ small helpers

/** per_page/page slicing with GitHub's defaults (30 per page). */
function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; nextUrl: ((base: string) => string) | null } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let nextUrl: ((base: string) => string) | null = null;
  if (start + perPage < items.length) {
    nextUrl = (base: string): string => {
      const params = new URLSearchParams(query);
      params.set('per_page', String(perPage));
      params.set('page', String(page + 1));
      return `${base}?${params.toString()}`;
    };
  }
  return { page: slice, nextUrl };
}

/** Attach a Link header when a paginated list has a next page. */
function withLink(result: RestResult, req: RestRequest, nextUrl: ((base: string) => string) | null): RestResult {
  if (nextUrl === null) return result;
  const base = `http://${req.host}/api/v3${req.path}`;
  return { ...result, headers: { ...(result.headers ?? {}), link: `<${nextUrl(base)}>; rel="next"` } };
}

function bodyString(body: Record<string, unknown> | undefined, key: string): string | null {
  const value = body?.[key];
  return typeof value === 'string' ? value : null;
}

/** Decode a contents path's segments (the client encodes each segment separately). */
function decodePath(raw: string): string {
  return raw.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

// ------------------------------------------------------------------ route handlers

function handleRoot(): RestResult {
  return {
    status: 200,
    body: {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    },
    headers: { 'x-oauth-scopes': 'repo, read:org, write:org' },
  };
}

function handleMeta(): RestResult {
  return { status: 200, body: { installed_version: '3.14.0-forge.1', github_build_version: 'forge-1.0.0' } };
}

function handleUser(): RestResult {
  return {
    status: 200,
    body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false },
  };
}

function createRepository(forge: Forge, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const name = bodyString(req.body, 'name');
  if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return unprocessable('name is invalid');
  }
  const description = bodyString(req.body, 'description') ?? '';
  const isPrivate = req.body?.private === true;
  const repo = forge.createRepo(name, description, isPrivate);
  if (repo === null) return unprocessable('name already exists on this account');
  return { status: 201, body: repoJson(repo) };
}

function listUserRepos(forge: Forge, req: RestRequest): RestResult {
  const { page, nextUrl } = paginate(forge.listRepos(), req.query);
  return withLink({ status: 200, body: page.map(repoJson) }, req, nextUrl);
}

function getRepository(repo: Repo): RestResult {
  return { status: 200, body: repoJson(repo) };
}

function patchRepository(forge: Forge, repo: Repo, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const description = bodyString(req.body, 'description');
  if (description !== null) repo.description = description;
  if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
  const newName = bodyString(req.body, 'name');
  if (newName !== null && newName !== repo.name && /^[A-Za-z0-9._-]+$/.test(newName)) {
    const existing = forge.getRepo(repo.owner, newName);
    if (existing === null) {
      forge.repos.delete(`${repo.owner}/${repo.name}`);
      (repo as { name: string }).name = newName;
      forge.repos.set(`${repo.owner}/${newName}`, repo);
    }
  }
  return { status: 200, body: repoJson(repo) };
}

// ------------------------------------------------ contents

/** Resolve a ref parameter (branch name or commit id) to a commit, defaulting to HEAD. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.headCommit();
  const branchTip = repo.branchTip(ref);
  if (branchTip !== null) return peel(repo, branchTip);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    if (object !== undefined && object.type === 'tag') return peel(repo, ref);
  }
  return null;
}

function getContents(repo: Repo, path: string, req: RestRequest): RestResult {
  const commit = resolveRef(repo, req.query.get('ref'));
  if (commit === null) return notFound();
  const tree = treeOfCommit(repo, commit);
  if (path === '') {
    const entries = listTreeLevel(repo, tree, '');
    if (entries === null) return notFound();
    return { status: 200, body: entries.map((entry) => contentsEntry(repo, entry, '')) };
  }
  const blob = blobAtPath(repo, tree, path);
  if (blob !== null) {
    const object = repo.objects.get(blob.sha);
    if (object === undefined) return notFound();
    const name = path.split('/').pop() ?? path;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name,
        path,
        sha: blob.sha,
        content: object.data.toString('base64'),
      },
    };
  }
  const entries = listTreeLevel(repo, tree, path);
  if (entries !== null) {
    return { status: 200, body: entries.map((entry) => contentsEntry(repo, entry, path)) };
  }
  return notFound();
}

function contentsEntry(repo: Repo, entry: { mode: string; name: string; sha: string }, dir: string): Record<string, unknown> {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  const object = repo.objects.get(entry.sha);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: dir === '' ? entry.name : `${dir}/${entry.name}`,
    sha: entry.sha,
    size: isDir ? 0 : (object?.data.length ?? 0),
  };
}

function putContents(forge: Forge, repo: Repo, path: string, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const message = bodyString(req.body, 'message');
  const contentB64 = bodyString(req.body, 'content');
  if (message === null || contentB64 === null) return unprocessable('message and content are required');
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobSha = repo.objects.put('blob', bytes);
  const tip = repo.branchTip(branch);
  const tipCommit = tip === null ? repo.headCommit() : peel(repo, tip);
  const currentTree = treeOfCommit(repo, tipCommit);
  const existing = blobAtPath(repo, currentTree, path);
  const givenSha = bodyString(req.body, 'sha');
  if (existing !== null && givenSha !== null && givenSha !== existing.sha) {
    return { status: 409, body: { message: 'The sha parameter does not match the file on the branch' } };
  }
  const newTree = treeWithPath(repo, currentTree, path, blobSha);
  const commitSha = commitOnBranch(forge, repo, branch, newTree, message);
  const name = path.split('/').pop() ?? path;
  return {
    status: existing !== null ? 200 : 201,
    body: {
      content: { type: 'file', encoding: 'base64', size: bytes.length, name, path, sha: blobSha },
      commit: { sha: commitSha, message },
    },
  };
}

function deleteContents(forge: Forge, repo: Repo, path: string, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const message = bodyString(req.body, 'message');
  if (message === null) return unprocessable('message is required');
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const tip = repo.branchTip(branch);
  const tipCommit = tip === null ? null : peel(repo, tip);
  if (tipCommit === null) return notFound();
  const currentTree = treeOfCommit(repo, tipCommit);
  const existing = blobAtPath(repo, currentTree, path);
  if (existing === null) return notFound();
  const givenSha = bodyString(req.body, 'sha');
  if (givenSha !== null && givenSha !== existing.sha) {
    return { status: 409, body: { message: 'The sha parameter does not match the file on the branch' } };
  }
  const newTree = treeWithPath(repo, currentTree, path, null);
  const commitSha = commitOnBranch(forge, repo, branch, newTree, message);
  return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
}

// ------------------------------------------------ git data: refs, branches, commits

function createRef(repo: Repo, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const ref = bodyString(req.body, 'ref');
  const sha = bodyString(req.body, 'sha');
  if (ref === null || sha === null || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
  const object = repo.objects.get(sha);
  if (object === undefined) return unprocessable('sha does not name an object in the repository');
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, object: { sha, type: object.type } } };
}

function getRef(repo: Repo, refName: string): RestResult {
  const full = `refs/${refName}`;
  const sha = repo.refs.get(full);
  if (sha === undefined) return notFound();
  const object = repo.objects.get(sha);
  return { status: 200, body: { ref: full, object: { sha, type: object?.type ?? 'commit' } } };
}

function listBranches(repo: Repo): RestResult {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { status: 200, body: branches };
}

function getBranch(repo: Repo, name: string): RestResult {
  const sha = repo.branchTip(name);
  if (sha === null) return notFound();
  return { status: 200, body: { name, commit: { sha }, protected: false } };
}

function listCommits(repo: Repo, req: RestRequest): RestResult {
  const commit = resolveRef(repo, req.query.get('sha'));
  if (commit === null) return { status: 200, body: [] };
  const all = reachableCommits(repo, commit).map((sha) => commitJson(repo, sha));
  const { page, nextUrl } = paginate(all, req.query);
  return withLink({ status: 200, body: page }, req, nextUrl);
}

function getCommit(repo: Repo, sha: string): RestResult {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return notFound();
  return { status: 200, body: commitJson(repo, sha) };
}

// ------------------------------------------------ labels

function createLabel(repo: Repo, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const name = bodyString(req.body, 'name');
  const color = bodyString(req.body, 'color');
  if (name === null || name === '') return unprocessable('name is required');
  if (repo.labels.has(name)) return unprocessable('Label already exists');
  repo.labels.set(name, { name, color: (color ?? 'ededed').replace(/^#/, ''), description: bodyString(req.body, 'description') });
  return { status: 201, body: labelJson(repo, name) };
}

function listLabels(repo: Repo): RestResult {
  return { status: 200, body: [...repo.labels.keys()].map((name) => labelJson(repo, name)) };
}

// ------------------------------------------------ issues and comments

/** The label names an issue payload names, or an error when one is unknown to the repo. */
function labelsFromBody(repo: Repo, body: Record<string, unknown> | undefined): { labels: string[] } | RestResult {
  const raw = body?.labels;
  if (raw === undefined || raw === null) return { labels: [] };
  if (!Array.isArray(raw)) return unprocessable('labels must be an array');
  const labels: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? String((entry as { name: string }).name) : null;
    if (name === null) return unprocessable('labels must name labels');
    if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist in the repository`);
    labels.push(name);
  }
  return { labels };
}

export function createIssueRecord(forge: Forge, repo: Repo, title: string, body: string | null, labels: string[]): IssueRec {
  const now = forge.clock.nowIso();
  const issue: IssueRec = {
    kind: 'issue',
    id: forge.nextRecordIdValue(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdSeq: forge.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.numbered.set(issue.number, issue);
  return issue;
}

function createIssue(forge: Forge, repo: Repo, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const title = bodyString(req.body, 'title');
  if (title === null || title === '') return unprocessable('title is required');
  const labels = labelsFromBody(repo, req.body);
  if ('status' in labels) return labels as RestResult;
  const issue = createIssueRecord(forge, repo, title, bodyString(req.body, 'body'), (labels as { labels: string[] }).labels);
  return { status: 201, body: issueJson(repo, issue) };
}

function listIssues(repo: Repo, req: RestRequest): RestResult {
  const state = req.query.get('state') ?? 'open';
  let issues = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = req.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { page, nextUrl } = paginate(issues, req.query);
  return withLink({ status: 200, body: page.map((issue) => issueJson(repo, issue)) }, req, nextUrl);
}

function getIssue(repo: Repo, number: number): RestResult {
  const rec = repo.numbered.get(number);
  if (rec === undefined || rec.kind !== 'issue') return notFound();
  return { status: 200, body: issueJson(repo, rec) };
}

function patchIssue(forge: Forge, repo: Repo, number: number, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const rec = repo.numbered.get(number);
  if (rec === undefined || rec.kind !== 'issue') return notFound();
  const title = bodyString(req.body, 'title');
  if (title !== null) rec.title = title;
  if (req.body !== undefined && 'body' in req.body) rec.body = bodyString(req.body, 'body');
  const state = bodyString(req.body, 'state');
  if (state === 'open' || state === 'closed') rec.state = state;
  if (req.body?.labels !== undefined) {
    const labels = labelsFromBody(repo, req.body);
    if ('status' in labels) return labels as RestResult;
    rec.labels = (labels as { labels: string[] }).labels;
  }
  rec.updatedAt = forge.clock.nowIso();
  return { status: 200, body: issueJson(repo, rec) };
}

function createComment(forge: Forge, repo: Repo, number: number, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const rec = repo.numbered.get(number);
  if (rec === undefined) return notFound();
  const body = bodyString(req.body, 'body');
  if (body === null) return unprocessable('body is required');
  const comment = { id: forge.nextCommentIdValue(), body, authorLogin: VIEWER.login, createdAt: forge.clock.nowIso() };
  rec.comments.push(comment);
  return { status: 201, body: commentJson(comment) };
}

function listComments(repo: Repo, number: number): RestResult {
  const rec = repo.numbered.get(number);
  if (rec === undefined) return notFound();
  return { status: 200, body: rec.comments.map(commentJson) };
}

// ------------------------------------------------ pull requests

/** A head/base value may arrive as "owner:branch" (the fork spelling); the branch is the tail. */
function branchNameOf(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

export function createPullRecord(
  forge: Forge,
  repo: Repo,
  args: { title: string; body: string | null; headRef: string; baseRef: string },
): PullRec | RestResult {
  const headTip = repo.branchTip(args.headRef);
  const baseTip = repo.branchTip(args.baseRef);
  if (baseTip === null) return unprocessable('Base branch does not exist');
  if (headTip === null) return unprocessable('Head branch does not exist');
  if (args.headRef === args.baseRef) return unprocessable('Head and base branches are the same');
  for (const rec of repo.numbered.values()) {
    if (rec.kind === 'pull' && rec.state === 'open' && rec.headRef === args.headRef && rec.baseRef === args.baseRef) {
      return unprocessable('A pull request already exists for this head and base');
    }
  }
  const now = forge.clock.nowIso();
  const pull: PullRec = {
    kind: 'pull',
    id: forge.nextRecordIdValue(),
    number: repo.nextNumber,
    title: args.title,
    body: args.body,
    state: 'open',
    merged: false,
    headRef: args.headRef,
    baseRef: args.baseRef,
    headShaAtCreate: peel(repo, headTip) ?? headTip,
    baseShaAtCreate: peel(repo, baseTip) ?? baseTip,
    mergeCommitSha: null,
    mergedAt: null,
    comments: [],
    createdSeq: forge.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.numbered.set(pull.number, pull);
  return pull;
}

function createPull(forge: Forge, repo: Repo, req: RestRequest): RestResult {
  if (req.malformedBody) return badRequest('Malformed JSON body');
  const title = bodyString(req.body, 'title');
  const head = bodyString(req.body, 'head');
  const base = bodyString(req.body, 'base');
  if (title === null || head === null || base === null) return unprocessable('title, head and base are required');
  const created = createPullRecord(forge, repo, { title, body: bodyString(req.body, 'body'), headRef: branchNameOf(head), baseRef: branchNameOf(base) });
  if ('status' in created) return created as RestResult;
  return { status: 201, body: pullJson(repo, created as PullRec) };
}

function listPulls(repo: Repo, req: RestRequest): RestResult {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.numbered.values()].filter((rec): rec is PullRec => rec.kind === 'pull');
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, nextUrl } = paginate(pulls, req.query);
  return withLink({ status: 200, body: page.map((pull) => pullJson(repo, pull)) }, req, nextUrl);
}

function getPull(repo: Repo, number: number): RestResult {
  const rec = repo.numbered.get(number);
  if (rec === undefined || rec.kind !== 'pull') return notFound();
  return { status: 200, body: pullJson(repo, rec) };
}

function listPullFiles(repo: Repo, number: number): RestResult {
  const rec = repo.numbered.get(number);
  if (rec === undefined || rec.kind !== 'pull') return notFound();
  const headTip = repo.branchTip(rec.headRef);
  const headCommit = headTip === null ? rec.headShaAtCreate : (peel(repo, headTip) ?? rec.headShaAtCreate);
  const changes = diffTrees(repo, rec.baseShaAtCreate, headCommit);
  return {
    status: 200,
    body: changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })),
  };
}

export interface MergeOutcome {
  sha: string;
}

/**
 * Merge a pull request into its base branch: a three-way merge of the head changes onto the
 * current base tip. Squash lands one commit parented on the base tip; a plain merge keeps the
 * head tip as a second parent. Returns the new commit id, or null on a conflict.
 */
export function mergePullRecord(forge: Forge, repo: Repo, pull: PullRec, method: string): MergeOutcome | null {
  const baseTipRaw = repo.branchTip(pull.baseRef);
  const headTipRaw = repo.branchTip(pull.headRef);
  const baseTip = baseTipRaw === null ? pull.baseShaAtCreate : (peel(repo, baseTipRaw) ?? pull.baseShaAtCreate);
  const headTip = headTipRaw === null ? pull.headShaAtCreate : (peel(repo, headTipRaw) ?? pull.headShaAtCreate);
  const base = mergeBase(repo, baseTip, headTip) ?? pull.baseShaAtCreate;
  const mergedTree = threeWayMergeTrees(repo, base, baseTip, headTip);
  if (mergedTree === null) return null;
  const parents = method === 'squash' ? [baseTip] : [baseTip, headTip];
  const message = method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const data = ((): Buffer => {
    const identity = `${VIEWER.name} <${VIEWER.email}> ${forge.clock.nowSec()} +0000`;
    const lines = [`tree ${mergedTree}`, ...parents.map((parent) => `parent ${parent}`), `author ${identity}`, `committer ${identity}`];
    return Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
  })();
  const sha = repo.objects.put('commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = forge.clock.nowIso();
  pull.updatedAt = pull.mergedAt;
  return { sha };
}

function mergePull(forge: Forge, repo: Repo, number: number, req: RestRequest): RestResult {
  const rec = repo.numbered.get(number);
  if (rec === undefined || rec.kind !== 'pull') return notFound();
  if (rec.merged) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  if (rec.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const method = (bodyString(req.body, 'merge_method') ?? 'merge').toLowerCase();
  const outcome = mergePullRecord(forge, repo, rec, method === 'squash' ? 'squash' : 'merge');
  if (outcome === null) return { status: 405, body: { message: 'Pull Request is not mergeable: the head and base have conflicting changes' } };
  return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ------------------------------------------------ the router

/**
 * Route one /api/v3 request. Returns null when the path is not a REST route at all (the app
 * answers its own 404); every matched route answers a RestResult.
 */
export function handleRest(forge: Forge, req: RestRequest): RestResult | null {
  const { method, path } = req;
  if (path === '' || path === '/') {
    if (method === 'GET') return handleRoot();
    return notFound();
  }
  if (path === '/meta') return method === 'GET' ? handleMeta() : notFound();
  if (path === '/user') return method === 'GET' ? handleUser() : notFound();
  if (path === '/user/repos') {
    if (method === 'POST') return createRepository(forge, req);
    if (method === 'GET') return listUserRepos(forge, req);
    return notFound();
  }

  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments[0] !== 'repos' || segments.length < 3) return null;
  let owner = segments[1] ?? '';
  let repoName = segments[2] ?? '';
  try {
    owner = decodeURIComponent(owner);
    repoName = decodeURIComponent(repoName);
  } catch {
    // keep the raw segments
  }
  const repo = forge.getRepo(owner, repoName);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (repo === null) return notFound();
    if (method === 'GET') return getRepository(repo);
    if (method === 'PATCH') return patchRepository(forge, repo, req);
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { status: 204, empty: true };
    }
    return notFound();
  }
  if (repo === null) return notFound();

  // /contents/{path...}
  if (rest[0] === 'contents') {
    const filePath = decodePath(rest.slice(1).join('/'));
    if (method === 'GET') return getContents(repo, filePath, req);
    if (method === 'PUT') return putContents(forge, repo, filePath, req);
    if (method === 'DELETE') return deleteContents(forge, repo, filePath, req);
    return notFound();
  }
  // /git/refs and /git/refs/{ref...}
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') return createRef(repo, req);
    if (rest.length > 2 && method === 'GET') return getRef(repo, rest.slice(2).join('/'));
    return notFound();
  }
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(repo);
    if (rest.length > 1 && method === 'GET') return getBranch(repo, decodePath(rest.slice(1).join('/')));
    return notFound();
  }
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') return listCommits(repo, req);
    if (rest.length === 2 && method === 'GET') return getCommit(repo, rest[1] ?? '');
    return notFound();
  }
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') return createLabel(repo, req);
    if (rest.length === 1 && method === 'GET') return listLabels(repo);
    return notFound();
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') return createIssue(forge, repo, req);
    if (rest.length === 1 && method === 'GET') return listIssues(repo, req);
    const number = Number(rest[1]);
    if (rest.length === 2 && Number.isInteger(number)) {
      if (method === 'GET') return getIssue(repo, number);
      if (method === 'PATCH') return patchIssue(forge, repo, number, req);
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(number)) {
      if (method === 'POST') return createComment(forge, repo, number, req);
      if (method === 'GET') return listComments(repo, number);
      return notFound();
    }
    return notFound();
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') return createPull(forge, repo, req);
    if (rest.length === 1 && method === 'GET') return listPulls(repo, req);
    const number = Number(rest[1]);
    if (rest.length === 2 && Number.isInteger(number)) {
      if (method === 'GET') return getPull(repo, number);
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files' && Number.isInteger(number) && method === 'GET') return listPullFiles(repo, number);
    if (rest.length === 3 && rest[2] === 'merge' && Number.isInteger(number) && method === 'PUT') return mergePull(forge, repo, number, req);
    return notFound();
  }
  return null;
}
