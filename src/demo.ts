// Scripted demo agents for the /demo page, cycling through every state without real sessions.
// Each loop follows transitions a real session makes. A turn ends in Finished, a new prompt
// starts work again, errors happen mid-turn, and asleep agents stay asleep (in real life only
// a seen agent falls asleep).

import type { Agent, State } from "./types.ts";

type Segment = { state: State; secs: number; detail: string; padMin?: number; helpers?: string[] };
// cast picks the character: the session id seeds the look. The seeds give the demo a cast spread
// evenly across skin tones and archetypes (found by trying seeds against lookFor in web/office.js).
type Script = { project: string; title: string; cwd: string; offset: number; cast: number; segments: Segment[] };

// The first two desks stay quiet (one line each, never changing) so a screenshot shows their faces.
const SCRIPTS: Script[] = [
  {
    project: "docs-site", title: "Install guide rewrite", cwd: "~/Code/docs-site", offset: 3, cast: 82,
    segments: [
      { state: "working", secs: 60, detail: "Rewriting docs/install.md", helpers: ["Explore", "general-purpose"] },
    ],
  },
  {
    project: "payments", title: "Refund edge cases", cwd: "~/Code/payments", offset: 11, cast: 13,
    segments: [
      { state: "review", secs: 60, detail: "Partial refunds now round down to the cent. Added 6 tests.", padMin: 3 },
    ],
  },
  {
    project: "turngate-api", title: "Webhook retry backoff", cwd: "~/Code/turngate-api", offset: 0, cast: 85,
    segments: [
      { state: "working", secs: 18, detail: "Editing src/webhooks/retry.ts" },
      { state: "permission", secs: 25, detail: "Run pnpm prisma migrate reset?" },
      { state: "working", secs: 12, detail: "Running the test suite" },
      { state: "review", secs: 30, detail: "Webhook retries now back off exponentially. 14 tests pass." },
    ],
  },
  {
    project: "Brain", title: "Inbox triage", cwd: "~/Documents/Brain", offset: 14, cast: 13,
    segments: [
      { state: "working", secs: 10, detail: "Reading 🎯 Efforts/On" },
      { state: "question", secs: 28, detail: "Is this note Dragos-related?" },
      { state: "working", secs: 15, detail: "Appending to the daily note" },
      { state: "review", secs: 20, detail: "Filed 4 inbox notes and linked 2 to their efforts." },
    ],
  },
  {
    project: "infra", title: "Staging Terraform drift", cwd: "~/Code/infra", offset: 7, cast: 9,
    segments: [
      { state: "working", secs: 25, detail: "Running terraform plan (staging)" },
      { state: "error", secs: 22, detail: "API error: overloaded. The turn stopped." },
      { state: "working", secs: 20, detail: "Retrying terraform plan" },
    ],
  },
  {
    project: "the-AI-crowd", title: "Office sprites", cwd: "~/Code.personal/the-AI-crowd", offset: 21, cast: 27,
    segments: [
      { state: "working", secs: 15, detail: "Drawing the red phone", helpers: ["Explore"] },
      { state: "permission", secs: 14, detail: "Edit prototype/index.html?" },
      { state: "working", secs: 12, detail: "Wiring the SSE stream" },
      { state: "review", secs: 12, detail: "The red phone now rings on every urgent desk." },
      { state: "ended", secs: 10, detail: "Session ended" },
    ],
  },
  {
    project: "silly-science-facts", title: "Octopus facts batch", cwd: "~/Code.personal/silly-science-facts", offset: 30, cast: 5,
    segments: [
      { state: "idle", secs: 60, detail: "Added 12 facts about octopuses, each with a source.", padMin: 95 },
    ],
  },
  {
    project: "mobile-app", title: "Dark mode toggle", cwd: "~/Code/mobile-app", offset: 5, cast: 144,
    segments: [
      { state: "question", secs: 32, detail: "Should dark mode follow the system setting by default?" },
      { state: "working", secs: 12, detail: "Editing src/theme/ThemeProvider.tsx" },
    ],
  },
  {
    project: "data-pipeline", title: "Nightly ETL backfill", cwd: "~/Code/data-pipeline", offset: 2, cast: 3,
    segments: [
      { state: "idle", secs: 60, detail: "Backfilled 31 days of events", padMin: 128 },
    ],
  },
  {
    project: "auth-gateway", title: "Token refresh race", cwd: "~/Code/auth-gateway", offset: 40, cast: 7,
    segments: [
      { state: "working", secs: 12, detail: "Reproducing the double refresh" },
      { state: "error", secs: 25, detail: "API error: rate_limit. The turn stopped." },
      { state: "working", secs: 15, detail: "Adding a lock around the refresh" },
      { state: "review", secs: 20, detail: "Refreshes now share one in-flight request." },
    ],
  },
];

const BOOT = Date.now();

export function demoAgents(now: number): Agent[] {
  return SCRIPTS.map((s, seat) => {
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
    // A one-line script never changes, so its wait clock runs from the start instead of each cycle.
    if (s.segments.length === 1) start = BOOT - s.offset * 1000;
    // A session that ends comes back as a new session, so it gets a new character.
    const endsPerCycle = s.segments.some((g) => g.state === "ended") ? 1 : 0;
    const id = `demo-${s.project}-${s.cast}-${round * endsPerCycle}`;
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
      seat,
    };
  });
}
