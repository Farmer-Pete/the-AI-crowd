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
