// Tests run against the built output (`npm test` builds dist/ first, then node --test).
//
// Two layers:
//  - pure units: auth-store parsing (readAuthStatus) and argv assembly (buildAskArgs)
//  - the four MCP tools, driven through a real MCP client over an in-memory
//    transport, with fakes at the agy runner seam (no agy binary involved)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, readAuthStatus, buildAskArgs } from "../dist/index.js";

/** Build a fake ~/.antigravity_tools store and return its path. */
function makeStore(acct) {
  const dir = mkdtempSync(join(tmpdir(), "agy-test-"));
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({ accounts: [{ id: "a1", email: "u@example.com" }], current_account_id: "a1" }),
  );
  mkdirSync(join(dir, "accounts"));
  writeFileSync(join(dir, "accounts", "a1.json"), JSON.stringify(acct));
  return dir;
}

// ---------------------------------------------------------------------------
// Pure units
// ---------------------------------------------------------------------------

test("readAuthStatus: valid token → logged in with quota", () => {
  const dir = makeStore({
    email: "u@example.com",
    name: "U",
    token: "tok",
    quota: { models: [{ display_name: "Gemini", percentage: 50, reset_time: "soon" }] },
  });
  const s = readAuthStatus(dir);
  assert.equal(s.logged_in, true);
  assert.equal(s.email, "u@example.com");
  assert.deepEqual(s.models_quota, [
    { display_name: "Gemini", percentage: 50, reset_time: "soon" },
  ]);
});

test("readAuthStatus: disabled account → logged out", () => {
  const s = readAuthStatus(makeStore({ email: "u@example.com", token: "tok", disabled: true }));
  assert.equal(s.logged_in, false);
});

test("readAuthStatus: missing token → logged out", () => {
  const s = readAuthStatus(makeStore({ email: "u@example.com" }));
  assert.equal(s.logged_in, false);
});

test("readAuthStatus: missing store → logged out, empty", () => {
  const s = readAuthStatus("/nonexistent/agy-tools");
  assert.deepEqual(s, {
    logged_in: false,
    email: null,
    name: null,
    accounts: [],
    models_quota: [],
  });
});

test("buildAskArgs: conversation_id takes precedence over continue_conversation", () => {
  const args = buildAskArgs({
    prompt: "hi",
    conversation_id: "c1",
    continue_conversation: true,
    new_project: false,
    timeout_ms: 1000,
  });
  assert.deepEqual(args.slice(0, 3), ["--dangerously-skip-permissions", "--conversation", "c1"]);
  assert.ok(!args.includes("--continue"));
  assert.deepEqual(args.slice(-2), ["--print", "hi"]);
});

test("buildAskArgs: full options in order, prompt last", () => {
  const args = buildAskArgs({
    prompt: "do it",
    model: "Gemini 3.1 Pro (High)",
    add_dir: ["/a", "/b"],
    project: "p1",
    new_project: true,
    continue_conversation: true,
    timeout_ms: 1000,
  });
  assert.deepEqual(args, [
    "--dangerously-skip-permissions",
    "--continue",
    "--model",
    "Gemini 3.1 Pro (High)",
    "--project",
    "p1",
    "--new-project",
    "--add-dir",
    "/a",
    "--add-dir",
    "/b",
    "--print",
    "do it",
  ]);
});

// ---------------------------------------------------------------------------
// Tools, through the MCP interface with fakes at the agy runner seam
// ---------------------------------------------------------------------------

const LOGGED_IN = {
  logged_in: true,
  email: "u@example.com",
  name: "U",
  accounts: ["u@example.com"],
  models_quota: [],
};
const LOGGED_OUT = { logged_in: false, email: null, name: null, accounts: [], models_quota: [] };

/** Connect a real MCP client to a server built on the given deps. */
async function connect(deps) {
  const server = createServer(deps);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Deps whose runner records its calls and returns a canned result. */
function fakeDeps({ auth = LOGGED_IN, result = { stdout: "", stderr: "", code: 0 } } = {}) {
  const calls = [];
  return {
    calls,
    runAgy: async (args, timeoutMs) => {
      calls.push({ args, timeoutMs });
      return result;
    },
    readAuthStatus: () => auth,
  };
}

test("agy_ask: success → trimmed stdout, exit_code 0, argv from buildAskArgs", async () => {
  const deps = fakeDeps({ result: { stdout: "hello world\n", stderr: "", code: 0 } });
  const client = await connect(deps);
  const res = await client.callTool({ name: "agy_ask", arguments: { prompt: "hi" } });
  assert.deepEqual(res.structuredContent, {
    response: "hello world",
    model: "default",
    exit_code: 0,
  });
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(deps.calls[0].args, ["--dangerously-skip-permissions", "--print", "hi"]);
  assert.equal(deps.calls[0].timeoutMs, 300_000); // schema default applied
});

test("agy_ask: non-zero exit → stderr wins, then stdout, then exit-code message", async () => {
  const stderrDeps = fakeDeps({ result: { stdout: "partial\n", stderr: "boom\n", code: 1 } });
  let res = await (
    await connect(stderrDeps)
  ).callTool({ name: "agy_ask", arguments: { prompt: "hi" } });
  assert.deepEqual(res.structuredContent, { response: "boom", model: "default", exit_code: 1 });

  const silentDeps = fakeDeps({ result: { stdout: "", stderr: "", code: 2 } });
  res = await (
    await connect(silentDeps)
  ).callTool({ name: "agy_ask", arguments: { prompt: "hi" } });
  assert.deepEqual(res.structuredContent, {
    response: "agy exited with code 2",
    model: "default",
    exit_code: 2,
  });
});

test("agy_ask: logged out → gate message, agy never runs", async () => {
  const deps = fakeDeps({ auth: LOGGED_OUT });
  const res = await (
    await connect(deps)
  ).callTool({ name: "agy_ask", arguments: { prompt: "hi" } });
  assert.equal(res.structuredContent.exit_code, 1);
  assert.match(res.structuredContent.response, /not logged in/);
  assert.equal(deps.calls.length, 0);
});

test("agy_list_models: parses lines, skips blanks", async () => {
  const deps = fakeDeps({
    result: {
      stdout: "Gemini 3.1 Pro (High)\n\n  Claude Opus 4.6 (Thinking)  \n",
      stderr: "",
      code: 0,
    },
  });
  const res = await (await connect(deps)).callTool({ name: "agy_list_models", arguments: {} });
  assert.deepEqual(res.structuredContent, {
    models: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)"],
  });
  assert.deepEqual(deps.calls[0].args, ["models"]);
});

test("agy_list_models: non-zero exit → error text, empty models", async () => {
  const deps = fakeDeps({ result: { stdout: "", stderr: "no config\n", code: 1 } });
  const res = await (await connect(deps)).callTool({ name: "agy_list_models", arguments: {} });
  assert.deepEqual(res.structuredContent, { models: [] });
  assert.match(res.content[0].text, /Error listing models: no config/);
});

test("agy_list_models: exit 0 with no output → HOME/PATH diagnosis", async () => {
  const deps = fakeDeps({ result: { stdout: "\n", stderr: "", code: 0 } });
  const res = await (await connect(deps)).callTool({ name: "agy_list_models", arguments: {} });
  assert.deepEqual(res.structuredContent, { models: [] });
  assert.match(res.content[0].text, /HOME\/PATH/);
});

test("agy_auth_status: passes through the auth reader's status", async () => {
  const res = await (
    await connect(fakeDeps({ auth: LOGGED_IN }))
  ).callTool({ name: "agy_auth_status", arguments: {} });
  assert.deepEqual(res.structuredContent, LOGGED_IN);
});

test("agy_login: already logged in → short-circuits, no terminal", async () => {
  const res = await (
    await connect(fakeDeps({ auth: LOGGED_IN }))
  ).callTool({ name: "agy_login", arguments: {} });
  assert.deepEqual(res.structuredContent, {
    logged_in: true,
    email: "u@example.com",
    already: true,
    message: "Already logged in as u@example.com.",
  });
});
