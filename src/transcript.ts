// Reads the tail of a Claude Code session transcript (~/.claude/projects/<cwd>/<id>.jsonl):
// its AI title, the latest tool call, and the latest assistant text.

import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 512 * 1024;

export type ToolUse = { id: string; name: string; input: Record<string, any>; pending: boolean };
export type Transcript = { title: string; tool?: ToolUse; lastText: string };

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

// Walks the lines newest first. A tool call is pending when no tool_result for it came after.
export function parseTail(text: string): Transcript {
  const out: Transcript = { title: "", lastText: "" };
  const answered = new Set<string>();
  for (const line of text.split("\n").reverse()) {
    if (out.title && out.tool && out.lastText) break;
    if (!line.startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // partial first line
    if (!out.title && rec.type === "ai-title") out.title = rec.aiTitle ?? "";
    const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
    if (rec.type === "user") for (const c of content) if (c.type === "tool_result") answered.add(c.tool_use_id);
    if (rec.type === "assistant") {
      const use = [...content].reverse().find((c) => c.type === "tool_use");
      if (!out.tool && use) out.tool = { id: use.id, name: use.name, input: use.input ?? {}, pending: !answered.has(use.id) };
      const said = content.find((c) => c.type === "text" && c.text.trim());
      if (!out.lastText && said) out.lastText = said.text;
    }
  }
  return out;
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
