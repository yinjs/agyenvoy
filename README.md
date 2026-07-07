# agyenvoy

A **Claude Code plugin** (MCP server + skill) that lets one agent dispatch the
[agy](https://antigravity.google) (Antigravity / Gemini) CLI. Delegate prompts to agy's models,
continue/resume conversations, list models, check auth/credit, log in, and generate real
images via agy's native image model.

Claude Code only. The MCP server is a single self-contained `server.mjs` (deps bundled) — no
`npm install` needed to run it.

## Tools

| Tool              | Purpose                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy_ask`         | Run a prompt through `agy --print`. Params: `model`, `add_dir[]`, `project`, `new_project`, `continue_conversation`, `conversation_id`, `timeout_ms`. Blocks with a hint if logged out. |
| `agy_list_models` | List models available to agy. No args.                                                                                                                                                  |
| `agy_auth_status` | Report login state + per-model quota (credit). Read-only, never returns the token.                                                                                                      |
| `agy_login`       | Ensure agy is logged in; if not, open a terminal for Google sign-in and poll until done (macOS).                                                                                        |

## Skills

Each skill teaches the host agent to reach for agy where it beats Claude's native abilities:

| Skill                     | Covers                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `agy-image-gen`           | Generate/edit raster images (native-model phrasing, matplotlib-trap avoidance, verify step).  |
| `agy-media-understanding` | Transcribe audio and describe/summarize video — Claude can't hear or watch media; Gemini can. |
| `agy-second-opinion`      | Cross-family review of a plan/diff/answer via Gemini or GPT-OSS models.                       |

## Prerequisites

- **Node.js >= 18**.
- **`agy` CLI installed** — `agy models` should work from your shell. If it isn't on `$PATH`,
  set `AGY_BIN` to the full path. (Auth itself is handled by `agy_login`.)

## Install (as a plugin)

```bash
/plugin marketplace add yinjs/agyenvoy      # local; or <git-owner>/agyenvoy once pushed
/plugin install agyenvoy@agyenvoy
```

Then restart Claude Code (or `/mcp`) to load it.

## Install (raw server, no plugin)

Copy `.mcp.json.example` to your project's `.mcp.json`, fix the absolute paths, done.

## Gotcha: request timeout

agy responses exceed the default 60s MCP request timeout. Raise it in the environment launching
Claude Code, or calls report a spurious client-side timeout:

```bash
export MCP_TOOL_TIMEOUT=600000   # 10 minutes
```

`agy_ask`'s own `timeout_ms` (default 5m) governs the server-side wait.

## Security

`agy_ask` runs agy with `--dangerously-skip-permissions` so tool actions inside agy are
auto-approved (required for non-interactive use — no TTY to approve). Use with trusted prompts only.

## Develop

```bash
npm install
git config core.hooksPath .githooks   # once: blocks commits with a stale server.mjs
npm run build     # tsc typecheck
npm run bundle    # -> server.mjs (self-contained, shipped)
```

Source: `src/index.ts`. The tracked `server.mjs` is the built artifact the plugin runs.
