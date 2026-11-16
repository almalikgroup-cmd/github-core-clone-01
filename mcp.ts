// mcp.ts: the Model Context Protocol endpoint at /mcp — JSON-RPC over one POST per request.
// The server speaks the current revision's shape (server/discover, no handshake, no session)
// and also answers the legacy initialize handshake, so either client era can talk to it. Tools
// are the github-mcp-server names and act on the same Forge store as REST and GraphQL, which
// is what the suite's rest-parity check verifies.

import { VIEWER, type Forge, type Repo } from './store.ts';
import { createIssueRecord, createPullRecord, issueJson, mergePullRecord, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

/** The tool list: a constant, so two tools/list answers are byte-identical. */
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: stringProp('The repository owner (defaults to the authenticated user)'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner'), repo: stringProp('The repository name') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { owner: stringProp('The owner (defaults to the authenticated user)') }, required: [] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
]);

interface RpcOutcome {
  status: number;
  /** The JSON-RPC response object, or null for a notification (answered 202 with no body). */
  response: Record<string, unknown> | null;
}

const rpcError = (id: unknown, code: number, message: string): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

const rpcResult = (id: unknown, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });

/** A tool result: the value as structured content and as a JSON text block. */
function toolOk(id: unknown, value: unknown): RpcOutcome {
  return {
    status: 200,
    response: rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
      isError: false,
    }),
  };
}

/** A tool-level failure: the call succeeded, the tool reports the error (isError). */
function toolFailed(id: unknown, message: string): RpcOutcome {
  return {
    status: 200,
    response: rpcResult(id, { content: [{ type: 'text', text: message }], isError: true }),
  };
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  return forge.getRepo(argString(args, 'owner') || VIEWER.login, argString(args, 'repo'));
}

function callTool(forge: Forge, id: unknown, name: string, args: Record<string, unknown>): RpcOutcome {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { status: 200, response: rpcError(id, -32602, `Unknown tool: ${name}`) };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return { status: 200, response: rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`) };
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      const existing = forge.getRepo(VIEWER.login, repoName);
      if (existing !== null) return toolFailed(id, `a repository named ${repoName} already exists`);
      const repo = forge.createRepo(repoName, argString(args, 'description'), args.private === true);
      if (repo === null) return toolFailed(id, `could not create repository ${repoName}`);
      return toolOk(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      if (repo === null) return toolFailed(id, 'repository not found');
      return toolOk(id, repoJson(repo));
    }
    case 'list_repos': {
      return toolOk(id, forge.listRepos().map(repoJson));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      if (repo === null) return toolFailed(id, 'repository not found');
      const rec = createIssueRecord(forge, repo, argString(args, 'title'), argString(args, 'body') || null, []);
      return toolOk(id, issueJson(repo, rec));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      if (repo === null) return toolFailed(id, 'repository not found');
      const state = argString(args, 'state') || 'open';
      const issues = [...repo.numbered.values()].filter((rec) => rec.kind === 'issue' && (state === 'all' || rec.state === state));
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      return toolOk(id, issues.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = requireRepo(forge, args);
      if (repo === null) return toolFailed(id, 'repository not found');
      const rec = repo.numbered.get(Number(args.issue_number));
      if (rec === undefined || rec.kind !== 'issue') return toolFailed(id, 'issue not found');
      return toolOk(id, issueJson(repo, rec));
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      if (repo === null) return toolFailed(id, 'repository not found');
      const created = createPullRecord(forge, repo, {
        title: argString(args, 'title'),
        body: argString(args, 'body') || null,
        headRef: argString(args, 'head'),
        baseRef: argString(args, 'base'),
      });
      if ('status' in created) return toolFailed(id, String((created as { body?: { message?: string } }).body?.message ?? 'could not create pull request'));
      return toolOk(id, pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      if (repo === null) return toolFailed(id, 'repository not found');
      const rec = repo.numbered.get(Number(args.pull_number));
      if (rec === undefined || rec.kind !== 'pull') return toolFailed(id, 'pull request not found');
      if (rec.merged) return toolOk(id, { number: rec.number, merged: true, state: 'closed', sha: rec.mergeCommitSha });
      if (rec.state !== 'open') return toolFailed(id, 'pull request is not open');
      const outcome = mergePullRecord(forge, repo, rec, 'squash');
      if (outcome === null) return toolFailed(id, 'pull request is not mergeable: conflicting changes');
      return toolOk(id, { number: rec.number, merged: true, state: 'closed', sha: outcome.sha });
    }
    default:
      return { status: 200, response: rpcError(id, -32602, `Unknown tool: ${name}`) };
  }
}

/** Handle one /mcp POST body. Authentication is the app layer's job (it answers 401 first). */
export function handleMcp(forge: Forge, bodyText: string): RpcOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, response: rpcError(null, -32700, 'Parse error: the body is not JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, response: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC request object') };
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined) {
    // A notification: accepted, never answered.
    return { status: 202, response: null };
  }
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        response: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        response: rpcResult(id, {
          protocolVersion: chosen,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    }
    case 'ping':
      return { status: 200, response: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, response: rpcResult(id, { tools: MCP_TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      return callTool(forge, id, name, args);
    }
    default:
      return { status: 200, response: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
