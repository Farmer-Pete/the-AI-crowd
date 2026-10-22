// Claude Code writes ~/.claude/sessions/<pid>.json for every running session.
// It is undocumented, so every field is read defensively.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

export type RegistryEntry = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  // busy, waiting, idle, or shell: idle with a background shell still running (from Claude Code's source)
  status: string;
  statusUpdatedAt: number;
  startedAt?: number; // when this process started
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function readRegistry(): Promise<RegistryEntry[]> {
  let files: string[];
  try { files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: RegistryEntry[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(join(SESSIONS_DIR, f), "utf8"));
      if (typeof s.pid !== "number" || typeof s.sessionId !== "string" || !alive(s.pid)) continue;
      out.push({
        pid: s.pid,
        sessionId: s.sessionId,
        cwd: String(s.cwd ?? ""),
        name: String(s.name ?? ""),
        status: String(s.status ?? ""),
        statusUpdatedAt: Number(s.statusUpdatedAt ?? s.updatedAt ?? Date.now()),
        startedAt: typeof s.startedAt === "number" ? s.startedAt : undefined,
      });
    } catch { /* file mid-write */ }
  }
  return out;
}
