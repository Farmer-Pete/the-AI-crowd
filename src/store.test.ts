import { test } from "node:test";
import assert from "node:assert/strict";
import { ASLEEP_AFTER_MS, UNSEEN_ASLEEP_AFTER_MS, createStore, type HookEvent } from "./store.ts";
import type { RegistryEntry } from "./registry.ts";

function setup() {
  let now = 1_000_000;
  const store = createStore(() => now);
  const hook = (hook_event_name: string, extra: Partial<HookEvent> = {}) =>
    store.applyHook({ hook_event_name, session_id: "s1", cwd: "/work/api", ...extra });
  const one = () => store.view().find((a) => a.id === "s1");
  return { store, hook, one, tick: (ms: number) => (now += ms) };
}

test("a prompt and a tool call make the session work on that tool", () => {
  const { hook, one } = setup();
  hook("UserPromptSubmit");
  hook("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/work/api/src/retry.ts" } });
  assert.equal(one()?.state, "working");
  assert.equal(one()?.tier, "quiet");
  assert.equal(one()?.detail, "Editing src/retry.ts");
});

test("a permission request is urgent and says what it wants", () => {
  const { hook, one } = setup();
  hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Clean the build" } });
  assert.equal(one()?.tier, "urgent");
  assert.equal(one()?.label, "Needs permission");
  assert.equal(one()?.detail, "Clean the build?");
});

test("AskUserQuestion is a question", () => {
  const { hook, one } = setup();
  hook("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Squash the migrations?" }] } });
  assert.equal(one()?.state, "question");
  assert.equal(one()?.detail, "Squash the migrations?");
});

test("a finished turn waits in Review until seen, then sleeps 30 minutes after that", () => {
  const { store, hook, one, tick } = setup();
  hook("Stop", { last_assistant_message: "## Done\nRetries back off now." });
  assert.equal(one()?.tier, "review");
  assert.equal(one()?.detail, "Done");
  tick(2 * ASLEEP_AFTER_MS);
  assert.equal(one()?.tier, "review", "unseen work waits longer than seen work");
  store.markSeen(one()!);
  assert.equal(one()?.tier, "quiet");
  assert.equal(one()?.label, "Seen");
  tick(ASLEEP_AFTER_MS);
  assert.equal(one()?.state, "idle");
  assert.equal(one()?.label, "Asleep");
});

test("a new turn after being seen asks for review again", () => {
  const { store, hook, one, tick } = setup();
  hook("Stop");
  store.markSeen(one()!);
  tick(1000);
  hook("UserPromptSubmit");
  tick(1000);
  hook("Stop");
  assert.equal(one()?.tier, "review");
});

test("the wait clock restarts on a state change, not on a new detail line", () => {
  const { hook, one, tick } = setup();
  hook("UserPromptSubmit");
  const started = one()!.since;
  tick(5000);
  hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/work/api/a.ts" } });
  assert.equal(one()?.since, started);
  hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } });
  assert.equal(one()?.since, started + 5000);
});

test("API failures are urgent errors", () => {
  const { hook, one } = setup();
  hook("StopFailure", { error: "rate_limit" });
  assert.equal(one()?.tier, "urgent");
  assert.equal(one()?.detail, "API error: rate_limit. The turn stopped.");
});

test("subagents come and go as helpers", () => {
  const { hook, one } = setup();
  hook("SubagentStart", { agent_id: "a1", agent_type: "Explore" });
  hook("SubagentStart", { agent_id: "a2", agent_type: "general-purpose" });
  hook("SubagentStop", { agent_id: "a1" });
  assert.deepEqual(one()?.helpers, [{ id: "a2", label: "general-purpose" }]);
});

test("SessionEnd removes the session", () => {
  const { hook, one } = setup();
  hook("UserPromptSubmit");
  hook("SessionEnd");
  assert.equal(one(), undefined);
});

const reg = (status: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
  pid: 1, sessionId: "s1", cwd: "/work/api", name: "api-1", userNamed: false, status, statusUpdatedAt: 900_000, ...extra,
});

test("without hooks, the registry and transcript give a best guess", () => {
  const { store, one } = setup();
  store.applyRegistry([{ reg: reg("busy"), tr: { title: "Retry backoff", lastText: "", tool: { id: "t", name: "Bash", input: { description: "Run tests" }, pending: true } } }]);
  assert.equal(one()?.title, "Retry backoff");
  assert.equal(one()?.detail, "Run tests");
  store.applyRegistry([{ reg: reg("waiting"), tr: { title: "", lastText: "", tool: { id: "t", name: "AskUserQuestion", input: { questions: [{ question: "Ship it?" }] }, pending: true } } }]);
  assert.equal(one()?.state, "question");
  store.applyRegistry([{ reg: reg("idle"), tr: { title: "", lastText: "All 14 tests pass.", tool: undefined } }]);
  assert.equal(one()?.state, "review");
  assert.equal(one()?.detail, "All 14 tests pass.");
  assert.equal(one()?.since, 900_000);
});

test("once hooks arrive, the registry no longer overrides the state", () => {
  const { store, hook, one } = setup();
  hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } });
  store.applyRegistry([{ reg: reg("busy"), tr: { title: "", lastText: "" } }]);
  assert.equal(one()?.state, "permission");
});

test("a session that leaves the registry is dropped", () => {
  const { store, one, tick } = setup();
  store.applyRegistry([{ reg: reg("idle"), tr: { title: "", lastText: "" } }]);
  assert.ok(one());
  tick(20_000);
  store.applyRegistry([]);
  assert.equal(one(), undefined);
});

test("the view puts urgent first, then the longest wait", () => {
  let now = 0;
  const store = createStore(() => now);
  store.applyHook({ hook_event_name: "Stop", session_id: "old-review", cwd: "/a" });
  now = 10;
  store.applyHook({ hook_event_name: "UserPromptSubmit", session_id: "worker", cwd: "/b" });
  now = 20;
  store.applyHook({ hook_event_name: "PermissionRequest", session_id: "asker", cwd: "/c", tool_name: "Bash", tool_input: {} });
  assert.deepEqual(store.view().map((a) => a.id), ["asker", "old-review", "worker"]);
});

const pane = (workspaceTitle: string, surfaceTitle: string, description = "") => ({
  window: "w", workspace: "ws", surface: "sf", tty: "ttys001", workspaceTitle, surfaceTitle, description,
});

test("a renamed cmux workspace names the session, with its description on hover", () => {
  const { store, one } = setup();
  store.applyRegistry([{ reg: reg("idle"), tr: { title: "Jfrog login setup", lastText: "" }, pane: pane("SEG-268: CIDR grid hides first seeded rule", "Jfrog login setup", "Stale blank row") }]);
  assert.equal(one()?.title, "SEG-268: CIDR grid hides first seeded rule");
  assert.equal(one()?.about, "Stale blank row");
});

test("a workspace that only mirrors the terminal title doesn't override the AI title", () => {
  const { store, one } = setup();
  store.applyRegistry([{ reg: reg("idle"), tr: { title: "Retry backoff", lastText: "" }, pane: pane("zsh", "zsh") }]);
  assert.equal(one()?.title, "Retry backoff");
  assert.equal(one()?.about, undefined);
});

test("a /rename beats the AI title, and a renamed workspace beats both", () => {
  const { store, one } = setup();
  const named = reg("idle", { name: "SEG ticket triage", userNamed: true });
  store.applyRegistry([{ reg: named, tr: { title: "SEG-292 installer updater", lastText: "" } }]);
  assert.equal(one()?.title, "SEG ticket triage");
  store.applyRegistry([{ reg: named, tr: { title: "SEG-292 installer updater", lastText: "" }, pane: pane("SEG-300", "zsh") }]);
  assert.equal(one()?.title, "SEG-300");
});

test("a finished turn nobody looks at falls asleep after 2 hours", () => {
  const { hook, one, tick } = setup();
  hook("Stop");
  tick(UNSEEN_ASLEEP_AFTER_MS - 1);
  assert.equal(one()?.tier, "review");
  tick(1);
  assert.equal(one()?.state, "idle");
  assert.equal(one()?.label, "Asleep");
  assert.equal(one()?.tier, "quiet");
});

test("demo agents never doze off on their own", () => {
  let now = 0;
  const store = createStore(() => now);
  const demo = { id: "d", source: "demo" as const, title: "Demo", project: "demo", cwd: "~", state: "review" as const, since: 0, detail: "", helpers: [] };
  now = 10 * UNSEEN_ASLEEP_AFTER_MS;
  assert.equal(store.view([demo])[0]?.state, "review");
});

test("a live session lists its running shells only while the registry says shell", () => {
  const { store, one } = setup();
  const tr = { title: "", lastText: "The box is still building.", shells: [{ id: "b1", label: "Wait for the deploy", at: 5 }] };
  store.applyRegistry([{ reg: reg("shell"), tr }]);
  assert.deepEqual(one()?.shells, [{ id: "b1", label: "Wait for the deploy" }]);
  store.applyRegistry([{ reg: reg("idle"), tr }]);
  assert.deepEqual(one()?.shells, []);
});

test("running shells show only on a Finished desk", () => {
  let now = 0;
  const store = createStore(() => now);
  const shells = [{ id: "s", label: "Start the dev server" }];
  const agent = (state: "review" | "working") => ({ id: state, source: "live" as const, title: "", project: "", cwd: "~", state, since: 0, detail: "", helpers: [], shells });
  const shown = () => store.view([agent("review"), agent("working")]).map((a) => [a.id, a.state, a.shells?.length ?? 0]);
  assert.deepEqual(shown(), [["review", "review", 1], ["working", "working", 0]]);
  now = UNSEEN_ASLEEP_AFTER_MS; // the Finished desk falls asleep
  assert.deepEqual(shown(), [["review", "idle", 0], ["working", "working", 0]]);
});

test("a registry status of shell means the turn finished: a background shell may be a server", () => {
  const { store, one } = setup();
  store.applyRegistry([{ reg: reg("shell"), tr: { title: "", lastText: "Pushed the fix." } }]);
  assert.equal(one()?.state, "review");
  assert.equal(one()?.detail, "Pushed the fix.");
});

const agentTask = (at: number) => ({ id: "a1", label: "Review the design", at });

test("a finished turn with a helper still out waits on it, not on you", () => {
  const { store, hook, one } = setup();
  hook("Stop", { last_assistant_message: "Started a review. I'll report back." });
  store.applyRegistry([{ reg: reg("idle", { startedAt: 100 }), tr: { title: "", lastText: "Started a review. I'll report back.", tasks: [agentTask(200)] } }]);
  assert.equal(one()?.state, "background");
  assert.equal(one()?.tier, "quiet");
  assert.equal(one()?.label, "Waiting on helpers");
  assert.equal(one()?.detail, "1 helper: Review the design");
  assert.deepEqual(one()?.helpers, [{ id: "a1", label: "Review the design" }]);
  store.applyRegistry([{ reg: reg("idle", { startedAt: 100 }), tr: { title: "", lastText: "Done.", tasks: [] } }]);
  assert.equal(one()?.state, "review");
  assert.equal(one()?.detail, "Started a review. I'll report back.");
});

test("when unsure, a desk shows Finished instead of waiting on background work", () => {
  const { store, one } = setup();
  const finished = (tr: object, startedAt = 100) => {
    store.applyRegistry([{ reg: reg("idle", { startedAt }), tr: { title: "", lastText: "", ...tr } }]);
    return one()?.state;
  };
  assert.equal(finished({ tasks: [agentTask(200)] }), "background");
  assert.equal(finished({ lastText: "Which option do you want?", tasks: [agentTask(200)] }), "review", "it asked you something");
  assert.equal(finished({ tasks: [agentTask(200)] }, 300), "review", "launched by an earlier process");
});

test("a prompt, a jump, or a prompt in the transcript sets the last interaction", () => {
  const { store, hook, one, tick } = setup();
  store.applyRegistry([{ reg: reg("idle"), tr: { title: "", lastText: "", promptAt: 500 } }]);
  assert.equal(one()?.touchedAt, 500);
  tick(1000);
  hook("UserPromptSubmit");
  const prompted = one()!.touchedAt!;
  assert.ok(prompted > 500);
  tick(1000);
  store.touch("s1");
  assert.equal(one()?.touchedAt, prompted + 1000);
});

test("demo agents can be touched too", () => {
  let now = 0;
  const store = createStore(() => now);
  const demo = { id: "d", source: "demo" as const, title: "Demo", project: "demo", cwd: "~", state: "working" as const, since: 0, detail: "", helpers: [] };
  assert.equal(store.view([demo])[0]?.touchedAt, undefined);
  now = 42;
  store.touch("d");
  assert.equal(store.view([demo])[0]?.touchedAt, 42);
});
