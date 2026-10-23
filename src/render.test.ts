import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, renderList } from "./render.ts";
import type { ViewAgent } from "./types.ts";

const agent = (over: Partial<ViewAgent> = {}): ViewAgent => ({
  id: "s1", source: "live", title: "Retry backoff", project: "api", cwd: "~/api", state: "working",
  since: 0, detail: "Editing src/a.ts", helpers: [], tier: "quiet", label: "Working", detailLabel: "Now", ...over,
});

test("esc neutralises markup, quotes, and control characters", () => {
  assert.equal(esc(`<script>"x"</script>'`), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;&#39;");
  assert.equal(esc("a\nb\u0000c"), "a b c");
});

test("transcript text can't inject markup or Datastar attributes", () => {
  const html = renderList([agent({ title: `<img src=x data-on:load="alert(1)">`, detail: `<script>alert(1)</script>` })], 0);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes(`data-on:load="alert`));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("rows carry their id only when it is safe", () => {
  assert.ok(renderList([agent()], 0).includes(`data-id="s1"`));
  assert.ok(!renderList([agent({ id: "x');alert(1);('" })], 0).includes("data-id"));
  assert.ok(!renderList([agent()], 0).includes("data-on:"));
});

test("the list stays on one line per SSE data field", () => {
  assert.ok(!renderList([agent({ detail: "line one\nline two" })], 0).includes("\n"));
});

test("ended agents leave the list but helpers show under their parent", () => {
  const html = renderList([agent({ id: "gone", state: "ended" }), agent({ helpers: [{ id: "h", label: "Explore" }] })], 0);
  assert.ok(!html.includes("/api/jump/gone"));
  assert.ok(html.includes("↳ helper: Explore"));
});
