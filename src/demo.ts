// Scripted demo agents that cycle through every state, for showing The AI Crowd
// without real sessions. Turned on with the "Show demo agents" setting.

import type { Agent, State } from "./types.ts";

type Segment = { state: State; secs: number; detail: string; padMin?: number; helpers?: string[] };
type Script = { project: string; title: string; cwd: string; offset: number; segments: Segment[] };

const SCRIPTS: Script[] = [
  {
    project: "turngate-api", title: "Webhook retry backoff", cwd: "~/Code/turngate-api", offset: 0,
    segments: [
      { state: "working", secs: 18, detail: "Editing src/webhooks/retry.ts" },
      { state: "permission", secs: 25, detail: "Run pnpm prisma migrate reset?" },
      { state: "working", secs: 12, detail: "Running the test suite" },
      { state: "review", secs: 30, detail: "Webhook retries now back off exponentially. 14 tests pass." },
    ],
  },
  {
    project: "Brain", title: "Inbox triage", cwd: "~/Documents/Brain", offset: 14,
    segments: [
      { state: "idle", secs: 25, detail: "Filed 4 inbox notes", padMin: 42 },
      { state: "working", secs: 10, detail: "Reading 🎯 Efforts/On" },
      { state: "question", secs: 28, detail: "Is this note Dragos-related?" },
      { state: "working", secs: 15, detail: "Appending to the daily note" },
      { state: "review", secs: 20, detail: "Filed 4 inbox notes and linked 2 to their efforts." },
    ],
  },
  {
    project: "silly-science-facts", title: "Octopus facts batch", cwd: "~/Code.personal/silly-science-facts", offset: 30,
    segments: [
      { state: "idle", secs: 45, detail: "Added 12 facts about squid", padMin: 95 },
      { state: "working", secs: 10, detail: "Writing facts/octopus.md" },
      { state: "review", secs: 35, detail: "Added 12 facts about octopuses, each with a source." },
    ],
  },
  {
    project: "infra", title: "Staging Terraform drift", cwd: "~/Code/infra", offset: 7,
    segments: [
      { state: "working", secs: 25, detail: "Running terraform plan (staging)" },
      { state: "error", secs: 22, detail: "API error: overloaded. The turn stopped." },
      { state: "working", secs: 20, detail: "Retrying terraform plan" },
    ],
  },
  {
    project: "docs-site", title: "Install guide rewrite", cwd: "~/Code/docs-site", offset: 3,
    segments: [
      { state: "working", secs: 40, detail: "Rewriting docs/install.md", helpers: ["Explore", "general-purpose"] },
      { state: "review", secs: 18, detail: "Rewrote the install guide. Removed the Windows section." },
    ],
  },
  {
    project: "the-AI-crowd", title: "Office sprites", cwd: "~/Code.personal/the-AI-crowd", offset: 21,
    segments: [
      { state: "working", secs: 15, detail: "Drawing the red phone", helpers: ["Explore"] },
      { state: "permission", secs: 14, detail: "Edit prototype/index.html?" },
      { state: "working", secs: 12, detail: "Wiring the SSE stream" },
      { state: "ended", secs: 10, detail: "Session ended" },
    ],
  },
];

const BOOT = Date.now();

export function demoAgents(now: number): Agent[] {
  return SCRIPTS.map((s) => {
    const cycle = s.segments.reduce((n, g) => n + g.secs, 0);
    const elapsed = (now - BOOT) / 1000 + s.offset;
    const round = Math.floor(elapsed / cycle);
    let t = elapsed - round * cycle;
    let start = BOOT + (round * cycle - s.offset) * 1000;
    let seg = s.segments[0];
    for (const g of s.segments) {
      if (t < g.secs) { seg = g; break; }
      t -= g.secs;
      start += g.secs * 1000;
    }
    // A session that ends comes back as a new session, so it gets a new character.
    const endsPerCycle = s.segments.some((g) => g.state === "ended") ? 1 : 0;
    const id = `demo-${s.project}-${round * endsPerCycle}`;
    return {
      id,
      source: "demo",
      title: s.title,
      project: s.project,
      cwd: s.cwd,
      state: seg.state,
      since: start - (seg.padMin ?? 0) * 60_000,
      detail: seg.detail,
      helpers: (seg.helpers ?? []).map((label, i) => ({ id: `${id}-h${i}`, label })),
    };
  });
}
