// The AI Crowd page: the office canvas, sounds, and everything that runs in the browser.
// The server streams state over SSE. Datastar patches the list and header into the DOM,
// and hands the _state and _toast signals to window.crowd.patched().
// The server strips this file's types and serves it as /office.js.

import type { PageState, Settings, Shortcuts, State, Tier, ViewAgent } from "../src/types.ts";

// ============================================================================
// State from the server
// ============================================================================

let settings: Settings = { muted: false, popBubbles: true, sound: "office", urgentSound: true, reviewSound: false, tabCount: true, hooksDismissed: false };
let agents: ViewAgent[] = [];               // latest from the server, plus ghosts of sessions that just left
let hooks = false;                          // has the plugin sent any hook event?
const lastSaid = new Map<string, string>(); // id -> "state|detail" from the previous update
const pops = new Map<string, number>();     // id -> when its line last changed, for pop-up bubbles
const POP_MS = 6000;
const ghosts = new Map<string, { agent: ViewAgent; until: number }>(); // live agents that vanished
const prevTier = new Map<string, Tier>();
type Pick = { kind: "desk" | "row"; id: string };
let picked: Pick | undefined;               // the desk or list row picked with the arrow keys

// /demo shows the scripted demo agents through this same page. Its stream and every action carry demo=1.
const DEMO = location.pathname === "/demo";

// The page's fixed elements. A missing one is a broken page, so fail loudly.
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the page`);
  return el as T;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = canvas.getContext("2d");
  if (!c) throw new Error("no 2d canvas");
  return c;
}

const targetElement = (e: Event) => (e.target instanceof Element ? e.target : null);

// Every action goes through Datastar's @post on the hidden #actions element.
function post(path: string) {
  const url = new URL(path, location.origin);
  if (DEMO) url.searchParams.set("demo", "1");
  byId("actions").dispatchEvent(new CustomEvent("crowd-post", { detail: url.pathname + url.search }));
}

// cmux's browser panes (the Dock among them) are WebKit views that expose window.webkit.messageHandlers.
// A jump from one tells the server to release the Dock's keyboard focus.
const IN_CMUX = Boolean((window as { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers);
// The cmux Dock: inside cmux and narrow. NARROW_PX is defined with the office layout below.
const inDock = () => IN_CMUX && innerWidth < NARROW_PX;
const jump = (id: string) => post(`/api/jump/${encodeURIComponent(id)}${IN_CMUX ? "?from=cmux" : ""}`);

// ============================================================================
// Characters: seeded from the session id, drawn in code at 32x32-ish
// ============================================================================

function hash(str: string) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = <T,>(r: () => number, arr: readonly [T, ...T[]]): T => arr[Math.floor(r() * arr.length)] ?? arr[0];

// Archetypes nod to the show's basement and upstairs crowd without copying anyone.
// An archetype sets only hair, clothes, and glasses. Skin and hair color are random for every
// archetype, so no role is tied to a skin tone.
type Archetype = {
  hair: "curls" | "part" | "bob" | "goth" | "slick" | "receding";
  outfit: "tee" | "vest" | "blazer" | "black" | "suit" | "cardigan";
  glasses: number; // the chance of glasses
};
const ARCHETYPES: [Archetype, ...Archetype[]] = [
  { hair: "curls",   outfit: "tee",      glasses: 0.2 },  // the night owl
  { hair: "part",    outfit: "vest",     glasses: 0.95 }, // the genius
  { hair: "bob",     outfit: "blazer",   glasses: 0.1 },  // the manager
  { hair: "goth",    outfit: "black",    glasses: 0.0 },  // the one behind the red door
  { hair: "slick",   outfit: "suit",     glasses: 0.1 },  // the boss upstairs
  { hair: "receding",outfit: "cardigan", glasses: 0.6 },  // the old hand
];
// Six skin tones spaced evenly from light to deep.
const SKIN = ["#f6dcc7", "#e8bd98", "#d39e74", "#b07a50", "#8a5636", "#5e3a24"] as const;
const HAIR = ["#2a1b10", "#4a2e19", "#6b4423", "#b5651d", "#d8b25a", "#111111", "#7a7a7a"] as const;
const TEES = ["#c0392b", "#2c7fb8", "#3a8c4e", "#8e44ad", "#d35400", "#34495e", "#b03a6f"] as const;

type Look = Omit<Archetype, "glasses"> & { glasses: boolean; skin: string; hairColor: string; shirt: string; accent: string };
const looks = new Map<string, Look>();
function lookFor(id: string): Look {
  const known = looks.get(id);
  if (known) return known;
  const r = rng(hash(id));
  const arch = pick(r, ARCHETYPES);
  const look = {
    ...arch,
    skin: pick(r, SKIN),
    hairColor: arch.hair === "goth" ? "#0b0b0b" : pick(r, HAIR),
    shirt: arch.outfit === "black" ? "#1a1a1a" : arch.outfit === "suit" ? "#2d3142" : pick(r, TEES),
    accent: pick(r, TEES),
    glasses: r() < arch.glasses,
  };
  looks.set(id, look);
  return look;
}

type Ctx = CanvasRenderingContext2D;

// px(ctx, x, y, w, h, color): one logical pixel block
function px(c: Ctx, x: number, y: number, w: number, h: number, col: string) { c.fillStyle = col; c.fillRect(x, y, w, h); }

// How a person sits: their state, or "still" for a list portrait. Asleep and gone desks have
// nobody in the chair, and a "waiting" session is drawn as a permission ask.
type Pose = Exclude<State, "idle" | "ended" | "waiting"> | "still";

// Draws a seated person, head top-left at (x, y), 16 wide. pose picks arms and head.
function drawPerson(c: Ctx, x: number, y: number, look: Look, pose: Pose, t: number) {
  const cx = x + 8;
  const bob = pose === "working" ? (Math.floor(t * 4) % 2) : 0;
  const headY = pose === "review" ? y - 1 : y;
  // torso
  px(c, cx - 6, y + 11, 12, 11, look.shirt);
  if (look.outfit === "vest") { px(c, cx - 6, y + 11, 12, 11, "#e9e4d4"); px(c, cx - 5, y + 13, 10, 9, look.accent); px(c, cx - 1, y + 11, 2, 3, "#e9e4d4"); }
  if (look.outfit === "suit" || look.outfit === "blazer") { px(c, cx - 1, y + 11, 2, 11, "#ece8dc"); px(c, cx, y + 12, 1, 7, look.outfit === "suit" ? "#8b1e2b" : look.accent); }
  if (look.outfit === "cardigan") { px(c, cx - 1, y + 11, 2, 11, "#d7cfb7"); }
  if (look.outfit === "tee") px(c, cx - 3, y + 15, 6, 3, "#ffffff33");
  // arms
  const sleeve = look.outfit === "tee" ? look.skin : look.shirt;
  if (pose === "working") {
    px(c, cx - 8, y + 12, 2, 8, sleeve); px(c, cx + 6, y + 12, 2, 8, sleeve);
    px(c, cx - 7, y + 19 - bob, 3, 2, look.skin); px(c, cx + 4, y + 18 + bob, 3, 2, look.skin);
  } else if (pose === "question") {
    px(c, cx - 8, y + 12, 2, 9, sleeve); px(c, cx + 6, y - 4, 2, 16, sleeve); px(c, cx + 6, y - 6, 2, 2, look.skin);
  } else if (pose === "error") {
    px(c, cx - 8, y - 4, 2, 16, sleeve); px(c, cx + 6, y - 4, 2, 16, sleeve);
    px(c, cx - 8, y - 6, 2, 2, look.skin); px(c, cx + 6, y - 6, 2, 2, look.skin);
  } else if (pose === "permission") {
    px(c, cx - 8, y + 12, 2, 9, sleeve); px(c, cx + 6, y + 4, 2, 8, sleeve); px(c, cx + 5, y + 3, 3, 3, look.skin);
  } else if (pose === "background") {
    // arms folded across the chest
    px(c, cx - 8, y + 12, 2, 6, sleeve); px(c, cx + 6, y + 12, 2, 6, sleeve);
    px(c, cx - 7, y + 15, 14, 3, sleeve); px(c, cx + 4, y + 14, 2, 2, look.skin); px(c, cx - 6, y + 17, 2, 2, look.skin);
  } else {
    px(c, cx - 8, y + 12, 2, 9, sleeve); px(c, cx + 6, y + 12, 2, 9, sleeve);
  }
  // head
  px(c, cx - 5, headY + 1, 10, 10, look.skin);
  // hair
  const h = look.hairColor;
  switch (look.hair) {
    case "curls": px(c, cx - 7, headY - 3, 14, 6, h); px(c, cx - 7, headY + 3, 2, 5, h); px(c, cx + 5, headY + 3, 2, 5, h); break;
    case "part": px(c, cx - 5, headY - 1, 10, 3, h); px(c, cx - 5, headY + 2, 2, 2, h); px(c, cx + 1, headY - 1, 1, 1, look.skin); break;
    case "bob": px(c, cx - 6, headY - 1, 12, 4, h); px(c, cx - 6, headY + 3, 2, 8, h); px(c, cx + 4, headY + 3, 2, 8, h); break;
    case "goth": px(c, cx - 6, headY - 1, 12, 3, h); px(c, cx - 6, headY + 2, 2, 13, h); px(c, cx + 4, headY + 2, 2, 13, h); break;
    case "slick": px(c, cx - 5, headY - 1, 10, 3, h); px(c, cx + 3, headY + 2, 2, 2, h); break;
    case "receding": px(c, cx - 5, headY + 2, 2, 4, h); px(c, cx + 3, headY + 2, 2, 4, h); break;
  }
  // face
  const eyeY = headY + 5;
  const gaze = pose === "permission" ? -1 : pose === "background" ? 1 : 0; // the phone, or the monitor
  if (pose === "review") { px(c, cx - 3, eyeY, 2, 1, "#222"); px(c, cx + 1, eyeY, 2, 1, "#222"); }
  else { px(c, cx - 3 + gaze, eyeY, 1, 2, "#222"); px(c, cx + 2 + gaze, eyeY, 1, 2, "#222"); }
  if (look.glasses) { c.strokeStyle = "#222"; c.lineWidth = 0.6; c.strokeRect(cx - 4.5, eyeY - 0.8, 3.5, 3); c.strokeRect(cx + 0.8, eyeY - 0.8, 3.5, 3); }
  if (pose === "error") px(c, cx - 1, headY + 8, 3, 2, "#5a1a1a");
  else if (pose === "review") px(c, cx - 2, headY + 8, 4, 1, "#7a3b2a");
  else px(c, cx - 1, headY + 8, 2, 1, "#7a3b2a");
}

// Little glyph bubbles, drawn as pixel blocks.
const GLYPHS = {
  "!": ["010", "010", "010", "000", "010"],
  "?": ["111", "001", "011", "000", "010"],
  "z": ["111", "001", "010", "100", "111"],
};
type Glyph = keyof typeof GLYPHS;
// An hourglass centered on (cx, cy): the sand runs down for 4 s, then it flips over.
// 5 x 7, so it keeps a 1 px gap inside the 13 x 9 screen.
const GLASS_ROWS = [5, 3, 3, 1, 3, 3, 5]; // widths; the first and last rows are the caps, the middle one the neck
function hourglass(c: Ctx, cx: number, cy: number, t: number) {
  const RUN = 4, FLIP = 0.6, phase = t % (RUN + FLIP), p = Math.min(phase / RUN, 1);
  c.save();
  c.translate(cx, cy);
  if (phase > RUN) c.rotate(((phase - RUN) / FLIP) * Math.PI);
  GLASS_ROWS.forEach((w, i) => px(c, -w / 2, i - 3.5, w, 1, i === 0 || i === 6 ? "#a0703f" : "#3a2f12"));
  // Sand settles from the neck outward: the top chamber empties as the bottom fills.
  const fill = (row: number, n: number) => { const w = GLASS_ROWS[row] ?? 0, k = Math.min(n, w); px(c, -w / 2 + Math.floor((w - k) / 2), row - 3.5, k, 1, "#f2b233"); return k; };
  let top = Math.round((1 - p) * 6), bottom = 6 - top;
  for (const row of [2, 1]) top -= fill(row, top);
  for (const row of [5, 4]) bottom -= fill(row, bottom);
  if (p < 1) px(c, -0.5, -0.5, 1, 1, "#f2b233"); // the falling grain in the neck
  c.restore();
}
function glyph(c: Ctx, ch: Glyph, x: number, y: number, col: string) { GLYPHS[ch].forEach((row, j) => [...row].forEach((b, i) => b === "1" && px(c, x + i, y + j, 1, 1, col))); }
function bubble(c: Ctx, x: number, y: number, chars: Glyph[], col: string) {
  const w = chars.length * 4 + 3;
  px(c, x, y, w, 9, "#fdfbf3"); px(c, x + 2, y + 9, 2, 2, "#fdfbf3");
  chars.forEach((ch, i) => glyph(c, ch, x + 2 + i * 4, y + 2, col));
}

// ============================================================================
// Office scene
// ============================================================================

const CELL_W = 56, CELL_H = 56, WALL_H = 30, PAD = 6;
// Below this width (the cmux Dock), the office drops its wall and shows only desks. Matches the CSS breakpoint.
const NARROW_PX = 520;

// Where a desk is drawn, in logical pixels.
type Slot = { a: ViewAgent; x: number; y: number };

// Desks flow left to right, as many per row as fit, and the rows sit centred in the room.
function deskSlots(list: ViewAgent[], cols: number, w: number, top: number): Slot[] {
  const left = Math.max(PAD, Math.floor((w - cols * CELL_W) / 2));
  return list.map((a, i) => ({ a, x: left + (i % cols) * CELL_W, y: top + 6 + Math.floor(i / cols) * CELL_H }));
}

// Desk order is stable: first seen, first seated. An agent with a seat number (the demo's)
// takes its place in seat order instead, so the demo office looks the same every time.
// byRecent (the cmux Dock): your latest interaction sits at the top; ties keep the stable order.
const seatOrder: string[] = [];
function seated(list: ViewAgent[], byRecent = false): ViewAgent[] {
  const byAgentId = new Map(list.map((a) => [a.id, a]));
  for (const a of list) {
    if (seatOrder.includes(a.id)) continue;
    const seat = a.seat;
    const before = seat === undefined ? -1 : seatOrder.findIndex((id) => (byAgentId.get(id)?.seat ?? -Infinity) > seat);
    if (before < 0) seatOrder.push(a.id); else seatOrder.splice(before, 0, a.id);
  }
  for (let i = seatOrder.length - 1; i >= 0; i--) if (!byAgentId.has(seatOrder[i] ?? "")) seatOrder.splice(i, 1);
  const stable = seatOrder.flatMap((id) => byAgentId.get(id) ?? []);
  return byRecent ? stable.toSorted((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0)) : stable;
}

// The wall props' places in logical pixels. chatter and clock are null when they don't fit.
type Wall = { sign: boolean; sound: { x: number; label: string }; chatter: { x: number; label: string } | null; clock: number | null };

// Lays out the wall props left to right in logical pixels, for any office width.
// The switches matter most: their labels shrink, then go, before a switch does.
// Then the sign, then the clock. The extinguisher always keeps the right edge.
function wallLayout(c: Ctx, w: number, scale: number): Wall {
  c.font = `600 ${scale * 3.4}px "IBM Plex Mono", monospace`;
  const labelW = (t: string) => (t ? c.measureText(t).width / scale + 2 : 0);
  const room = w - 26;
  const withChatter = scale >= 2;
  const widths = ([a, ch]: [string, string]) => [16 + labelW(a), withChatter ? 16 + labelW(ch) : 0] as const;
  const options: [string, string][] = [
    [settings.muted ? "SOUND OFF" : "SOUND ON", settings.popBubbles ? "CHATTER ON" : "CHATTER OFF"],
    ["SOUND", "CHATTER"],
  ];
  const [a, ch] = options.find((o) => { const [aw, cw] = widths(o); return 6 + aw + cw <= room; }) ?? ["", ""];
  const [aw, cw] = widths([a, ch]);
  const sign = 60 + aw + cw <= room;
  const x = sign ? 60 : 6;
  const end = x + aw + cw;
  return {
    sign,
    sound: { x, label: a },
    chatter: withChatter ? { x: x + aw, label: ch } : null,
    clock: end + 4 <= w - 51 ? w - 42 : null,
  };
}

function drawSwitch(c: Ctx, x: number, on: boolean) {
  px(c, x, 3, 14, 21, "#d9cfb2"); px(c, x + 1, 4, 12, 19, "#e8e1c8");
  px(c, x + 4, 6, 6, 13, "#3a3a3a");
  if (on) { px(c, x + 4, 6, 6, 6, "#3a8c4e"); px(c, x + 5, 4, 4, 4, "#2c6b3b"); }
  else { px(c, x + 4, 13, 6, 6, "#c0392b"); px(c, x + 5, 17, 4, 4, "#8f2a1f"); }
}

// wall is null in a narrow office: carpet only.
function drawRoom(c: Ctx, w: number, h: number, wall: Wall | null) {
  // carpet
  for (let y = wall ? WALL_H : 0; y < h; y += 8) for (let x = 0; x < w; x += 8) px(c, x, y, 8, 8, ((x + y) / 8) % 2 ? "#3b3a33" : "#36352f");
  if (!wall) return;
  // wall with bricks
  px(c, 0, 0, w, WALL_H, "#4b5145");
  for (let y = 0; y < WALL_H - 4; y += 5) for (let x = (y / 5) % 2 ? -6 : 0; x < w; x += 12) px(c, x, y, 11, 4, "#545a4c");
  px(c, 0, WALL_H - 3, w, 3, "#2c2f29");
  // the sign; its text is drawn in the label pass
  if (wall.sign) px(c, 8, 6, 46, 12, "#1d1f1b");
  // wall switches: lever up means on, down means off
  drawSwitch(c, wall.sound.x, !settings.muted);
  if (wall.chatter) drawSwitch(c, wall.chatter.x, settings.popBubbles);
  // fire extinguisher on a wall bracket: body, shoulder, valve, handle, hose, label band
  const ex = w - 20;
  px(c, ex - 1, 12, 9, 2, "#6b6b6b");
  px(c, ex, 9, 7, 15, "#c0221a"); px(c, ex + 1, 8, 5, 1, "#c0221a"); px(c, ex + 1, 9, 1, 14, "#e0463a");
  px(c, ex, 15, 7, 3, "#f0ede4"); px(c, ex + 2, 16, 3, 1, "#c0221a");
  px(c, ex + 2, 5, 3, 3, "#222"); px(c, ex + 1, 4, 6, 1, "#444"); px(c, ex + 5, 3, 3, 1, "#444");
  px(c, ex + 7, 6, 1, 1, "#222"); px(c, ex + 8, 7, 1, 8, "#222"); px(c, ex + 7, 15, 1, 2, "#222");
  // wall clock showing the real local time
  if (wall.clock !== null) {
    const ox = wall.clock, oy = 13, now = new Date();
    c.fillStyle = "#2a2a2a"; c.beginPath(); c.arc(ox, oy, 9, 0, 7); c.fill();
    c.fillStyle = "#f3eedc"; c.beginPath(); c.arc(ox, oy, 7.5, 0, 7); c.fill();
    for (let i = 0; i < 12; i += 3) { const a = (i / 12) * Math.PI * 2; px(c, Math.round(ox + Math.sin(a) * 6) - 0.5, Math.round(oy - Math.cos(a) * 6) - 0.5, 1, 1, "#2a2a2a"); }
    const hand = (frac: number, len: number, width: number, col: string) => { const a = frac * Math.PI * 2; c.strokeStyle = col; c.lineWidth = width; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.sin(a) * len, oy - Math.cos(a) * len); c.stroke(); };
    hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12, 3.8, 1.2, "#2a2a2a");
    hand((now.getMinutes() + now.getSeconds() / 60) / 60, 5.6, 0.9, "#2a2a2a");
    hand(now.getSeconds() / 60, 6, 0.4, "#c0221a");
  }
}

// rowWidth > 0 means a one-column office: a colored divider under each desk replaces the outline.
// glyphs: draw the small "!" and "?" bubbles. Only the small map needs them; elsewhere the speech bubble says it.
function drawDesk(c: Ctx, s: Slot, t: number, rowWidth = 0, glyphs = true) {
  const { a, x, y } = s;
  const tier = a.tier;
  const pulse = 0.35 + 0.35 * Math.sin(t * 6);
  // the session picked with the keyboard or a click: a green floor and outline
  if (picked?.kind === "desk" && picked.id === a.id) {
    c.fillStyle = "rgba(125,255,138,.10)"; c.fillRect(x + 1, y - 8, CELL_W - 4, 54);
    c.strokeStyle = "#7dff8a"; c.lineWidth = 1; c.strokeRect(x - 0.5, y - 9.5, CELL_W - 1, 57);
  }
  // attention: an outline around the desk, or in one column a divider under it
  if (rowWidth) {
    const color = tier === "urgent" ? `rgba(255,77,61,${pulse + 0.3})` : tier === "review" ? "rgba(242,178,51,.8)" : "rgba(120,120,110,.35)";
    px(c, 0, y + 45, rowWidth, tier === "quiet" ? 0.7 : 1.5, color);
  } else {
    if (tier === "urgent") { c.strokeStyle = `rgba(255,77,61,${pulse + 0.2})`; c.lineWidth = 1.5; c.strokeRect(x + 1, y - 8, CELL_W - 4, 54); }
    if (tier === "review") { c.strokeStyle = "rgba(242,178,51,.55)"; c.lineWidth = 1; c.strokeRect(x + 1, y - 8, CELL_W - 4, 54); }
  }
  // chair
  px(c, x + 12, y + 4, 16, 18, "#2a2d35");
  if (a.state !== "ended" && a.state !== "idle") drawPerson(c, x + 12, y + 2, lookFor(a.id), a.state === "waiting" ? "permission" : a.state, t);
  // desk
  px(c, x + 2, y + 22, 48, 5, "#8a5a33"); px(c, x + 2, y + 27, 48, 2, "#6b4426");
  px(c, x + 4, y + 29, 3, 8, "#5a381f"); px(c, x + 45, y + 29, 3, 8, "#5a381f");
  // monitor
  const mx = x + 31, my = y + 8;
  px(c, mx, my, 17, 14, "#cfc6aa"); px(c, mx + 6, my + 14, 5, 2, "#b3aa8e");
  const scr = (col: string) => px(c, mx + 2, my + 2, 13, 9, col);
  switch (a.state) {
    case "working": scr("#0d1a10"); for (let i = 0; i < 4; i++) px(c, mx + 3, my + 3 + i * 2, 3 + ((Math.floor(t * 5) + i * 3) % 9), 1, "#7dff8a"); break;
    case "background":
      scr("#15110a");
      c.save(); c.beginPath(); c.rect(mx + 2, my + 2, 13, 9); c.clip(); // the flip stays inside the screen
      hourglass(c, mx + 8.5, my + 6.5, t);
      c.restore();
      break;
    case "error": scr("#050505"); break;
    case "review": scr("#0d1a10"); px(c, mx + 5, my + 6, 2, 2, "#7dff8a"); px(c, mx + 7, my + 7, 2, 2, "#7dff8a"); px(c, mx + 9, my + 4, 2, 3, "#7dff8a"); break;
    case "idle": scr("#06070c"); px(c, mx + 3 + Math.floor(t * 3) % 10, my + 3 + Math.floor(t * 2) % 7, 2, 2, "#3d6bff"); break;
    case "ended": scr("#111"); break;
    default: scr("#0d1a10"); glyph(c, "?", mx + 7, my + 4, "#7dff8a");
  }
  // red phone on the desk
  const ringing = a.state === "permission" || a.state === "waiting";
  const shake = ringing ? (Math.floor(t * 20) % 2 ? 1 : -1) : 0;
  px(c, x + 4 + shake, y + 18, 8, 4, "#c0221a"); px(c, x + 3 + shake, y + 16, 10, 2, "#e0362b");
  if (ringing && Math.floor(t * 3) % 2) { px(c, x + 1, y + 13, 1, 2, "#fff"); px(c, x + 14, y + 13, 1, 2, "#fff"); }
  // a foot tapping under the desk while the helpers finish
  if (a.state === "background") { const tap = Math.floor(t * 2) % 2; px(c, x + 22, y + 29, 3, 6 - tap, "#3b3f4a"); px(c, x + 21, y + 35 - tap, 5, 2, "#1d1f24"); }
  // mug of tea for review
  if (a.state === "review") { px(c, x + 25, y + 18, 4, 4, "#f0ede4"); px(c, x + 29, y + 19, 1, 2, "#f0ede4"); px(c, x + 26 + (Math.floor(t * 2) % 2), y + 14 - (Math.floor(t * 3) % 3), 1, 2, "#ffffff88"); }
  // fire and smoke for errors
  if (a.state === "error") {
    for (let i = 0; i < 4; i++) { const p = (t * 1.5 + i * 0.25) % 1; px(c, mx + 4 + i * 3 + Math.sin(t * 3 + i) * 2, my - 2 - p * 14, 3, 3, `rgba(150,150,150,${1 - p})`); }
    for (let i = 0; i < 4; i++) px(c, mx + 2 + i * 4, my + 10 - (Math.floor(t * 12 + i) % 3), 3, 3, i % 2 ? "#ffcc33" : "#ff6a1a");
  }
  // bubbles
  if (glyphs && a.state === "permission") bubble(c, x + 6, y - 9, ["!"], "#d22");
  if (glyphs && a.state === "question") bubble(c, x + 6, y - 9, ["?"], "#2a62d4");
  if (glyphs && a.state === "waiting") bubble(c, x + 4, y - 9, ["!", "?"], "#d22");
  if (glyphs && a.state === "error") bubble(c, x + 6, y - 9, ["!"], "#d22");
  // asleep: an empty chair with z's drifting up from it
  if (a.state === "idle") for (let i = 0; i < 2; i++) { const p = (t * 0.5 + i * 0.5) % 1; glyph(c, "z", x + 17 + p * 6, y + 8 - p * 14, `rgba(220,220,255,${1 - p})`); }
  // helpers (subagents): one badge above the desk, a tiny figure plus a count drawn in the label pass
  if (a.helpers.length) {
    const bx = x + 36, by = y - 9;
    px(c, bx, by, 16, 9, "#fdfbf3"); px(c, bx + 2, by + 9, 2, 2, "#fdfbf3");
    px(c, bx + 2, by + 1, 3, 3, "#c68a5c"); px(c, bx + 1, by + 4, 5, 4, "#2c7fb8");
  }
}
// The longest start of `text` that fits in maxPx with the current font, with "…" when cut.
function fitText(c: Ctx, text: string, maxPx: number) {
  if (c.measureText(text).width <= maxPx) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(text.slice(0, mid) + "…").width <= maxPx) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function wrap(c: Ctx, text: string, maxW: number, maxLines = 3) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (c.measureText(next).width > maxW && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = (lines[maxLines - 1] ?? "").replace(/.{0,2}$/, "…"); }
  return lines;
}

// A speech bubble above a desk, in real pixels. Urgent ones are paper white with a red edge;
// hover ones are a green-on-black thought from the monitor.
function speech(c: Ctx, s: Slot, scale: number, alpha = 1) {
  const a = s.a;
  c.globalAlpha = alpha;
  const urgent = a.tier === "urgent";
  // A working agent just says what it's doing. Asks, errors, and results keep their label.
  const label = a.state === "working" ? "" : a.detailLabel;
  c.font = '12px "IBM Plex Mono", monospace';
  const lines = wrap(c, `${label ? label.toUpperCase() + ": " : ""}${a.detail}`, CELL_W * scale - 30, 4);
  const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 18;
  const h = lines.length * 15 + 11;
  // The box stays centred on its desk, so it never runs into the next one. The tail points
  // down at the person's head (drawPerson puts it at x + 20), ending just above the hair.
  const x = (s.x + CELL_W / 2) * scale - w / 2;
  const tx = Math.min(Math.max((s.x + 20) * scale, x + 12), x + w - 12);
  const y = Math.max(2, (s.y - 2) * scale - 8 - h); // keeps the top row's bubbles on the canvas
  c.fillStyle = urgent ? "#fdfbf3" : "#0d1a10";
  c.strokeStyle = urgent ? "#ff4d3d" : "#7dff8a";
  c.lineWidth = 2;
  c.beginPath(); c.roundRect(x, y, w, h, 6); c.fill(); c.stroke();
  c.beginPath(); c.moveTo(tx - 6, y + h - 1); c.lineTo(tx, y + h + 8); c.lineTo(tx + 6, y + h - 1); c.fill();
  c.fillStyle = urgent ? "#26241d" : "#7dff8a";
  c.textAlign = "left";
  lines.forEach((l, i) => c.fillText(l, x + 9, y + 18 + i * 15));
  c.globalAlpha = 1;
}

// Hit areas on the office wall, in logical pixels.
const onSwitch = (wall: Wall | null, lx: number, ly: number) => !!wall && lx >= wall.sound.x && lx < wall.sound.x + 14 && ly >= 3 && ly < 24;
const onChatter = (wall: Wall | null, lx: number, ly: number) => !!wall?.chatter && lx >= wall.chatter.x && lx < wall.chatter.x + 14 && ly >= 3 && ly < 24;
const onExtinguisher = (wall: Wall | null, lx: number, ly: number, w: number) => !!wall && lx >= w - 21 && lx < w - 10 && ly >= 3 && ly < 25;

const badgeHit = (s: Slot, lx: number, ly: number) => s.a.helpers.length > 0 && lx >= s.x + 36 && lx < s.x + 52 && ly >= s.y - 9 && ly < s.y;
const deskHit = (s: Slot, lx: number, ly: number) => lx >= s.x && lx < s.x + CELL_W && ly >= s.y - 10 && ly < s.y + CELL_H - 10;

// Mounts a canvas office into `host`. scale = screen pixels per logical pixel.
function mountOffice(host: HTMLElement, scale: number) {
  const canvas = document.createElement("canvas");
  canvas.className = "office";
  host.appendChild(canvas);
  const c = context2d(canvas);
  let slots: Slot[] = [];
  let lw = 0;
  let hoverId: string | undefined;
  let wall: Wall | null = null;
  let targets: Slot[] = []; // where each desk belongs this frame
  let lastMs: number | undefined;
  const shown = new Map<string, { x: number; y: number }>(); // id -> where the desk is drawn now, gliding toward its target
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const lx = (e.clientX - r.left) / scale, ly = (e.clientY - r.top) / scale;
    if (onSwitch(wall, lx, ly)) return post("/api/settings/muted/toggle");
    if (onChatter(wall, lx, ly)) return post("/api/settings/popBubbles/toggle");
    if (onExtinguisher(wall, lx, ly, lw)) return post(`/api/fire${IN_CMUX ? "?from=cmux" : ""}`);
    const hit = slots.find((s) => deskHit(s, lx, ly));
    if (hit) { select(undefined); jump(hit.a.id); }
  });
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const lx = (e.clientX - r.left) / scale, ly = (e.clientY - r.top) / scale;
    const hit = slots.find((s) => badgeHit(s, lx, ly));
    hoverId = slots.find((s) => deskHit(s, lx, ly))?.a.id;
    canvas.title = onSwitch(wall, lx, ly) ? (settings.muted ? "Turn sound back on" : "Mute all sounds")
      : onChatter(wall, lx, ly) ? (settings.popBubbles ? "Turn off chatter: only urgent asks pop up" : "Turn chatter back on")
      : onExtinguisher(wall, lx, ly, lw) ? "Put out the oldest fire"
      : hit ? `Helpers: ${hit.a.helpers.map((h) => h.label).join(", ")}` : "";
  });
  canvas.addEventListener("mouseleave", () => { hoverId = undefined; });

  // Moves each desk part of the way to its target every frame (ease-out, about a third of a
  // second end to end). A new desk appears in place; a desk that left is forgotten.
  function glide(list: Slot[], dt: number): Slot[] {
    const k = 1 - Math.exp(-dt * 12);
    const ids = new Set(list.map((s) => s.a.id));
    for (const id of shown.keys()) if (!ids.has(id)) shown.delete(id);
    return list.map((s) => {
      const p = shown.get(s.a.id);
      if (!p) { shown.set(s.a.id, { x: s.x, y: s.y }); return s; }
      p.x += (s.x - p.x) * k;
      p.y += (s.y - p.y) * k;
      if (Math.abs(s.x - p.x) < 0.3 && Math.abs(s.y - p.y) < 0.3) { p.x = s.x; p.y = s.y; }
      return { ...s, x: Math.round(p.x), y: Math.round(p.y) };
    });
  }
  function frame(ms: number) {
    const t = ms / 1000;
    const wpx = host.clientWidth || 600;
    lw = Math.floor(wpx / scale);
    const cols = Math.max(1, Math.floor((lw - PAD * 2) / CELL_W));
    const list = seated(agents, inDock());
    const rows = Math.max(2, Math.ceil(list.length / cols));
    const top = wpx < NARROW_PX ? 8 : WALL_H;
    const lh = top + 8 + rows * CELL_H;
    if (canvas.width !== lw * scale || canvas.height !== lh * scale) { canvas.width = lw * scale; canvas.height = lh * scale; }
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.imageSmoothingEnabled = false;
    wall = top === WALL_H ? wallLayout(c, lw, scale) : null;
    drawRoom(c, lw, lh, wall);
    targets = deskSlots(list, cols, lw, top);
    slots = glide(targets, (ms - (lastMs ?? ms)) / 1000);
    lastMs = ms;
    const single = cols === 1;
    // Desks still gliding draw last, so they slide over the desks they pass.
    const moving = (s: Slot, i: number) => (s.x !== targets[i]?.x || s.y !== targets[i]?.y ? 1 : 0);
    slots.map((s, i): [Slot, number] => [s, moving(s, i)]).toSorted((p, q) => p[1] - q[1]).forEach(([s]) => drawDesk(c, s, t, single ? lw : 0, scale < 2));
    // name labels in real pixels so they stay sharp
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.font = `${Math.max(8, scale * 3.6)}px "IBM Plex Mono", monospace`;
    c.textAlign = "center";
    // In one column a title may use the whole row, centered on it; otherwise it stays under its desk.
    for (const s of slots) {
      const max = scale < 2 ? 11 : 18;
      const name = single ? fitText(c, s.a.title, lw * scale - 16) : s.a.title.length > max ? s.a.title.slice(0, max - 1) + "…" : s.a.title;
      const label = s.a.state === "ended" ? "(left)" : name;
      const lx = single ? (lw * scale) / 2 : (s.x + CELL_W / 2) * scale;
      const ly = (s.y + 43) * scale;
      c.fillStyle = "#000a"; c.fillText(label, lx + 1, ly + 1);
      c.fillStyle = s.a.tier === "urgent" ? "#ff8a7d" : s.a.tier === "review" ? "#f6cd74" : "#d9d4c4";
      c.fillText(label, lx, ly);
    }
    c.textAlign = "left";
    if (wall) {
      if (wall.sign) { c.font = `${scale * 4}px "Press Start 2P", monospace`; c.fillStyle = "#e7d27a"; c.fillText("AI DEPT", 11 * scale, 15 * scale); }
      c.font = `600 ${scale * 3.4}px "IBM Plex Mono", monospace`;
      c.fillStyle = settings.muted ? "#ff8a7d" : "#e7d27a"; c.fillText(wall.sound.label, (wall.sound.x + 16) * scale, 15 * scale);
      if (wall.chatter) { c.fillStyle = settings.popBubbles ? "#e7d27a" : "#ff8a7d"; c.fillText(wall.chatter.label, (wall.chatter.x + 16) * scale, 15 * scale); }
    }
    c.font = `600 ${scale * 4}px "IBM Plex Mono", monospace`; c.fillStyle = "#222";
    for (const s of slots) if (s.a.helpers.length) c.fillText(`×${s.a.helpers.length}`, (s.x + 43) * scale, (s.y - 2) * scale);
    // Urgent desks always say what they're asking. Hovering any desk shows its detail line.
    // A changed line pops up for a few seconds, fading in fast and out slowly.
    if (scale >= 2) {
      const nowMs = Date.now();
      const popAlpha = (id: string) => {
        const age = nowMs - (pops.get(id) ?? -Infinity);
        return settings.popBubbles && age < POP_MS ? Math.min(1, age / 200, (POP_MS - age) / 1000) : 0;
      };
      const show = slots
        .map((s) => ({ s, alpha: s.a.tier === "urgent" || s.a.id === hoverId ? 1 : popAlpha(s.a.id) }))
        .filter((b) => b.s.a.state !== "ended" && b.alpha > 0);
      // The hovered desk's bubble draws last, on top.
      const hovered = (b: { s: Slot }) => Number(b.s.a.id === hoverId);
      for (const b of show.toSorted((p, q) => hovered(p) - hovered(q))) speech(c, b.s, scale, b.alpha);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return {
    // Where a desk sits in the viewport, in CSS pixels, so the page can scroll it into view.
    // Where a desk is heading (not where it is mid-glide), so scrolling aims at its final place.
    deskBox(id: string) {
      const s = targets.find((x) => x.a.id === id);
      if (!s) return undefined;
      const r = canvas.getBoundingClientRect();
      const k = (r.width / canvas.width) * scale;
      return { top: r.top + (s.y - 10) * k, bottom: r.top + (s.y + 47) * k, firstRow: s.y === targets[0]?.y };
    },
    // The desks in the order the office shows them, for the keyboard walk.
    deskIds: () => targets.filter((s) => s.a.state !== "ended").map((s) => s.a.id),
  };
}

const portraits = new Map<string, string>();
function portrait(id: string): string {
  const known = portraits.get(id);
  if (known) return known;
  const cv = document.createElement("canvas");
  cv.width = 24; cv.height = 24;
  const c = context2d(cv);
  px(c, 0, 0, 24, 24, "#2c3b33");
  drawPerson(c, 4, 6, lookFor(id), "still", 0);
  const url = cv.toDataURL();
  portraits.set(id, url);
  return url;
}

// ============================================================================
// Updates, sounds, settings, chrome
// ============================================================================

// Live sessions that vanish linger for a few seconds as an empty desk.
function withGhosts(list: ViewAgent[]): ViewAgent[] {
  const now = Date.now();
  const ids = new Set(list.map((a) => a.id));
  for (const a of agents) if (a.source === "live" && !ids.has(a.id) && !ghosts.has(a.id)) ghosts.set(a.id, { agent: { ...a, state: "ended", tier: "quiet" }, until: now + 6000 });
  for (const [id, g] of ghosts) if (g.until < now || ids.has(id)) ghosts.delete(id);
  return [...list, ...[...ghosts.values()].map((g) => g.agent)];
}

function update(state: PageState) {
  settings = state.settings;
  hooks = state.hooks;
  for (const a of state.agents) {
    const said = `${a.state}|${a.detail}`;
    // A sleeping agent has nothing new to say, so falling asleep never pops a bubble.
    if (lastSaid.has(a.id) && lastSaid.get(a.id) !== said && a.state !== "idle") pops.set(a.id, Date.now());
    lastSaid.set(a.id, said);
  }
  agents = withGhosts(state.agents);
  alertOnChanges();
  syncSettingsForm();
  showHooksBar();
  showKeysHint(state.shortcuts);
}

// The Dock hint: the user's own cmux keys for the right sidebar, then this page's keys.
// A cmux shortcut the user unbound is left out.
let lastHint = "";
function showKeysHint(keys: Shortcuts) {
  const all: [string | null, string][] = [[keys.toggle, "show/hide"], [keys.focus, "focus"], ["↑↓", "pick"], ["⏎", "jump"]];
  const items = all.filter((item): item is [string, string] => Boolean(item[0]));
  const signature = JSON.stringify(items);
  if (signature === lastHint) return;
  lastHint = signature;
  byId("keys-hint").replaceChildren(...items.map(([k, what]) => {
    const item = document.createElement("span");
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    item.append(kbd, what);
    return item;
  }));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = byId("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// One sound per kind of attention, matching the desk, so you can tell them apart without looking.
// Each note: [start s, length s, frequencies Hz, wave, peak gain, bell]. A bell note fades out
// from its start; the others hold, then cut off.
type Note = [at: number, dur: number, freqs: number[], wave: OscillatorType, peak: number, bell?: boolean];
type Sound = "phone" | "ding" | "buzz" | "chime" | "beep";
const SOUNDS: Record<Sound, Note[]> = {
  phone: [[0, 0.35, [400, 450], "sine", 0.12], [0.5, 0.35, [400, 450], "sine", 0.12]], // the red phone rings
  ding: [[0, 0.3, [988], "triangle", 0.16, true], [0.15, 0.5, [1319], "triangle", 0.16, true]], // a hand goes up
  buzz: [0, 0.18, 0.36].map((at): Note => [at, 0.12, [220], "square", 0.05]), // the fire alarm
  chime: [[0, 0.6, [660], "sine", 0.1, true]], // a turn finished
  beep: [[0, 0.12, [880], "sine", 0.12]],
};
const SOUND_FOR: Record<string, Sound> = { permission: "phone", waiting: "phone", question: "ding", error: "buzz", review: "chime" };

let audio: AudioContext | undefined;
// state: an agent state, or the one a Settings "Test" button names.
function ring(state: string) {
  const ctx = audio;
  if (!ctx || settings.muted) return;
  const notes = SOUNDS[settings.sound === "beep" ? "beep" : SOUND_FOR[state] ?? "phone"];
  // A hidden page's audio can be suspended. Wake it, then play.
  if (ctx.state === "running") play(ctx, notes);
  else ctx.resume().then(() => { if (ctx.state === "running") play(ctx, notes); }, () => {});
}

function play(ctx: AudioContext, notes: Note[]) {
  const now = ctx.currentTime;
  for (const [at, dur, freqs, wave, peak, bell] of notes) {
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = wave;
      g.gain.setValueAtTime(0.0001, now + at); g.gain.exponentialRampToValueAtTime(peak, now + at + 0.015);
      if (!bell) g.gain.setValueAtTime(peak, now + at + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      o.connect(g).connect(ctx.destination); o.start(now + at); o.stop(now + at + dur);
    }
  }
}

// Browsers allow sound only after a click or a key press on the page. The cmux Dock let it start with
// no click since the page loaded (tested). So try right away, then on every click and key until it
// runs: in the Dock you mostly use the keyboard.
function unlockAudio() {
  audio ??= new AudioContext();
  return audio.state === "running" ? Promise.resolve() : audio.resume();
}
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => { unlockAudio().catch(() => {}); }, true);
unlockAudio().catch(() => {});

function alertOnChanges() {
  for (const a of agents) {
    const before = prevTier.get(a.id);
    prevTier.set(a.id, a.tier);
    if (before === undefined || before === a.tier) continue;
    if (a.tier === "urgent" && settings.urgentSound) ring(a.state);
    if (a.tier === "review" && settings.reviewSound) ring(a.state);
  }
  const n = agents.filter((a) => a.tier === "urgent" && a.state !== "ended").length;
  const counted = settings.tabCount && n > 0;
  const name = DEMO ? "The AI Crowd (demo)" : "The AI Crowd";
  document.title = counted ? `(${n}) ${name}` : name;
  const fav = document.createElement("canvas");
  fav.width = fav.height = 32;
  const fc = context2d(fav);
  px(fc, 4, 10, 24, 14, "#c0221a"); px(fc, 2, 6, 28, 5, "#e0362b");
  if (counted) { fc.fillStyle = "#fff"; fc.beginPath(); fc.arc(24, 8, 8, 0, 7); fc.fill(); fc.fillStyle = "#c0221a"; fc.font = "bold 13px sans-serif"; fc.textAlign = "center"; fc.fillText(String(n), 24, 13); }
  byId<HTMLLinkElement>("favicon").href = fav.toDataURL();
}

function showHooksBar() {
  byId("hooks-bar").hidden = hooks || settings.hooksDismissed || !agents.some((a) => a.source === "live");
}

const dlg = byId<HTMLDialogElement>("settings");
const settingFields = () => dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-set]");
const isCheckbox = (el: HTMLInputElement | HTMLSelectElement): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === "checkbox";
function syncSettingsForm() {
  const values: Record<string, unknown> = settings;
  settingFields().forEach((el) => {
    if (el === document.activeElement) return;
    const v = values[el.dataset.set ?? ""];
    if (isCheckbox(el)) el.checked = v === true; else el.value = String(v);
  });
}
settingFields().forEach((el) => {
  el.addEventListener("change", () => post(`/api/settings/${el.dataset.set}/${isCheckbox(el) ? el.checked : el.value}`));
});

document.addEventListener("click", async (e) => {
  const button = targetElement(e)?.closest<HTMLElement>("[data-act]");
  const act = button?.dataset.act;
  if (act === "settings") dlg.showModal();
  if (act === "close-settings") dlg.close();
  if (act === "dismiss-hooks") post("/api/settings/hooksDismissed/true");
  if (act === "test-sound") { await unlockAudio(); ring(button?.dataset.state ?? ""); }
});

// The server renders <img data-portrait="id">; the browser draws the face. Datastar morphs the
// list every second, so a MutationObserver redraws faces and re-marks the picked row before paint.
function decorateList() {
  document.querySelectorAll<HTMLImageElement>("img[data-portrait]").forEach((im) => {
    const url = portrait(im.dataset.portrait ?? "");
    if (im.getAttribute("src") !== url) im.src = url;
  });
  document.querySelectorAll<HTMLElement>("tr.row").forEach((r) => {
    const on = picked?.kind === "row" && r.dataset.id === picked.id;
    if (r.classList.contains("selected") !== on) r.classList.toggle("selected", on);
  });
}
new MutationObserver(decorateList).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-portrait", "class"] });

// Keyboard: ↓ walks the desks top to bottom, then the list rows, and stops at the last row.
// ↑ walks back and stops at the first desk. Enter jumps to the picked session, Esc clears.
// In the cmux Dock, ⌘⇧E gives this page keyboard focus.
function pickables(): Pick[] {
  const desks = office.deskIds().map((id): Pick => ({ kind: "desk", id }));
  const rows = [...document.querySelectorAll<HTMLElement>("tr.row[data-id]")].map((r): Pick => ({ kind: "row", id: r.dataset.id ?? "" }));
  return [...desks, ...rows];
}

function select(item: Pick | undefined) {
  picked = item;
  decorateList();
  if (item?.kind === "row") {
    document.querySelector(`tr.row[data-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: "nearest" });
    return;
  }
  const box = item && office.deskBox(item.id);
  if (!box) return;
  if (box.firstRow) scrollTo({ top: 0 }); // the top row brings the header back too
  else if (box.top < 0) scrollBy({ top: box.top - 8 });
  else if (box.bottom > innerHeight) scrollBy({ top: box.bottom - innerHeight + 8 });
}

addEventListener("keydown", (e) => {
  if (dlg.open || e.metaKey || e.ctrlKey || e.altKey || targetElement(e)?.closest("input, select, textarea, [contenteditable]")) return;
  const items = pickables();
  const i = items.findIndex((it) => it.kind === picked?.kind && it.id === picked?.id);
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
    e.preventDefault();
    // Nothing picked yet, or the pick has gone: start at the first desk.
    const next = i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    select(items[next]);
  } else if (e.key === "Enter" && picked && i >= 0) {
    e.preventDefault();
    jump(picked.id);
    select(undefined);
  } else if (e.key === "Escape" && picked) {
    select(undefined);
  }
});
// A click on a list row jumps to that session and ends any keyboard pick.
document.addEventListener("click", (e) => {
  const id = targetElement(e)?.closest<HTMLElement>("tr.row[data-id]")?.dataset.id;
  if (id === undefined) return;
  select(undefined);
  jump(id);
});

const office = mountOffice(byId("office"), 3);

// When ⇧⌘E gives the Dock keyboard focus, pick the first desk so ↑↓ and Enter work at once.
// When the Dock loses focus, the pick goes too: the green outline means the keys work here.
// A click focuses the page too, so focus that arrives with a pointer press is ignored:
// picking would scroll to the top and move the desk you were clicking.
let pointerAt = -Infinity;
addEventListener("pointerdown", () => { pointerAt = performance.now(); }, true);
addEventListener("focus", () => {
  if (!inDock()) return;
  setTimeout(() => {
    const first = office.deskIds()[0];
    if (first && performance.now() - pointerAt > 400) select({ kind: "desk", id: first });
  }, 60);
});
addEventListener("blur", () => { if (inDock() && picked) select(undefined); });

Object.assign(window, {
  crowd: {
    stream: DEMO ? "/events?demo=1" : "/events",
    patched(patch: { _state?: unknown; _toast?: unknown } | undefined) {
      if (typeof patch?._state === "string") update(JSON.parse(patch._state));
      if (typeof patch?._toast === "string") toast(JSON.parse(patch._toast).text);
    },
  },
});
