// Reads the user's cmux shortcuts for the right sidebar, so the Dock hint shows their own keys.
// cmux resolves a shortcut in this order (Sources/KeyboardShortcutSettings.swift):
//   1. ~/.config/cmux/cmux.json → shortcuts.bindings.<action>. A file-managed shortcut can't be changed in Settings.
//   2. A shortcut saved in cmux Settings: macOS defaults, domain com.cmuxterm.app, key "shortcut.<action>",
//      stored as JSON data like {"key":"b","command":true,"option":true,...}.
//   3. cmux's built-in default.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CMUX_JSON = join(homedir(), ".config", "cmux", "cmux.json");
const DEFAULTS_DOMAIN = "com.cmuxterm.app";

// Show or hide the right sidebar (where the Dock lives), and move keyboard focus into it.
export const ACTIONS = { toggle: "toggleFileExplorer", focus: "focusRightSidebar" } as const;
const BUILT_IN: Record<string, string> = { toggleFileExplorer: "⌥⌘B", focusRightSidebar: "⇧⌘E" };

export type Shortcuts = { toggle: string | null; focus: string | null };

// Removes // and /* */ comments and trailing commas, leaving strings alone, so JSON.parse can read JSONC.
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const UNBOUND = new Set(["", "none", "clear", "unbound", "disabled"]);
const MODIFIERS: [string[], string][] = [[["ctrl", "control"], "⌃"], [["opt", "option", "alt"], "⌥"], [["shift"], "⇧"], [["cmd", "command"], "⌘"]];
const KEYS: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", return: "⏎", enter: "⏎", tab: "⇥", space: "Space", escape: "⎋", esc: "⎋", delete: "⌫" };

const keyName = (k: string) => KEYS[k.toLowerCase()] ?? k.toUpperCase();

// "cmd+opt+b" → "⌥⌘B", in the macOS modifier order ⌃⌥⇧⌘.
function formatOne(binding: string): string | null {
  const parts = binding.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return MODIFIERS.filter(([names]) => names.some((n) => mods.has(n))).map(([, sym]) => sym).join("") + keyName(key);
}

// A cmux.json binding: a string, an array for a two-step chord, or an unbind marker.
export function formatBinding(b: unknown): string | null {
  if (b === null || (typeof b === "string" && UNBOUND.has(b.trim().toLowerCase()))) return null;
  if (typeof b === "string") return formatOne(b);
  if (Array.isArray(b)) {
    const steps = b.map((s) => (typeof s === "string" ? formatOne(s) : null));
    return steps.every(Boolean) ? steps.join(" then ") : null;
  }
  return null;
}

type Stored = { key?: string; command?: boolean; shift?: boolean; option?: boolean; control?: boolean;
  chordKey?: string | null; chordCommand?: boolean; chordShift?: boolean; chordOption?: boolean; chordControl?: boolean };

// A shortcut saved in cmux Settings. An empty key means the user unbound it.
export function formatStored(s: Stored): string | null {
  const one = (key: string | null | undefined, ctrl?: boolean, opt?: boolean, shift?: boolean, cmd?: boolean) =>
    key ? `${ctrl ? "⌃" : ""}${opt ? "⌥" : ""}${shift ? "⇧" : ""}${cmd ? "⌘" : ""}${keyName(key)}` : null;
  const first = one(s.key, s.control, s.option, s.shift, s.command);
  if (!first) return null;
  const chord = one(s.chordKey, s.chordControl, s.chordOption, s.chordShift, s.chordCommand);
  return chord ? `${first} then ${chord}` : first;
}

// Pulls one saved shortcut out of `defaults export` XML: <key>shortcut.X</key><data>base64</data>.
export function storedFromPlist(xml: string, action: string): Stored | undefined {
  const m = xml.match(new RegExp(`<key>shortcut\\.${action}</key>\\s*<data>([\\s\\S]*?)</data>`));
  if (!m) return undefined;
  try { return JSON.parse(Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8")); } catch { return undefined; }
}

export function resolve(action: string, fileBindings: Record<string, unknown>, plistXml: string): string | null {
  if (action in fileBindings) return formatBinding(fileBindings[action]);
  const stored = storedFromPlist(plistXml, action);
  if (stored) return formatStored(stored);
  return BUILT_IN[action] ?? null;
}

export async function readShortcuts(): Promise<Shortcuts> {
  let bindings: Record<string, unknown> = {};
  try { bindings = JSON.parse(stripJsonc(await readFile(CMUX_JSON, "utf8")))?.shortcuts?.bindings ?? {}; } catch { /* no file or unreadable */ }
  let xml = "";
  try { xml = (await run("defaults", ["export", DEFAULTS_DOMAIN, "-"], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 })).stdout; } catch { /* cmux never ran */ }
  return { toggle: resolve(ACTIONS.toggle, bindings, xml), focus: resolve(ACTIONS.focus, bindings, xml) };
}
