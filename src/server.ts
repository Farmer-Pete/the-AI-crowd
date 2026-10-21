// The AI Crowd: a local dashboard of every Claude Code session on this machine.
// Serves the page, streams updates to it over SSE in Datastar's event format,
// and takes hook events from the plugin at POST /api/hook.
// Run: npm start   (Node 26 runs this .ts file directly)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { CONFIG_PATH, applySetting, loadSettings, saveSettings } from "./config.ts";
import { demoAgents } from "./demo.ts";
import { focus, matchPane, readPanes, releaseDockFocus, ttysOf } from "./cmux.ts";
import { readRegistry } from "./registry.ts";
import { readShortcuts, type Shortcuts } from "./shortcuts.ts";
import { renderChips, renderList } from "./render.ts";
import { createStore, type HookEvent } from "./store.ts";
import { readTranscript, transcriptPath } from "./transcript.ts";

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
const clients = new Set<ServerResponse>();
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

const currentView = () => store.view(settings.showDemo ? demoAgents(Date.now()) : []);

// ---- Datastar SSE -------------------------------------------------------------

const event = (name: string, lines: string[]) => `event: ${name}\n${lines.map((l) => `data: ${l}\n`).join("")}\n`;
const patchElements = (html: string) => event("datastar-patch-elements", html.split("\n").map((l) => `elements ${l}`));
// Always JSON.stringify: Datastar evaluates a signals payload that isn't valid JSON.
const patchSignals = (signals: Record<string, unknown>) => event("datastar-patch-signals", [`signals ${JSON.stringify(signals)}`]);
const toast = (text: string) => patchSignals({ _toast: JSON.stringify({ text, at: Date.now() }) });

function frame(): string {
  const now = Date.now();
  const view = currentView();
  // The page's office canvas reads _state; underscore signals are never sent back to the server.
  const state = { now, agents: view, settings, hooks: store.hooksSeen(), shortcuts };
  return patchElements(renderChips(view, settings)) + patchElements(renderList(view, now)) + patchSignals({ _state: JSON.stringify(state) });
}

function broadcast() {
  if (!clients.size) return;
  const f = frame();
  for (const c of clients) c.write(f);
}

// ---- actions ------------------------------------------------------------------

// fromCmux: the click or Enter came from a page inside cmux, such as the Dock, which keeps focus unless released.
async function jump(id: string, fromCmux = false): Promise<string> {
  const a = currentView().find((x) => x.id === id);
  if (!a) return "That agent has gone home.";
  store.markSeen(a);
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

async function fire(fromCmux = false): Promise<string> {
  const oldest = currentView().find((a) => a.tier === "urgent");
  if (!oldest) return "No fires. Carry on.";
  return `Putting out the oldest fire. ${await jump(oldest.id, fromCmux)}`;
}

async function changeSetting(key: string, value: string): Promise<string> {
  if (!applySetting(settings, key, value)) return "That setting doesn't exist.";
  await saveSettings(settings);
  if (key === "muted") return settings.muted ? "Alerts off. Nobody can reach you down here." : "Alerts back on.";
  if (key === "popBubbles") return settings.popBubbles ? "Chatter on." : "Chatter off. Only agents that need you will speak up.";
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

async function serveFile(res: ServerResponse, name: string, type: string) {
  res.writeHead(200, { "content-type": type, "content-security-policy": CSP, "cache-control": "no-cache" });
  res.end(await readFile(new URL(name, WEB)));
}

function sendToast(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(text ? toast(text) : "");
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/") return await serveFile(res, "index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/office.js") return await serveFile(res, "office.js", "text/javascript; charset=utf-8");

    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      res.write(frame());
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
      const fromCmux = url.searchParams.get("from") === "cmux";
      if (action === "jump" && a) text = await jump(a, fromCmux);
      else if (action === "fire") text = await fire(fromCmux);
      else if (action === "settings" && a && b) text = await changeSetting(a, b);
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
