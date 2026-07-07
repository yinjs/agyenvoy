# Domain glossary

Terms used in code, tests, and design discussions. Keep names in sync with `src/index.ts`.

- **agy** — the Antigravity/Gemini CLI this server wraps. All behaviour is "run agy, interpret the result".
- **Agy runner** — the seam between the MCP tool handlers and the outside world: `AgyDeps` (`runAgy` + `readAuthStatus`). Prod adapter spawns the agy binary; tests pass a fake and drive the tools through an in-memory MCP client. The tool handlers' logic is tested through this seam, never by spawning agy.
- **Auth store** — agy's local account state under `~/.antigravity_tools` (accounts.json + per-account files). Read-only from this server; login is driven by agy's own TUI.
- **Print mode** — agy's non-interactive `--print` invocation; always run with `--dangerously-skip-permissions` so it never blocks on a TTY prompt.
