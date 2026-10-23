// The AI Crowd: a local dashboard of every Claude Code session on this machine.
// Serves the page, streams updates to it over SSE in Datastar's event format,
// and takes hook events from the plugin at POST /api/hook.
// Run: npm start   (Node 26 runs this .ts file directly)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { CONFIG_PATH, DEFAULTS, applySetting, loadSettings, saveSettings } from "./config.ts";
import { demoAgents } from "./demo.ts";
import { focus, matchPane, readPanes, releaseDockFocus, ttysOf } from "./cmux.ts";
import { readRegistry } from "./registry.ts";
import { readShortcuts } from "./shortcuts.ts";
import { renderChips, renderList } from "./render.ts";
import { createStore, type HookEvent, type Store } from "./store.ts";
import { readTranscript, transcriptPath } from "./transcript.ts";
import type { PageState, Settings, Shortcuts, ViewAgent } from "./types.ts";

const PORT = Number(process.env.AI_CROWD_PORT ?? 4747);
const HOST = "127.0.0.1";
const WEB = new URL("../web/", import.meta.url);
const MAX_BODY = 5 * 1024 * 1024; // PreToolUse for a Write carries the whole file

const CSP = [
  "default-src 'none'",
  // Datastar compiles data-* attributes with Function, so it needs 'unsafe-eval'.
  "script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const settings = loadSettings();
const store = createStore();

// Who a page is watching. The live view shows real sessions and saves settings. The /demo page
// shows only the scripted agents, with its own store (so its own Seen marks) and settings it never saves.
type View = { demo: boolean; store: Store; settings: Settings; agents: () => ViewAgent[]; hooks: () => boolean };
const LIVE: View = { demo: false, store, settings, agents: () => store.view(), hooks: store.hooksSeen };
const demoStore = createStore();
const DEMO: View = { demo: true, store: demoStore, settings: { ...DEFAULTS }, agents: () => demoStore.view(demoAgents(Date.now())), hooks: () => true };
const viewFor = (url: URL) => (url.searchParams.has("demo") ? DEMO : LIVE);

const clients = new Map<ServerResponse, View>();
// The user's cmux keys for the right sidebar, shown in the Dock hint.
let shortcuts: Shortcuts = { toggle: null, focus: null };

// ---- sources ----------------------------------------------------------------

async function pollRegistry() {
  const regs = await readRegistry();
  const [panes, ttys] = await Promise.all([readPanes(), ttysOf(regs.map((r) => r.pid))]);
  const entries = await Promise.all(regs.map(async (reg) => ({
    reg,
    tr: await readTranscript(transcriptPath(reg.cwd, reg.sessionId)),
    pane: matchPane(panes, ttys.get(reg.pid), store.where(reg.sessionId)?.pane.surface),
  })));
  store.applyRegistry(entries);
}

// ---- Datastar SSE -------------------------------------------------------------

const event = (name: string, lines: string[]) => `event: ${name}\n${lines.map((l) => `data: ${l}\n`).join("")}\n`;
const patchElements = (html: string) => event("datastar-patch-elements", html.split("\n").map((l) => `elements ${l}`));
// Always JSON.stringify: Datastar evaluates a signals payload that isn't valid JSON.
const patchSignals = (signals: Record<string, unknown>) => event("datastar-patch-signals", [`signals ${JSON.stringify(signals)}`]);
const toast = (text: string) => patchSignals({ _toast: JSON.stringify({ text, at: Date.now() }) });

function frame(v: View): string {
  const now = Date.now();
  const agents = v.agents();
  // The page's office canvas reads _state; underscore signals are never sent back to the server.
  const state: PageState = { now, agents, settings: v.settings, hooks: v.hooks(), shortcuts };
  return patchElements(renderChips(agents, v.settings)) + patchElements(renderList(agents, now)) + patchSignals({ _state: JSON.stringify(state) });
}

function broadcast() {
  const frames = new Map<View, string>();
  for (const [res, v] of clients) {
    let f = frames.get(v);
    if (f === undefined) frames.set(v, (f = frame(v)));
    res.write(f);
  }
}

// ---- actions ------------------------------------------------------------------

// fromCmux: the click or Enter came from a page inside cmux, such as the Dock, which keeps focus unless released.
async function jump(v: View, id: string, fromCmux = false): Promise<string> {
  const a = v.agents().find((x) => x.id === id);
  if (!a) return "That agent has gone home.";
  v.store.markSeen(a);
  v.store.touch(a.id);
  if (a.source === "demo") return `${a.title} is a demo agent, so there's no pane to jump to.`;
  const target = store.where(id)?.target;
  if (!target) return `Couldn't find a cmux pane for ${a.title}. Is it running in cmux?`;
  try {
    if (fromCmux) await releaseDockFocus();
    await focus(target);
    return `Jumped to ${a.title}.`;
  } catch {
    return "Couldn't reach cmux. Start The AI Crowd from a cmux terminal so it can talk to cmux.";
  }
}

async function fire(v: View, fromCmux = false): Promise<string> {
  const oldest = v.agents().find((a) => a.tier === "urgent");
  if (!oldest) return "No fires. Carry on.";
  return `Putting out the oldest fire. ${await jump(v, oldest.id, fromCmux)}`;
}

async function changeSetting(v: View, key: string, value: string): Promise<string> {
  const s = v.settings;
  if (!applySetting(s, key, value)) return "That setting doesn't exist.";
  if (!v.demo) await saveSettings(s);
  if (key === "muted") return s.muted ? "Sound off. Nobody can reach you down here." : "Sound back on.";
  if (key === "popBubbles") return s.popBubbles ? "Chatter on." : "Chatter off. Only agents that need you will speak up.";
  return "";
}

// ---- http ---------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Browsers send Origin on every POST. Hooks come from curl, which sends none.
const fromPage = (req: IncomingMessage) => req.headers.origin === `http://${HOST}:${PORT}` || req.headers.origin === `http://localhost:${PORT}`;

function serve(res: ServerResponse, type: string, body: string | Buffer) {
  res.writeHead(200, { "content-type": type, "content-security-policy": CSP, "cache-control": "no-cache" });
  res.end(body);
}

function sendToast(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(text ? toast(text) : "");
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && (path === "/" || path === "/demo")) return serve(res, "text/html; charset=utf-8", await readFile(new URL("index.html", WEB)));
    // The page's script is TypeScript. Node blanks out the types, as it does for the server's own
    // .ts files, so line and column numbers in the browser's devtools match office.ts.
    if (req.method === "GET" && path === "/office.js") {
      return serve(res, "text/javascript; charset=utf-8", stripTypeScriptTypes(await readFile(new URL("office.ts", WEB), "utf8")));
    }

    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const v = viewFor(url);
      clients.set(res, v);
      res.write(frame(v));
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && path === "/api/hook") {
      if (req.headers.origin) { res.writeHead(403).end(); return; }
      const e: HookEvent = JSON.parse(await readBody(req));
      const header = (h: string) => (typeof req.headers[h] === "string" ? (req.headers[h] as string) : "") || undefined;
      store.applyHook(e, { surface: header("x-cmux-surface"), workspace: header("x-cmux-workspace") });
      res.writeHead(204).end();
      broadcast();
      return;
    }

    if (req.method === "POST" && path.startsWith("/api/")) {
      if (!fromPage(req)) { res.writeHead(403).end(); return; }
      await readBody(req); // Datastar sends the page's signals; nothing here needs them
      const [, , action, a, b] = path.split("/").map(decodeURIComponent);
      let text = "";
      const v = viewFor(url);
      const fromCmux = url.searchParams.get("from") === "cmux";
      if (action === "jump" && a) text = await jump(v, a, fromCmux);
      else if (action === "fire") text = await fire(v, fromCmux);
      else if (action === "settings" && a && b) text = await changeSetting(v, a, b);
      else { res.writeHead(404).end(); return; }
      sendToast(res, text);
      broadcast();
      return;
    }

    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`The AI Crowd is in the basement: http://localhost:${PORT}`);
  console.log(`Settings: ${CONFIG_PATH}`);
});

const refreshShortcuts = async () => { shortcuts = await readShortcuts(); };
refreshShortcuts();
setInterval(refreshShortcuts, 30_000);
pollRegistry();
setInterval(pollRegistry, 2000);
setInterval(broadcast, 1000);
