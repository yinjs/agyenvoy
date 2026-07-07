# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
git config core.hooksPath .githooks   # once per clone: pre-commit lints/format-checks + rebuilds server.mjs if stale; commit-msg runs commitlint

npm test                              # tsc build → dist/, then node --test test/*.test.mjs
node --test --test-name-pattern="agy_ask" test/server.test.mjs   # single test (needs dist/ built)
npm run build                         # tsc typecheck + emit dist/
npm run bundle                        # esbuild → server.mjs (the shipped artifact)
npm run dev                           # tsx watch src/index.ts
npm run lint                          # oxlint
npm run fmt                           # oxfmt --write; fmt:check for CI/hook mode
```

## What this is

A Claude Code plugin wrapping the `agy` (Antigravity/Gemini) CLI as an MCP server plus three skills. `.claude-plugin/plugin.json` launches `node server.mjs`; `skills/*/SKILL.md` teach the host agent when to delegate to agy (image gen, media understanding, second opinions).

## Architecture

All server code is one module: `src/index.ts`. `CONTEXT.md` is the domain glossary — use its terms (agy runner, auth store, print mode).

- **The agy runner seam**: `createServer(deps: AgyDeps)` takes `{ runAgy, readAuthStatus }`, defaulting to prod adapters. All four tool handlers go through `deps`. Tests pass fakes and drive tools through a real MCP client over `InMemoryTransport` — never by spawning agy. Keep new tool logic behind this seam so it stays testable that way.
- **`server.mjs` is a tracked build artifact** (self-contained bundle; plugin users never `npm install`). Any `src/` change requires `npm run bundle` in the same commit — the pre-commit hook enforces this.
- **Tests import from `dist/`**, not `src/` — `npm test` builds first; running `node --test` directly against stale `dist/` tests old code.
- **One version, three files**: `.claude-plugin/plugin.json`, `marketplace.json`, and `package.json` all carry the same version (`package.json`'s is surfaced in MCP `serverInfo` via `pkgVersion()`). Bump all three together when releasing.

## Non-obvious constraints (don't "simplify" these away)

- `runAgy` sets `stdio: ["ignore", ...]` — an open empty stdin pipe makes agy hang until timeout.
- `runAgy` spawns `detached` and kills the whole process group on timeout — agy auto-approves tools, so it spawns subprocesses that must die with it.
- `agy_ask` always passes `--dangerously-skip-permissions`; without it, print mode blocks on a TTY approval that never comes.
- The run-directly guard at the bottom of `src/index.ts` realpaths `argv[1]` — plugin installs are often symlinked, and without realpath the server exits silently on load.
- agy has no headless login: `agy_login` opens Terminal.app (macOS only) and polls the auth store; auth state is only ever _read_ from `~/.antigravity_tools`.
- agy responses routinely exceed the 60s MCP client timeout — users need `MCP_TOOL_TIMEOUT` raised; `agy_ask`'s `timeout_ms` only governs the server-side wait.
