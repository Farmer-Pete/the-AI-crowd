// Keeps every live Claude Code session and works out what each one needs from you.
// Two sources feed it: hook events from the plugin (exact), and the session registry
// plus transcript tail (a guess, used for sessions that have sent no hook events).

import { basename } from "node:path";
import { homedir } from "node:os";
import type { Agent, State, Tier, ViewAgent } from "./types.ts";
import { describeTool, firstLine, short, type Task, type Transcript } from "./transcript.ts";
import type { RegistryEntry } from "./registry.ts";
import type { PaneInfo } from "./cmux.ts";

// A Finished session falls asleep 30 minutes after you've seen it,
export const ASLEEP_AFTER_MS = 30 * 60_000;
// or 2 hours after it finished if you never looked. Live sessions only: the demo's Finished desk stays put.
export const UNSEEN_ASLEEP_AFTER_MS = 2 * 60 * 60_000;
// A hooked session missing from the registry for this long is treated as gone.
const HOOK_GRACE_MS = 10_000;

export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  error?: string;
  agent_id?: string;
  agent_type?: string;
};

// Where the session runs in cmux, when a hook reported it.
export type Pane = { surface?: string; workspace?: string };

type Session = Agent & {
  cwdAbs: string;
  pid?: number;
  hooked: boolean;
  lastHookAt: number;
  pane: Pane;
  target?: PaneInfo;
  helperTypes: Map<string, string>;
  awaiting: Task[]; // background tasks it waits on, from the transcript
};

const URGENT = new Set<State>(["permission", "question", "error", "waiting"]);
const TIER_ORDER: Record<Tier, number> = { urgent: 0, review: 1, quiet: 2 };
const LABEL: Record<State, string> = {
  working: "Working", background: "Waiting on helpers", permission: "Needs permission", question: "Asked you", error: "Errored",
  waiting: "Needs you", review: "Finished", idle: "Asleep", ended: "Left",
};

const tilde = (p: string) => p.replace(homedir(), "~");

export function createStore(clock: () => number = Date.now) {
  const sessions = new Map<string, Session>();
  const seen = new Map<string, { since: number; at: number }>();
  const touched = new Map<string, number>(); // id -> when you last prompted it or jumped to it
  let hooksSeen = false;

  function session(id: string, cwd: string): Session {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id, source: "live", title: "", project: basename(cwd), cwd: tilde(cwd), cwdAbs: cwd,
        state: "idle", since: clock(), detail: "", helpers: [],
        hooked: false, lastHookAt: 0, pane: {}, helperTypes: new Map(), awaiting: [],
      };
      sessions.set(id, s);
    }
    return s;
  }

  // The wait clock restarts only when the state changes, not when the detail line does.
  function set(s: Session, state: State, detail: string, since = clock()) {
    if (s.state !== state) s.since = since;
    s.state = state;
    s.detail = detail;
  }

  function applyHook(e: HookEvent, pane: Pane = {}) {
    if (!e?.session_id || !e.hook_event_name) return;
    hooksSeen = true;
    if (e.hook_event_name === "SessionEnd") { sessions.delete(e.session_id); return; }
    const s = session(e.session_id, e.cwd ?? "");
    s.hooked = true;
    s.lastHookAt = clock();
    if (pane.surface) s.pane = pane;
    const tool = () => describeTool(e.tool_name ?? "", e.tool_input ?? {}, e.cwd ?? s.cwdAbs);
    switch (e.hook_event_name) {
      case "SessionStart": set(s, "idle", "Ready for a prompt"); break;
      case "UserPromptSubmit": set(s, "working", "Thinking"); touched.set(s.id, clock()); break;
      case "PreToolUse": set(s, e.tool_name === "AskUserQuestion" ? "question" : "working", tool()); break;
      case "PostToolUse": set(s, "working", tool()); break;
      case "PermissionRequest": set(s, "permission", `${tool()}?`); break;
      case "Notification":
        if (e.notification_type === "permission_prompt" && s.state !== "permission") set(s, "permission", short(e.message ?? "Needs your permission"));
        if (e.notification_type === "elicitation_dialog" || e.notification_type === "agent_needs_input") set(s, "question", short(e.message ?? "Asking you something"));
        break; // idle_prompt changes nothing: Stop already marked the turn finished
      case "Stop": set(s, "review", firstLine(e.last_assistant_message) || "Finished a turn"); s.helperTypes.clear(); break;
      case "StopFailure": set(s, "error", `API error: ${e.error ?? "unknown"}. The turn stopped.`); break;
      case "SubagentStart": if (e.agent_id) s.helperTypes.set(e.agent_id, e.agent_type || "helper"); break;
      case "SubagentStop": if (e.agent_id) s.helperTypes.delete(e.agent_id); break;
    }
  }

  // Without hooks, the registry status plus the transcript tail is the best guess.
  function infer(s: Session, reg: RegistryEntry, tr: Transcript) {
    const at = reg.statusUpdatedAt;
    if (reg.status === "busy") set(s, "working", tr.tool ? describeTool(tr.tool.name, tr.tool.input, reg.cwd) : "Thinking", at);
    else if (reg.status === "waiting" && tr.tool?.pending) {
      // A tool call with no result yet is waiting on a prompt: a question if it's AskUserQuestion.
      const ask = tr.tool.name === "AskUserQuestion";
      const what = describeTool(tr.tool.name, tr.tool.input, reg.cwd);
      set(s, ask ? "question" : "permission", ask ? what : `${what}?`, at);
    } else if (reg.status === "waiting") set(s, "waiting", "Waiting on you", at);
    // "idle" and "shell" both mean the turn ended. "shell" adds a background shell, which may be a server
    // nobody waits on, so it doesn't count as background work.
    else if (reg.status === "idle" || reg.status === "shell") set(s, "review", firstLine(tr.lastText) || "Finished a turn", at);
    else set(s, "idle", firstLine(tr.lastText), at);
  }

  // Claude Code names a session once, early on. A cmux workspace someone renamed (its title
  // differs from the terminal's own title) says better what the session works on now.
  function applyRegistry(entries: { reg: RegistryEntry; tr: Transcript; pane?: PaneInfo }[]) {
    const ids = new Set(entries.map((e) => e.reg.sessionId));
    for (const { reg, tr, pane } of entries) {
      const s = session(reg.sessionId, reg.cwd);
      s.pid = reg.pid;
      s.cwdAbs = reg.cwd;
      s.cwd = tilde(reg.cwd);
      s.project = basename(reg.cwd);
      const renamed = pane && pane.workspaceTitle && pane.workspaceTitle !== pane.surfaceTitle ? pane : undefined;
      s.title = renamed?.workspaceTitle || tr.title || reg.name || s.project;
      s.touchedAt = tr.promptAt;
      s.about = renamed?.description || undefined;
      s.target = pane;
      s.awaiting = awaited(tr, reg.startedAt ?? 0, clock());
      if (!s.hooked) infer(s, reg, tr);
    }
    for (const [id, s] of sessions) if (!ids.has(id) && clock() - s.lastHookAt > HOOK_GRACE_MS) sessions.delete(id);
  }

  function decorate(a: Agent): ViewAgent {
    const mark = seen.get(a.id);
    const seenIt = a.state === "review" && mark?.since === a.since;
    const asleep = seenIt
      ? clock() - mark!.at >= ASLEEP_AFTER_MS
      : a.state === "review" && a.source === "live" && clock() - a.since >= UNSEEN_ASLEEP_AFTER_MS;
    const state: State = asleep ? "idle" : a.state;
    const tier: Tier = URGENT.has(state) ? "urgent" : state === "review" && !seenIt ? "review" : "quiet";
    const label = state === "review" && seenIt ? "Seen" : LABEL[state];
    const touchedAt = Math.max(touched.get(a.id) ?? 0, a.touchedAt ?? 0) || undefined;
    return { ...a, state, tier, label, touchedAt };
  }

  // Everyone, urgent first, then longest waiting first.
  function view(demo: Agent[] = []): ViewAgent[] {
    const live: Agent[] = [...sessions.values()].map(({ cwdAbs, pid, hooked, lastHookAt, pane, target, helperTypes, awaiting, ...a }) => {
      const title = a.title || a.project;
      // A finished turn with tasks still out waits on them, not on you.
      if (a.state === "review" && awaiting.length) {
        const helpers = awaiting.filter((t) => t.kind !== "monitor").map(({ id, label }) => ({ id, label }));
        return { ...a, title, state: "background" as const, detail: waitLine(awaiting), helpers };
      }
      return { ...a, title, helpers: [...helperTypes].map(([id, label]) => ({ id, label })) };
    });
    const all = [...demo, ...live];
    for (const marks of [seen, touched]) for (const id of marks.keys()) if (!all.some((a) => a.id === id)) marks.delete(id);
    return all.map(decorate).sort((x, y) => TIER_ORDER[x.tier] - TIER_ORDER[y.tier] || x.since - y.since);
  }

  // Looking at a Finished agent moves it out of Review.
  function markSeen(a: Agent) {
    if (a.state === "review") seen.set(a.id, { since: a.since, at: clock() });
  }

  // You jumped to it: it counts as your latest interaction.
  const touch = (id: string) => { touched.set(id, clock()); };

  const where = (id: string) => {
    const s = sessions.get(id);
    return s && { pid: s.pid, pane: s.pane, target: s.target };
  };

  return { applyHook, applyRegistry, view, markSeen, touch, where, hooksSeen: () => hooksSeen };
}

// The background tasks a session waits on. When unsure it leaves a task out, so the desk shows
// Finished and you look: only tasks from this process, nothing after a turn that ends in a question,
// and only Monitors this turn started that will expire.
function awaited(tr: Transcript, startedAt: number, now: number): Task[] {
  if (tr.lastText.trim().endsWith("?")) return [];
  return (tr.tasks ?? []).filter((t) => t.at >= startedAt &&
    (t.kind !== "monitor" || (!t.persistent && t.at >= (tr.promptAt ?? 0) && (t.expiresAt ?? 0) > now)));
}

// "2 helpers: Review the retry design, Audit the webhook tests. Watching CI on PR #212"
function waitLine(tasks: Task[]): string {
  const helpers = tasks.filter((t) => t.kind !== "monitor").map((t) => t.label);
  const parts = tasks.filter((t) => t.kind === "monitor").map((t) => `Watching ${t.label}`);
  if (helpers.length) parts.unshift(`${helpers.length} ${helpers.length === 1 ? "helper" : "helpers"}: ${helpers.join(", ")}`);
  return short(parts.join(". "), 140);
}

export type Store = ReturnType<typeof createStore>;
