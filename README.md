# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/almalikgroup-cmd/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/almalikgroup-cmd/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in TypeScript (Node 22, standard library only — no git binary, no dependencies). One process serves the whole surface from a single in-memory store: git smart HTTP (protocol v0 and v2 advertisements, ls-refs, fetch with shallow/deepen negotiation, receive-pack with report-status) backed by its own SHA-1 object store with pack read/write and delta resolution; the REST v3 API (repositories, contents, git data, branches, commits, labels, issues, comments, pull requests with three-way squash merges); the GraphQL v4 API (viewer, repository, node, connections with cursor pagination, the create/close/merge mutations, batched operations and __type introspection); and an MCP endpoint (server/discover plus the legacy initialize handshake, with the github-mcp-server tool set acting on the same store). All timestamps derive deterministically from MAKEFUN_TRIAL_NOW.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=fp1aw4h5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
