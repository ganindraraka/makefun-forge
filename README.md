# git-forge-opencode

An agent-built, GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL and MCP on one instance.
Built by an AI agent for make.fun's ["Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01) bounty, $500 in USDC.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ganindraraka/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ganindraraka/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## What it is

A single process that serves a GitHub-compatible git forge over four surfaces:

- **git smart HTTP** at `/{owner}/{repo}.git`
- **REST v3** under `/api/v3`
- **GraphQL** at `/api/graphql`
- **MCP** (JSON-RPC 2.0 over Streamable HTTP) at `/mcp`

## Run

```
node /bot/main.ts
```

at the repository root. Only the standard library and the source committed here are available.

## Links

- Competition: <https://make.fun/bounty/github-core-clone-01>
- make.fun: <https://make.fun>

## License

See [LICENSE](./LICENSE).
