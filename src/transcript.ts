// Reads the tail of a Claude Code session transcript (~/.claude/projects/<cwd>/<id>.jsonl):
// its AI title, the latest tool call, the latest assistant text, and the background tasks still open.

import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 512 * 1024;

export type ToolUse = { id: string; name: string; input: Record<string, any>; pending: boolean };
// A background task the session will hear back from: a helper agent, a workflow, or a Monitor.
// Background shells are left out. A dev server and a build look the same, and only one is awaited.
export type Task = { id: string; kind: "agent" | "workflow" | "monitor"; label: string; at: number; expiresAt?: number; persistent?: boolean };
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
  const recs: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { recs.push(JSON.parse(line)); } catch { /* partial first line */ }
  }
  return { ...latest(recs), tasks: openTasks(recs) };
}

const contentOf = (rec: any): any[] => (Array.isArray(rec.message?.content) ? rec.message.content : []);

// Walks the records newest first. A tool call is pending when no tool_result for it came after.
function latest(recs: any[]): Transcript {
  const out: Transcript = { title: "", lastText: "" };
  const answered = new Set<string>();
  for (let i = recs.length - 1; i >= 0; i--) {
    if (out.title && out.tool && out.lastText && out.promptAt) break;
    const rec = recs[i];
    if (!out.title && rec.type === "ai-title") out.title = rec.aiTitle ?? "";
    const content = contentOf(rec);
    if (rec.type === "user") for (const c of content) if (c.type === "tool_result") answered.add(c.tool_use_id);
    if (!out.promptAt && rec.type === "user" && rec.origin?.kind === "human" && rec.timestamp) out.promptAt = Date.parse(rec.timestamp) || undefined;
    if (rec.type === "assistant") {
      const use = [...content].reverse().find((c) => c.type === "tool_use");
      if (!out.tool && use) out.tool = { id: use.id, name: use.name, input: use.input ?? {}, pending: !answered.has(use.id) };
      const said = content.find((c) => c.type === "text" && c.text.trim());
      if (!out.lastText && said) out.lastText = said.text;
    }
  }
  return out;
}

// Walks the records oldest first. Claude Code records each launch in the tool result's toolUseResult,
// and says a task ended with a <task-notification> that carries a <status> (a Monitor's last one
// says it expired instead), or with a TaskStop result.
function openTasks(recs: any[]): Task[] {
  const open = new Map<string, Task>();
  const inputs = new Map<string, Record<string, any>>(); // tool_use id -> input, for a Monitor's description
  for (const rec of recs) {
    const at = Date.parse(rec.timestamp) || 0;
    if (rec.type === "assistant") for (const c of contentOf(rec)) if (c.type === "tool_use") inputs.set(c.id, c.input ?? {});
    const r = rec.type === "user" ? rec.toolUseResult : undefined;
    if (r && typeof r === "object") {
      if (r.status === "async_launched" && typeof r.agentId === "string") {
        open.set(r.agentId, { id: r.agentId, kind: "agent", label: String(r.description || "a helper"), at });
      } else if (r.status === "async_launched" && r.taskType === "local_workflow" && typeof r.taskId === "string") {
        open.set(r.taskId, { id: r.taskId, kind: "workflow", label: String(r.workflowName || "a workflow"), at });
      } else if (typeof r.taskId === "string" && typeof r.timeoutMs === "number") {
        const input = inputs.get(contentOf(rec).find((c) => c.type === "tool_result")?.tool_use_id) ?? {};
        open.set(r.taskId, { id: r.taskId, kind: "monitor", label: String(input.description || "a Monitor"), at, expiresAt: at + r.timeoutMs, persistent: r.persistent === true });
      }
      if (typeof r.task_id === "string") open.delete(r.task_id); // TaskStop
    }
    for (const note of notifications(rec)) {
      const id = note.match(/<task-id>(\w+)<\/task-id>/)?.[1];
      if (id && (/<status>\w+<\/status>/.test(note) || note.includes("[Monitor expired"))) open.delete(id);
    }
  }
  return [...open.values()];
}

// A notification is queued (a queue-operation), then delivered as a queued command or a user message.
function notifications(rec: any): string[] {
  const texts = [rec.type === "queue-operation" ? rec.content : undefined, rec.attachment?.prompt, rec.type === "user" ? rec.message?.content : undefined];
  return texts.filter((t): t is string => typeof t === "string" && t.includes("<task-notification>"));
}

export const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function shortPath(p: unknown, cwd: string): string {
  if (typeof p !== "string" || !p) return "";
  const rel = isAbsolute(p) ? relative(cwd, p) : p;
  return rel.startsWith("..") ? p.replace(homedir(), "~") : rel;
}

// Turns a tool call into a short phrase: "Editing src/auth.ts", "Running the tests".
export function describeTool(name: string, input: Record<string, any>, cwd: string): string {
  const i = input ?? {};
  switch (name) {
    case "Bash": return i.description ? short(String(i.description)) : `Running ${short(String(i.command ?? ""), 60)}`;
    case "Edit": case "MultiEdit": return `Editing ${shortPath(i.file_path, cwd)}`;
    case "Write": return `Writing ${shortPath(i.file_path, cwd)}`;
    case "Read": return `Reading ${shortPath(i.file_path, cwd)}`;
    case "Grep": return `Searching for "${short(String(i.pattern ?? ""), 40)}"`;
    case "Glob": return `Finding files ${short(String(i.pattern ?? ""), 40)}`;
    case "Agent": case "Task": return `Delegating: ${short(String(i.description ?? i.subagent_type ?? "a subtask"), 60)}`;
    case "Skill": return `Running the ${i.skill} skill`;
    case "WebFetch": return `Fetching ${short(String(i.url ?? ""), 60)}`;
    case "AskUserQuestion": return short(String(i.questions?.[0]?.question ?? "Asking you a question"));
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[2].replace(/_/g, " ")} (${mcp[1].replace(/^claude_ai_/, "")})`;
  return `Using ${name}`;
}

export function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*`_]/g, "").trim()).find(Boolean) ?? "";
  return short(line, 140);
}
