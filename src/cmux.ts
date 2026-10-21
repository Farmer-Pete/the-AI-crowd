// Finds the cmux pane a Claude Code session runs in, reads its names, and focuses it.
// A hook can report the pane's surface id exactly. Without one, the session's PID
// leads to its terminal (TTY), and `cmux tree` lists the TTY of every terminal surface.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ID = /^[0-9A-Za-z-]{8,64}$/;

export type Target = { window: string; workspace: string; surface: string };

// A terminal surface in cmux, with the names cmux shows for it.
export type PaneInfo = Target & { tty: string; workspaceTitle: string; description: string; surfaceTitle: string };

type Surface = { id: string; tty?: string | null; title?: string };
type Workspace = { id: string; title?: string; description?: string | null; panes?: { surfaces?: Surface[] }[] };
type Tree = { windows?: { id: string; workspaces?: Workspace[] }[] };

async function cmux(args: string[]) {
  return (await run("cmux", args, { timeout: 3000 })).stdout;
}

// Every terminal surface in cmux. Empty when cmux isn't installed or reachable.
export async function readPanes(): Promise<PaneInfo[]> {
  let tree: Tree;
  try { tree = JSON.parse(await cmux(["--json", "tree", "--all", "--id-format", "both"])); } catch { return []; }
  const out: PaneInfo[] = [];
  for (const w of tree.windows ?? []) {
    for (const ws of w.workspaces ?? []) {
      for (const p of ws.panes ?? []) {
        for (const s of p.surfaces ?? []) {
          if (!s.tty) continue;
          out.push({
            window: w.id, workspace: ws.id, surface: s.id, tty: s.tty,
            workspaceTitle: ws.title ?? "", description: ws.description ?? "", surfaceTitle: s.title ?? "",
          });
        }
      }
    }
  }
  return out;
}

// The TTY of each PID, from one `ps` call.
export async function ttysOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  try {
    const { stdout } = await run("ps", ["-o", "pid=,tty=", "-p", pids.join(",")], { timeout: 2000 });
    for (const line of stdout.trim().split("\n")) {
      const [pid, tty] = line.trim().split(/\s+/);
      if (pid && tty && tty !== "??") out.set(Number(pid), tty);
    }
  } catch { /* none alive */ }
  return out;
}

// The pane a session runs in: by the surface id a hook reported, else by the session's TTY.
export function matchPane(panes: PaneInfo[], tty?: string, surface?: string): PaneInfo | undefined {
  if (surface) return panes.find((p) => p.surface.toLowerCase() === surface.toLowerCase());
  return tty ? panes.find((p) => p.tty === tty) : undefined;
}

// Raises the window, shows the workspace, then focuses the session's tab.
export async function focus(t: Target) {
  if (![t.window, t.workspace, t.surface].every((id) => ID.test(id))) throw new Error("unexpected cmux id");
  await cmux(["focus-window", "--window", t.window]);
  await cmux(["select-workspace", "--workspace", t.workspace, "--window", t.window]);
  await cmux(["focus-panel", "--panel", t.surface, "--workspace", t.workspace]);
}
