import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTool, firstLine, parseTail } from "./transcript.ts";

const line = (o: object) => JSON.stringify(o);

test("a tool call with no result after it is pending", () => {
  const tail = [
    `{"partial line from the middle of the file`,
    line({ type: "ai-title", aiTitle: "Retry backoff" }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: {} }] } }),
  ].join("\n");
  const t = parseTail(tail);
  assert.equal(t.title, "Retry backoff");
  assert.equal(t.tool?.id, "t2");
  assert.equal(t.tool?.pending, true);
  assert.equal(t.lastText, "Running the tests.");
});

test("an answered tool call is not pending", () => {
  const tail = [
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  ].join("\n");
  assert.equal(parseTail(tail).tool?.pending, false);
});

test("tool calls read as short phrases", () => {
  assert.equal(describeTool("Bash", { command: "npm test", description: "Run the tests" }, "/w"), "Run the tests");
  assert.equal(describeTool("Bash", { command: "npm test" }, "/w"), "Running npm test");
  assert.equal(describeTool("Read", { file_path: "/w/src/a.ts" }, "/w"), "Reading src/a.ts");
  assert.equal(describeTool("mcp__claude_ai_Slack__slack_read_channel", {}, "/w"), "Using slack read channel (Slack)");
});

test("firstLine takes the first real line without markdown", () => {
  assert.equal(firstLine("\n## **Done.** All `14` tests pass\nmore"), "Done. All 14 tests pass");
  assert.equal(firstLine(undefined), "");
});

test("the newest human prompt sets promptAt; tool results don't", () => {
  const tail = [
    line({ type: "user", origin: { kind: "human" }, timestamp: "2026-10-22T07:30:45.941Z", message: { content: "Fix the grid" } }),
    line({ type: "user", timestamp: "2026-10-22T07:31:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  ].join("\n");
  assert.equal(parseTail(tail).promptAt, Date.parse("2026-10-22T07:30:45.941Z"));
});

// Records shaped like Claude Code's: a launch's toolUseResult, then a queued <task-notification>.
const launch = (at: string, toolUseResult: object, tool_use_id = "t1") =>
  line({ type: "user", timestamp: at, toolUseResult, message: { content: [{ type: "tool_result", tool_use_id }] } });
const notify = (id: string, status: string) =>
  line({ type: "queue-operation", operation: "enqueue", content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` });
const shell = (id: string, description: string, at: string) => [
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: { command: "x", description, run_in_background: true } }] } }),
  launch(at, { stdout: "", stderr: "", backgroundTaskId: id }, `t-${id}`),
];

test("a background agent stays open until its notification has a status", () => {
  const agent = launch("2026-10-22T10:00:00Z", { isAsync: true, status: "async_launched", agentId: "a1", description: "Review the design" });
  assert.deepEqual(parseTail(agent).tasks, [{ id: "a1", kind: "agent", label: "Review the design", at: Date.parse("2026-10-22T10:00:00Z") }]);
  assert.deepEqual(parseTail([agent, notify("a1", "completed")].join("\n")).tasks, []);
});

test("a Monitor takes its label from the call and closes on expiry or TaskStop", () => {
  const call = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Monitor", input: { description: "CI on PR #212" } }] } });
  const started = launch("2026-10-22T10:00:00Z", { taskId: "m1", timeoutMs: 60_000, persistent: false }, "t9");
  const [task] = parseTail([call, started].join("\n")).tasks ?? [];
  assert.ok(task);
  assert.equal(task.label, "CI on PR #212");
  assert.equal(task.expiresAt, Date.parse("2026-10-22T10:01:00Z"));
  const event = line({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>m1</task-id>\n<event>PR approved</event>\n</task-notification>" });
  assert.equal(parseTail([call, started, event].join("\n")).tasks?.length, 1, "an event alone doesn't end it");
  const expired = line({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>m1</task-id>\n<event>[Monitor expired after 1m]</event>\n</task-notification>" });
  assert.deepEqual(parseTail([call, started, expired].join("\n")).tasks, []);
  const stopped = launch("2026-10-22T10:00:30Z", { message: "Successfully stopped task: m1", task_id: "m1", task_type: "monitor_mcp" }, "t10");
  assert.deepEqual(parseTail([call, started, stopped].join("\n")).tasks, []);
});

test("workflows count; background shells don't", () => {
  const tail = [
    launch("2026-10-22T10:00:00Z", { status: "async_launched", taskId: "w1", taskType: "local_workflow", workflowName: "review-changes" }),
    launch("2026-10-22T10:00:01Z", { stdout: "", stderr: "", backgroundTaskId: "b1" }, "t2"),
  ].join("\n");
  assert.deepEqual(parseTail(tail).tasks?.map((t) => [t.kind, t.label]), [["workflow", "review-changes"]]);
});

test("a background shell counts only when its description says it waits", () => {
  const tail = [
    ...shell("b1", "Watch the OD1 build until it finishes", "2026-10-22T10:00:00Z"),
    ...shell("b2", "Start the dev server", "2026-10-22T10:00:01Z"),
    ...shell("b3", "Wait for the ephemeral to start", "2026-10-22T10:00:02Z"),
    notify("b3", "completed"),
  ].join("\n");
  assert.deepEqual(parseTail(tail).tasks?.map((t) => [t.kind, t.label]), [["shell", "Watch the OD1 build until it finishes"]]);
});
