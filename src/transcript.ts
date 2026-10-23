// Reads the tail of a Claude Code session transcript (~/.claude/projects/<cwd>/<id>.jsonl):
// its AI title, the latest tool call, the latest assistant text, and the background tasks still open.

import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 512 * 1024;

// A JSON object from the transcript. The format is undocumented, so every field is unknown until checked.
export type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

type ToolUse = { id: string; name: string; input: Rec; pending: boolean };
// A helper the session will hear back from: a background agent or a workflow. Monitors and background
// shells are left out: they only listen, and what they listen for may be CI, a reviewer, or you.
export type Task = { id: string; label: string; at: number };
// promptAt: when you last typed a prompt (a "user" record with origin.kind "human").
export type Transcript = { title: string; tool?: ToolUse; lastText: string; promptAt?: number; tasks?: Task[] };

const cache = new Map<string, Transcript & { mtimeMs: number }>();

export const transcriptPath = (cwd: string, sessionId: string) =>
  join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

export async function readTranscript(path: string): Promise<Transcript> {
  try {
    const st = await stat(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit;
    const fh = await open(path, "r");
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    await fh.close();
    const out = { mtimeMs: st.mtimeMs, ...parseTail(buf.toString("utf8")) };
    cache.set(path, out);
    return out;
  } catch {
    return { title: "", lastText: "" };
  }
}

export function parseTail(text: string): Transcript {
  const recs: Rec[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { recs.push(obj(JSON.parse(line))); } catch { /* partial first line */ }
  }
  return { ...latest(recs), tasks: openTasks(recs) };
}

const contentOf = (rec: Rec): Rec[] => {
  const content = obj(rec.message).content;
  return Array.isArray(content) ? content.map(obj) : [];
};
const timeOf = (rec: Rec) => Date.parse(str(rec.timestamp) ?? "");

// Walks the records newest first. A tool call is pending when no tool_result for it came after.
function latest(recs: Rec[]): Transcript {
  const out: Transcript = { title: "", lastText: "" };
  const answered = new Set<unknown>();
  for (const rec of recs.toReversed()) {
    if (out.title && out.tool && out.lastText && out.promptAt) break;
    if (!out.title && rec.type === "ai-title") out.title = str(rec.aiTitle) ?? "";
    const content = contentOf(rec);
    if (rec.type === "user") for (const c of content) if (c.type === "tool_result") answered.add(c.tool_use_id);
    if (!out.promptAt && rec.type === "user" && obj(rec.origin).kind === "human") out.promptAt = timeOf(rec) || undefined;
    if (rec.type === "assistant") {
      const use = content.findLast((c) => c.type === "tool_use");
      if (!out.tool && use) out.tool = { id: str(use.id) ?? "", name: str(use.name) ?? "", input: obj(use.input), pending: !answered.has(use.id) };
      const said = content.map((c) => (c.type === "text" ? str(c.text) : undefined)).find((t) => t?.trim());
      if (!out.lastText && said) out.lastText = said;
    }
  }
  return out;
}

// Walks the records oldest first. Claude Code records each launch in the tool result's toolUseResult,
// and says a task ended with a <task-notification> that carries a <status>, or with a TaskStop result.
function openTasks(recs: Rec[]): Task[] {
  const running = new Map<string, Task>();
  for (const rec of recs) {
    const at = timeOf(rec) || 0;
    if (rec.type === "user") {
      const r = obj(rec.toolUseResult);
      if (r.status === "async_launched" && typeof r.agentId === "string") {
        running.set(r.agentId, { id: r.agentId, label: String(r.description || "a helper"), at });
      } else if (r.status === "async_launched" && r.taskType === "local_workflow" && typeof r.taskId === "string") {
        running.set(r.taskId, { id: r.taskId, label: String(r.workflowName || "a workflow"), at });
      }
      if (typeof r.task_id === "string") running.delete(r.task_id); // TaskStop
    }
    for (const note of notifications(rec)) {
      const id = note.match(/<task-id>(\w+)<\/task-id>/)?.[1];
      if (id && /<status>\w+<\/status>/.test(note)) running.delete(id);
    }
  }
  return [...running.values()];
}

// A notification is queued (a queue-operation), then delivered as a queued command or a user message.
function notifications(rec: Rec): string[] {
  const texts = [rec.type === "queue-operation" ? rec.content : undefined, obj(rec.attachment).prompt, rec.type === "user" ? obj(rec.message).content : undefined];
  return texts.filter((t): t is string => typeof t === "string" && t.includes("<task-notification>"));
}

export const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function shortPath(p: unknown, cwd: string): string {
  if (typeof p !== "string" || !p) return "";
  const rel = isAbsolute(p) ? relative(cwd, p) : p;
  return rel.startsWith("..") ? p.replace(homedir(), "~") : rel;
}

// Turns a tool call into a short phrase: "Editing src/auth.ts", "Running the tests".
export function describeTool(name: string, i: Rec, cwd: string): string {
  switch (name) {
    case "Bash": return i.description ? short(String(i.description)) : `Running ${short(String(i.command ?? ""), 60)}`;
    case "Edit": case "MultiEdit": return `Editing ${shortPath(i.file_path, cwd)}`;
    case "Write": return `Writing ${shortPath(i.file_path, cwd)}`;
    case "Read": return `Reading ${shortPath(i.file_path, cwd)}`;
    case "Grep": return `Searching for "${short(String(i.pattern ?? ""), 40)}"`;
    case "Glob": return `Finding files ${short(String(i.pattern ?? ""), 40)}`;
    case "Agent": case "Task": return `Delegating: ${short(String(i.description ?? i.subagent_type ?? "a subtask"), 60)}`;
    case "Skill": return `Running the ${String(i.skill)} skill`;
    case "WebFetch": return `Fetching ${short(String(i.url ?? ""), 60)}`;
    case "AskUserQuestion": {
      const question = Array.isArray(i.questions) ? str(obj(i.questions[0]).question) : undefined;
      return short(question ?? "Asking you a question");
    }
  }
  const [, server, tool] = name.match(/^mcp__(.+?)__(.+)$/) ?? [];
  if (server && tool) return `Using ${tool.replace(/_/g, " ")} (${server.replace(/^claude_ai_/, "")})`;
  return `Using ${name}`;
}

export function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*`_]/g, "").trim()).find(Boolean) ?? "";
  return short(line, 140);
}
