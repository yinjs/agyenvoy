#!/usr/bin/env node
/**
 * MCP server for the `agy` (Antigravity / Gemini) CLI.
 *
 * Exposes the CLI's non-interactive print mode as MCP tools so any MCP client
 * (Claude Code, etc.) can delegate a prompt to agy's models, continue/resume a
 * prior agy conversation, and discover which models are available.
 *
 * Transport: stdio (local subprocess integration).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Path to the agy binary. Override with AGY_BIN if it isn't on PATH.
const AGY_BIN = process.env.AGY_BIN || "agy";

// Where agy stores auth/account state. Override with AGY_TOOLS_DIR if relocated.
const AGY_TOOLS_DIR = process.env.AGY_TOOLS_DIR || join(homedir(), ".antigravity_tools");

// print mode auto-approves tool permissions so it never blocks on a prompt.
// The user's own shell alias does the same; without it, print mode can hang
// waiting for an approval that has no TTY to answer it.
const SKIP_PERMISSIONS = "--dangerously-skip-permissions";

// Default upper bound (ms) for a single agy invocation. agy's own --print-timeout
// defaults to 5m; we mirror that and also enforce it on our side.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Version from package.json — single source of truth, no hardcoded literal to drift.
 * Bundled server.mjs sits next to package.json ("./"); dev via tsx runs from src/ ("../").
 */
function pkgVersion(): string {
  for (const rel of ["./package.json", "../package.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
    } catch {
      // try next location
    }
  }
  return "0.0.0";
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run agy with the given args, resolving with captured output (never rejects on non-zero exit).
 *
 * stdin is set to "ignore" so the child sees immediate EOF. This is essential:
 * agy blocks reading stdin, and an open, empty stdin pipe (execFile's default)
 * makes both --print and `models` hang until the timeout.
 */
function runAgy(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // detached → agy leads its own process group, so a timeout kill takes down
    // any subprocesses agy spawned (it auto-approves tools, so it does spawn).
    const child = spawn(AGY_BIN, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });

    const killTree = () => {
      try {
        if (child.pid)
          process.kill(-child.pid, "SIGKILL"); // whole process group
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL"); // group already gone or unsupported; best effort
      }
    };

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree();
      finish({
        stdout,
        stderr: `agy timed out after ${timeoutMs}ms. Increase timeout_ms or simplify the prompt.`,
        code: 124,
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        finish({
          stdout: "",
          stderr: `agy binary not found ('${AGY_BIN}'). Install the Antigravity CLI or set AGY_BIN to its full path.`,
          code: 127,
        });
      } else {
        finish({ stdout, stderr: e.message, code: 1 });
      }
    });

    child.on("close", (code) => finish({ stdout, stderr, code: code ?? 0 }));
  });
}

// ---------------------------------------------------------------------------
// agy_ask schemas
// ---------------------------------------------------------------------------

const AskInputSchema = z
  .object({
    prompt: z.string().min(1, "prompt is required").describe("The prompt to send to agy."),
    model: z
      .string()
      .optional()
      .describe(
        "Model name from agy_list_models (e.g. 'Gemini 3.1 Pro (High)'). Omit for the CLI default.",
      ),
    add_dir: z
      .array(z.string())
      .optional()
      .describe(
        "Absolute directory paths to add to agy's workspace so it can read those files while answering.",
      ),
    project: z.string().optional().describe("Existing agy project ID to run the session under."),
    new_project: z
      .boolean()
      .default(false)
      .describe(
        "Create a new agy project for this session instead of using the default/most-recent.",
      ),
    continue_conversation: z
      .boolean()
      .default(false)
      .describe(
        "Continue the most recent agy conversation (adds turns to it) instead of starting fresh.",
      ),
    conversation_id: z
      .string()
      .optional()
      .describe(
        "Resume a specific prior conversation by its ID. Takes precedence over continue_conversation.",
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(30 * 60 * 1000)
      .default(DEFAULT_TIMEOUT_MS)
      .describe("Max time to wait for agy to respond, in milliseconds (default 300000 = 5m)."),
  })
  .strict();

type AskInput = z.infer<typeof AskInputSchema>;

/** Assemble the agy argv for an ask. conversation_id takes precedence over continue_conversation. */
export function buildAskArgs(params: AskInput): string[] {
  const args: string[] = [SKIP_PERMISSIONS];
  if (params.conversation_id) {
    args.push("--conversation", params.conversation_id);
  } else if (params.continue_conversation) {
    args.push("--continue");
  }
  if (params.model) args.push("--model", params.model);
  if (params.project) args.push("--project", params.project);
  if (params.new_project) args.push("--new-project");
  for (const dir of params.add_dir ?? []) args.push("--add-dir", dir);
  // Print mode last, prompt as its value.
  args.push("--print", params.prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Auth: read agy's local account store and drive its login flow.
//
// agy has no headless login command — logging in happens inside its interactive
// TUI, which opens a Google OAuth browser flow and writes the resulting token to
// ~/.antigravity_tools/accounts/<id>.json. We therefore READ that store to report
// status/credit, and for login we launch agy in a terminal and poll the store
// until a valid account appears.
// ---------------------------------------------------------------------------

interface ModelQuota {
  display_name: string;
  percentage: number; // remaining %, 100 = full
  reset_time: string;
}

interface AuthStatus {
  logged_in: boolean;
  email: string | null;
  name: string | null;
  accounts: string[]; // known account emails
  models_quota: ModelQuota[];
  [key: string]: unknown; // satisfy MCP structuredContent's index signature
}

/** Read agy's auth store. Never returns tokens. Returns logged_in:false on any missing/invalid state. */
export function readAuthStatus(toolsDir: string = AGY_TOOLS_DIR): AuthStatus {
  const empty: AuthStatus = {
    logged_in: false,
    email: null,
    name: null,
    accounts: [],
    models_quota: [],
  };
  try {
    const accountsFile = JSON.parse(readFileSync(join(toolsDir, "accounts.json"), "utf8")) as {
      accounts?: Array<{ id: string; email?: string }>;
      current_account_id?: string | null;
    };
    const accounts = accountsFile.accounts ?? [];
    const emails = accounts.map((a) => a.email ?? a.id);
    const currentId = accountsFile.current_account_id;
    if (!currentId || accounts.length === 0) return { ...empty, accounts: emails };

    const acct = JSON.parse(
      readFileSync(join(toolsDir, "accounts", `${currentId}.json`), "utf8"),
    ) as {
      email?: string;
      name?: string;
      disabled?: boolean;
      validation_blocked?: boolean;
      token?: string;
      quota?: {
        models?: Array<{
          display_name?: string;
          name?: string;
          percentage?: number;
          reset_time?: string;
        }>;
      };
    };
    const loggedIn = !!acct.token && !acct.disabled && !acct.validation_blocked;
    const models_quota: ModelQuota[] = (acct.quota?.models ?? []).map((m) => ({
      display_name: m.display_name ?? m.name ?? "unknown",
      percentage: m.percentage ?? 0,
      reset_time: m.reset_time ?? "",
    }));
    return {
      logged_in: loggedIn,
      email: acct.email ?? null,
      name: acct.name ?? null,
      accounts: emails,
      models_quota,
    };
  } catch {
    return empty; // no store yet, or unreadable → treat as logged out
  }
}

const LoginInputSchema = z
  .object({
    timeout_ms: z
      .number()
      .int()
      .min(10_000)
      .max(10 * 60_000)
      .default(180_000)
      .describe(
        "How long to wait for login to complete before giving up, in ms (default 180000 = 3m).",
      ),
  })
  .strict();

type LoginInput = z.infer<typeof LoginInputSchema>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The agy runner seam: everything the tool handlers need from the outside world.
 * Prod passes the spawn adapter (runAgy) and the auth-store reader; tests pass
 * fakes and drive the tools through an in-memory MCP client.
 */
export interface AgyDeps {
  runAgy: (args: string[], timeoutMs: number) => Promise<RunResult>;
  readAuthStatus: () => AuthStatus;
}

/** Build the MCP server with all four agy tools registered against the given deps. */
export function createServer(deps: AgyDeps = { runAgy, readAuthStatus }): McpServer {
  const server = new McpServer({ name: "agyenvoy", version: pkgVersion() });

  // -------------------------------------------------------------------------
  // agy_ask
  // -------------------------------------------------------------------------

  server.registerTool(
    "agy_ask",
    {
      title: "Ask agy (Antigravity/Gemini)",
      description: `Send a prompt to the agy CLI (Antigravity, Gemini-backed) and return its response.

Runs agy non-interactively in print mode. Use this for a second opinion from Gemini/Claude/GPT
models, to delegate a self-contained task, or to continue a multi-turn agy conversation.

Args:
  - prompt (string, required): The prompt to send.
  - model (string, optional): A model from agy_list_models (e.g. "Gemini 3.1 Pro (High)"). Omit for default.
  - add_dir (string[], optional): Absolute dirs to add to agy's workspace so it can read those files.
  - project (string, optional): Existing agy project ID.
  - new_project (boolean, default false): Create a new project for this session.
  - continue_conversation (boolean, default false): Continue the most recent conversation.
  - conversation_id (string, optional): Resume a specific conversation by ID (overrides continue_conversation).
  - timeout_ms (number, default 300000): Max wait in ms (1000..1800000).

Returns JSON: { "response": string, "model": string, "exit_code": number }.
On failure exit_code is non-zero and response contains agy's stderr (e.g. binary not found, timeout).

Note: runs agy with --dangerously-skip-permissions so tool actions inside agy are auto-approved
(required for non-interactive use). Only invoke with prompts you trust to run unattended.`,
      inputSchema: AskInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: AskInput) => {
      // Fail fast with an actionable message rather than hanging/erroring inside agy.
      const auth = deps.readAuthStatus();
      if (!auth.logged_in) {
        const out = {
          response: "agy is not logged in. Call agy_login to sign in, then retry.",
          model: params.model ?? "default",
          exit_code: 1,
        };
        return { content: [{ type: "text", text: out.response }], structuredContent: out };
      }

      const { stdout, stderr, code } = await deps.runAgy(buildAskArgs(params), params.timeout_ms);

      const output = {
        response:
          code === 0
            ? stdout.trim()
            : stderr.trim() || stdout.trim() || `agy exited with code ${code}`,
        model: params.model ?? "default",
        exit_code: code,
      };

      return {
        content: [{ type: "text", text: output.response || "(agy returned no output)" }],
        structuredContent: output,
      };
    },
  );

  // -------------------------------------------------------------------------
  // agy_list_models
  // -------------------------------------------------------------------------

  server.registerTool(
    "agy_list_models",
    {
      title: "List agy models",
      description: `List the models available to the agy CLI (runs \`agy models\`).

Use before agy_ask to discover valid values for its 'model' argument.

Takes no arguments. Returns JSON: { "models": string[] } — e.g.
["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)"].`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const { stdout, stderr, code } = await deps.runAgy(["models"], 30_000);
      if (code !== 0) {
        return {
          content: [
            { type: "text", text: `Error listing models: ${stderr.trim() || `exit ${code}`}` },
          ],
          structuredContent: { models: [] },
        };
      }
      const models = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (models.length === 0) {
        // Exit 0 but no output usually means agy couldn't read its config — most
        // often because the server was launched without HOME/PATH in its env.
        return {
          content: [
            {
              type: "text",
              text: "agy returned no models. Check that agy is authenticated and that HOME/PATH reach this server (see README).",
            },
          ],
          structuredContent: { models },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ models }, null, 2) }],
        structuredContent: { models },
      };
    },
  );

  // -------------------------------------------------------------------------
  // agy_auth_status
  // -------------------------------------------------------------------------

  server.registerTool(
    "agy_auth_status",
    {
      title: "Check agy auth status & credit",
      description: `Report whether agy is logged in and how much per-model quota (credit) remains.

Reads agy's local account store (~/.antigravity_tools). Never returns the auth token.

Takes no arguments. Returns JSON:
{
  "logged_in": boolean,          // true if a current account has a valid, non-disabled token
  "email": string | null,        // current account email
  "name": string | null,         // current account display name
  "accounts": string[],          // all known account emails
  "models_quota": [ { "display_name": string, "percentage": number, "reset_time": string } ]
                                  // percentage = remaining credit for that model (100 = full)
}

Use before agy_ask to confirm agy is usable; if logged_in is false, call agy_login.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = deps.readAuthStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    },
  );

  // -------------------------------------------------------------------------
  // agy_login
  // -------------------------------------------------------------------------

  server.registerTool(
    "agy_login",
    {
      title: "Log in to agy (Google auth)",
      description: `Ensure agy is logged in. If already authenticated, returns immediately.

Otherwise opens a terminal window running agy so you can complete Google sign-in in your
browser (agy drives the OAuth flow itself), then polls agy's account store until a valid
account appears and reports the signed-in email.

Args:
  - timeout_ms (number, default 180000): how long to wait for login to complete (10000..600000).

Returns JSON: { "logged_in": boolean, "email": string | null, "already": boolean, "message": string }.
  - already=true means agy was already logged in (no terminal opened).
  - logged_in=false with a message means the wait timed out (finish login and call agy_auth_status).

macOS only (opens Terminal.app). On other platforms, run \`agy\` yourself to log in, then use agy_auth_status.`,
      inputSchema: LoginInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: LoginInput) => {
      const before = deps.readAuthStatus();
      if (before.logged_in) {
        const out = {
          logged_in: true,
          email: before.email,
          already: true,
          message: `Already logged in as ${before.email}.`,
        };
        return { content: [{ type: "text", text: out.message }], structuredContent: out };
      }

      if (process.platform !== "darwin") {
        const out = {
          logged_in: false,
          email: null,
          already: false,
          message:
            "Automatic login is macOS-only. Run `agy` in a terminal to sign in, then call agy_auth_status.",
        };
        return { content: [{ type: "text", text: out.message }], structuredContent: out };
      }

      // Open Terminal.app running agy interactively; agy prompts Google login when logged out.
      // Escape backslashes and quotes so a path can't break out of the AppleScript string.
      const agyBinEscaped = AGY_BIN.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `tell application "Terminal"\n  activate\n  do script "${agyBinEscaped}"\nend tell`;
      spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();

      // Poll the account store until a valid account appears or we time out.
      const deadline = Date.now() + params.timeout_ms;
      while (Date.now() < deadline) {
        await sleep(2000);
        const status = deps.readAuthStatus();
        if (status.logged_in) {
          const out = {
            logged_in: true,
            email: status.email,
            already: false,
            message: `Logged in as ${status.email}.`,
          };
          return { content: [{ type: "text", text: out.message }], structuredContent: out };
        }
      }
      const out = {
        logged_in: false,
        email: null,
        already: false,
        message:
          "Timed out waiting for login. Finish signing in in the opened terminal, then call agy_auth_status.",
      };
      return { content: [{ type: "text", text: out.message }], structuredContent: out };
    },
  );

  return server;
}

async function main() {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("agyenvoy running via stdio");
}

// Only start the server when run directly (node server.mjs / tsx src/index.ts),
// not when imported by tests. Node resolves the main module through symlinks,
// so realpath argv[1] before comparing — otherwise a symlinked install path
// (e.g. a plugin dir reached via symlink) makes the guard fail and the server exits silently.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
