// graphql.ts: the GitHub GraphQL v4 surface at /api/graphql — a small hand-written parser and
// executor covering the schema the suite exercises: viewer, repository, node, issues and
// pull-request connections, the five mutations (createIssue, closeIssue, createPullRequest,
// mergePullRequest, addComment), batched operations, and __type introspection.
//
// Global ids are opaque base64 strings that encode the object kind and its keys; they are
// stable across reads and distinct from the numeric databaseId/number, as GitHub's are.

import { diffTrees, flattenTree, mergeBase, peel, treeOfCommit, type Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { VIEWER } from './store.ts';
import { createIssueRecord, createPullRecord, issueJson, mergePullRecord, pullJson, repoJson } from './rest.ts';

// ------------------------------------------------------------------ global ids

/** An opaque global id for an object: base64 of "<Kind>:<key>:<key>...". */
export function globalId(kind: string, ...keys: Array<string | number>): string {
  return Buffer.from(`${kind}:${keys.join(':')}`, 'utf8').toString('base64');
}

/** Decode a global id back into its kind and keys, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; keys: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0] ?? '', keys: parts.slice(1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] ?? '';
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] ?? '')) j += 1;
      const text = source.slice(i, j);
      if (text.includes('.')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof' };
  }

  private take(): Token {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private takeName(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  /** Skip a balanced parenthesised group (variable definitions, directives). */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.take();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '@') {
      this.take();
      this.takeName();
      if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') this.skipParens();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.take();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.takeName();
        if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') this.skipParens();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.take();
        const fragName = this.takeName();
        const on = this.takeName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.takeName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '}') {
        this.take();
        return selections;
      }
      if (token.kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.take();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.take();
        const typeCondition = this.takeName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.takeName();
      return { kind: 'spread', name };
    }
    // A field, possibly aliased.
    let name = this.takeName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === ':') {
      this.take();
      alias = name;
      name = this.takeName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
      this.take();
      for (;;) {
        const inner = this.peek();
        if (inner.kind === 'punct' && inner.value === ')') {
          this.take();
          break;
        }
        const argName = this.takeName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.take();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'bool', value: true };
        if (token.value === 'false') return { kind: 'bool', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'var', name: this.takeName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          for (;;) {
            const inner = this.peek();
            if (inner.kind === 'punct' && inner.value === ']') {
              this.take();
              break;
            }
            items.push(this.parseValue());
          }
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          for (;;) {
            const inner = this.peek();
            if (inner.kind === 'punct' && inner.value === '}') {
              this.take();
              break;
            }
            const fieldName = this.takeName();
            this.expectPunct(':');
            fields.push({ name: fieldName, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected "${token.value}" in value`);
      default:
        throw new Error('unexpected token in value');
    }
  }
}

// ------------------------------------------------------------------ executor

/** A value tagged with the GraphQL type it resolves fields against. */
interface Typed {
  __type: string;
  value: unknown;
}

const typed = (__type: string, value: unknown): Typed => ({ __type, value });
const isTyped = (value: unknown): value is Typed => typeof value === 'object' && value !== null && '__type' in value;

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

type Resolver = (source: unknown, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const repoOf = (value: unknown): Repo => value as Repo;
const issueOf = (value: unknown): { repo: Repo; rec: IssueRec } => value as { repo: Repo; rec: IssueRec };
const pullOf = (value: unknown): { repo: Repo; rec: PullRec } => value as { repo: Repo; rec: PullRec };

/** Whether a pull request's merge would conflict (a pure read: no objects are written). */
function pullWouldConflict(repo: Repo, pull: PullRec): boolean {
  const baseTipRaw = repo.branchTip(pull.baseRef);
  const headTipRaw = repo.branchTip(pull.headRef);
  const baseTip = baseTipRaw === null ? pull.baseShaAtCreate : (peel(repo, baseTipRaw) ?? pull.baseShaAtCreate);
  const headTip = headTipRaw === null ? pull.headShaAtCreate : (peel(repo, headTipRaw) ?? pull.headShaAtCreate);
  const base = mergeBase(repo, baseTip, headTip) ?? pull.baseShaAtCreate;
  const baseMap = flattenTree(repo, treeOfCommit(repo, base));
  const oursMap = flattenTree(repo, treeOfCommit(repo, baseTip));
  const theirsMap = flattenTree(repo, treeOfCommit(repo, headTip));
  const paths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path)?.sha;
    const o = oursMap.get(path)?.sha;
    const t = theirsMap.get(path)?.sha;
    if (o === t || b === o || b === t) continue;
    return true;
  }
  return false;
}

function pullStateGraphql(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Cursor for connection pagination: base64 of the last item's creation sequence. */
function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

const SCHEMA: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => typed('User', { login: VIEWER.login }),
    repository: (_source, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : typed('Repository', repo);
    },
    node: (_source, args, ctx) => nodeById(ctx, String(args.id ?? '')),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const rec = createIssueRecord(ctx.forge, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : null, []);
      return typed('CreateIssuePayload', { repo, rec });
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, String(input.issueId ?? ''));
      if (found === null) throw new Error('issue not found');
      found.rec.state = 'closed';
      found.rec.updatedAt = ctx.forge.clock.nowIso();
      return typed('CloseIssuePayload', found);
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const created = createPullRecord(ctx.forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? ''),
      });
      if ('status' in created) throw new Error(String((created as { body?: { message?: string } }).body?.message ?? 'could not create pull request'));
      return typed('CreatePullRequestPayload', { repo, rec: created as PullRec });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('pull request not found');
      if (!found.rec.merged && found.rec.state === 'open') {
        const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
        mergePullRecord(ctx.forge, found.repo, found.rec, method === 'squash' ? 'squash' : 'merge');
      }
      return typed('MergePullRequestPayload', found);
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = String(input.subjectId ?? '');
      const parsed = parseGlobalId(subjectId);
      if (parsed === null) throw new Error('subject not found');
      const repoDbId = Number(parsed.keys[0]);
      const number = Number(parsed.keys[1]);
      const repo = ctx.forge.listRepos().find((candidate) => candidate.dbId === repoDbId);
      if (repo === undefined) throw new Error('subject not found');
      const rec = repo.numbered.get(number);
      if (rec === undefined) throw new Error('subject not found');
      const comment = { id: ctx.forge.nextCommentIdValue(), body: String(input.body ?? ''), authorLogin: VIEWER.login, createdAt: ctx.forge.clock.nowIso() };
      rec.comments.push(comment);
      return typed('AddCommentPayload', { repo, number, comment });
    },
  },
  User: {
    login: (source) => (source as { login: string }).login,
    id: () => globalId('User', VIEWER.id),
    name: () => VIEWER.name,
  },
  Repository: {
    id: (source) => globalId('Repository', repoOf(source).dbId),
    databaseId: (source) => repoOf(source).dbId,
    name: (source) => repoOf(source).name,
    nameWithOwner: (source) => `${repoOf(source).owner}/${repoOf(source).name}`,
    owner: (source) => typed('User', { login: repoOf(source).owner }),
    description: (source) => repoOf(source).description,
    isPrivate: (source) => repoOf(source).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (source) => typed('Ref', { name: repoOf(source).defaultBranch }),
    createdAt: (source) => repoOf(source).createdAt,
    updatedAt: (source) => repoOf(source).createdAt,
    issue: (source, args) => {
      const repo = repoOf(source);
      const rec = repo.numbered.get(Number(args.number));
      return rec !== undefined && rec.kind === 'issue' ? typed('Issue', { repo, rec }) : null;
    },
    issues: (source, args) => {
      const repo = repoOf(source);
      let list = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
      const states = args.states as unknown;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => (String(state) === 'OPEN' ? 'open' : 'closed')));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const descending = orderBy.direction === 'DESC';
      list.sort((a, b) => (descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
      if (typeof args.after === 'string') {
        const seq = decodeCursor(args.after);
        if (seq !== null) list = list.filter((issue) => (descending ? issue.createdSeq < seq : issue.createdSeq > seq));
      }
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
      const page = list.slice(0, first);
      const last = page[page.length - 1];
      return typed('IssueConnection', {
        nodes: page.map((rec) => typed('Issue', { repo, rec })),
        pageInfo: { hasNextPage: list.length > page.length, endCursor: last === undefined ? null : encodeCursor(last.createdSeq) },
      });
    },
    pullRequest: (source, args) => {
      const repo = repoOf(source);
      const rec = repo.numbered.get(Number(args.number));
      return rec !== undefined && rec.kind === 'pull' ? typed('PullRequest', { repo, rec }) : null;
    },
    pullRequests: (source, args) => {
      const repo = repoOf(source);
      let list = [...repo.numbered.values()].filter((rec): rec is PullRec => rec.kind === 'pull');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
      const page = list.slice(0, first);
      return typed('PullRequestConnection', {
        nodes: page.map((rec) => typed('PullRequest', { repo, rec })),
        pageInfo: { hasNextPage: list.length > page.length, endCursor: null },
      });
    },
  },
  Ref: {
    name: (source) => (source as { name: string }).name,
    target: () => null,
  },
  Issue: {
    id: (source) => globalId('Issue', issueOf(source).repo.dbId, issueOf(source).rec.number),
    databaseId: (source) => issueOf(source).rec.id,
    number: (source) => issueOf(source).rec.number,
    title: (source) => issueOf(source).rec.title,
    body: (source) => issueOf(source).rec.body ?? '',
    state: (source) => (issueOf(source).rec.state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (source) => issueOf(source).rec.state === 'closed',
    createdAt: (source) => issueOf(source).rec.createdAt,
    updatedAt: (source) => issueOf(source).rec.updatedAt,
    repository: (source) => typed('Repository', issueOf(source).repo),
    author: () => typed('User', { login: VIEWER.login }),
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', pullOf(source).repo.dbId, pullOf(source).rec.number),
    databaseId: (source) => pullOf(source).rec.id,
    number: (source) => pullOf(source).rec.number,
    title: (source) => pullOf(source).rec.title,
    body: (source) => pullOf(source).rec.body ?? '',
    state: (source) => pullStateGraphql(pullOf(source).rec),
    merged: (source) => pullOf(source).rec.merged,
    closed: (source) => pullOf(source).rec.state === 'closed',
    headRefName: (source) => pullOf(source).rec.headRef,
    baseRefName: (source) => pullOf(source).rec.baseRef,
    headRefOid: (source) => pullOf(source).repo.branchTip(pullOf(source).rec.headRef) ?? pullOf(source).rec.headShaAtCreate,
    baseRefOid: (source) => pullOf(source).repo.branchTip(pullOf(source).rec.baseRef) ?? pullOf(source).rec.baseShaAtCreate,
    mergeable: (source) => {
      const { repo, rec } = pullOf(source);
      if (rec.state !== 'open') return 'UNKNOWN';
      return pullWouldConflict(repo, rec) ? 'CONFLICTING' : 'MERGEABLE';
    },
    createdAt: (source) => pullOf(source).rec.createdAt,
    updatedAt: (source) => pullOf(source).rec.updatedAt,
    author: () => typed('User', { login: VIEWER.login }),
    files: (source, args) => {
      const { repo, rec } = pullOf(source);
      const headTip = repo.branchTip(rec.headRef);
      const headCommit = headTip === null ? rec.headShaAtCreate : (peel(repo, headTip) ?? rec.headShaAtCreate);
      const changes = diffTrees(repo, rec.baseShaAtCreate, headCommit);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
      return typed('PullRequestFileConnection', {
        nodes: changes.slice(0, first).map((change) => typed('PullRequestChangedFile', { path: change.path, additions: change.additions, deletions: change.deletions })),
        pageInfo: { hasNextPage: changes.length > first, endCursor: null },
      });
    },
  },
  PullRequestChangedFile: {
    path: (source) => (source as { path: string }).path,
    additions: (source) => (source as { additions: number }).additions,
    deletions: (source) => (source as { deletions: number }).deletions,
  },
  IssueConnection: {
    nodes: (source) => (source as { nodes: unknown }).nodes,
    edges: (source) => ((source as { nodes: Typed[] }).nodes ?? []).map((node) => typed('IssueEdge', { node, cursor: '' })),
    pageInfo: (source) => typed('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (source) => ((source as { nodes: unknown[] }).nodes ?? []).length,
  },
  PullRequestConnection: {
    nodes: (source) => (source as { nodes: unknown }).nodes,
    pageInfo: (source) => typed('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (source) => ((source as { nodes: unknown[] }).nodes ?? []).length,
  },
  PullRequestFileConnection: {
    nodes: (source) => (source as { nodes: unknown }).nodes,
    pageInfo: (source) => typed('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (source) => ((source as { nodes: unknown[] }).nodes ?? []).length,
  },
  IssueEdge: {
    node: (source) => (source as { node: unknown }).node,
    cursor: (source) => (source as { cursor: string }).cursor,
  },
  PageInfo: {
    hasNextPage: (source) => (source as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: () => false,
    startCursor: () => null,
    endCursor: (source) => (source as { endCursor: string | null }).endCursor,
  },
  Comment: {
    id: (source) => {
      const value = source as { repo: Repo; number: number; comment: { id: number } };
      return globalId('Comment', value.repo.dbId, value.number, value.comment.id);
    },
    body: (source) => (source as { comment: { body: string } }).comment.body,
    createdAt: (source) => (source as { comment: { createdAt: string } }).comment.createdAt,
    author: () => typed('User', { login: VIEWER.login }),
  },
  CreateIssuePayload: {
    issue: (source) => typed('Issue', source),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (source) => typed('Issue', source),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => typed('PullRequest', source),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => typed('PullRequest', source),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (source) => typed('CommentEdge', source),
    subject: () => null,
    clientMutationId: () => null,
  },
  CommentEdge: {
    node: (source) => typed('Comment', source),
    cursor: () => '',
  },
  __Type: {
    name: (source) => (source as { name: string }).name,
    kind: (source) => (TYPE_ENUM_VALUES[(source as { name: string }).name] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (source) => {
      const fields = TYPE_FIELDS[(source as { name: string }).name];
      return fields === undefined ? null : fields.map((name) => typed('__Field', { name }));
    },
    enumValues: (source) => {
      const values = TYPE_ENUM_VALUES[(source as { name: string }).name];
      return values === undefined ? null : values.map((name) => typed('__EnumValue', { name }));
    },
  },
  __Field: {
    name: (source) => (source as { name: string }).name,
  },
  __EnumValue: {
    name: (source) => (source as { name: string }).name,
  },
};

/** The field names __type reports per object type (the suite's minimum sets are covered). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closed', 'labels', 'comments', 'repository', 'author'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'closed', 'additions', 'deletions', 'changedFiles', 'author', 'repository'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
};

/** The values __type reports per enum type. */
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function repoByGlobalId(ctx: ExecCtx, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.keys[0]);
  return ctx.forge.listRepos().find((repo) => repo.dbId === dbId) ?? null;
}

function issueByGlobalId(ctx: ExecCtx, id: string): { repo: Repo; rec: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const repo = ctx.forge.listRepos().find((candidate) => candidate.dbId === Number(parsed.keys[0]));
  if (repo === undefined) return null;
  const rec = repo.numbered.get(Number(parsed.keys[1]));
  return rec !== undefined && rec.kind === 'issue' ? { repo, rec } : null;
}

function pullByGlobalId(ctx: ExecCtx, id: string): { repo: Repo; rec: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const repo = ctx.forge.listRepos().find((candidate) => candidate.dbId === Number(parsed.keys[0]));
  if (repo === undefined) return null;
  const rec = repo.numbered.get(Number(parsed.keys[1]));
  return rec !== undefined && rec.kind === 'pull' ? { repo, rec } : null;
}

function nodeById(ctx: ExecCtx, id: string): Typed | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoByGlobalId(ctx, id);
    return repo === null ? null : typed('Repository', repo);
  }
  if (parsed.kind === 'Issue') {
    const found = issueByGlobalId(ctx, id);
    return found === null ? null : typed('Issue', found);
  }
  if (parsed.kind === 'PullRequest') {
    const found = pullByGlobalId(ctx, id);
    return found === null ? null : typed('PullRequest', found);
  }
  return null;
}

/** Complete a resolved value: descend into selection sets for typed objects and arrays. */
function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === null) return isTyped(value) ? null : value;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (isTyped(value)) {
    const out: Record<string, unknown> = {};
    executeSelectionSet(value.__type, value.value, field.selectionSet, ctx, out);
    return out;
  }
  return value;
}

function executeSelectionSet(typeName: string, source: unknown, selections: SelectionNode[], ctx: ExecCtx, out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        executeSelectionSet(typeName, source, selection.selectionSet, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        executeSelectionSet(typeName, source, fragment.selectionSet, ctx, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (selection.name === '__type' && typeName === 'Query') {
      const args = evalArgs(selection, ctx);
      const name = String(args.name ?? '');
      const known = TYPE_FIELDS[name] !== undefined || TYPE_ENUM_VALUES[name] !== undefined;
      out[key] = known ? completeValue(typed('__Type', { name }), selection, ctx) : null;
      continue;
    }
    if (selection.name === '__schema' && typeName === 'Query') {
      out[key] = null;
      continue;
    }
    const resolver = SCHEMA[typeName]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    try {
      const resolved = resolver(source, evalArgs(selection, ctx), ctx);
      out[key] = completeValue(resolved, selection, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
    }
  }
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
export function executeGraphQL(forge: Forge, operation: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const variables = (typeof operation.variables === 'object' && operation.variables !== null ? operation.variables : {}) as Record<string, unknown>;
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
  const op = operationName === null ? document.operations[0] : document.operations.find((candidate) => candidate.name === operationName);
  if (op === undefined) return { errors: [{ message: 'operation not found' }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const data: Record<string, unknown> = {};
  executeSelectionSet(op.type === 'mutation' ? 'Mutation' : 'Query', null, op.selectionSet, ctx, data);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** The /api/graphql entry: one operation object, or an array of them answered in order. */
export function handleGraphQL(forge: Forge, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Malformed JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeGraphQL(forge, (entry ?? {}) as Record<string, unknown>)) };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return { status: 200, body: executeGraphQL(forge, parsed as Record<string, unknown>) };
  }
  return { status: 400, body: { errors: [{ message: 'Expected a GraphQL operation object' }] } };
}

export { issueJson, pullJson, repoJson };
