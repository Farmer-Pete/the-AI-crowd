// Settings live in ~/.config/the-ai-crowd/config.json (or $XDG_CONFIG_HOME). You can edit it by hand.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Settings } from "./types.ts";

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "the-ai-crowd", "config.json");

export const DEFAULTS: Settings = {
  urgentSound: true,
  tabCount: true,
  reviewSound: false,
  sound: "phone",
  muted: false,
  popBubbles: true,
  hooksDismissed: false,
};

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const out: Settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof DEFAULTS[key]) (out as any)[key] = saved[key];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s: Settings) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(s, null, 2) + "\n");
}

// Applies one change from the page: "toggle", "true", "false", or a sound name. Returns false if invalid.
export function applySetting(s: Settings, key: string, value: string): boolean {
  if (!(key in DEFAULTS)) return false;
  const k = key as keyof Settings;
  if (typeof DEFAULTS[k] === "boolean") {
    if (value === "toggle") (s as any)[k] = !s[k];
    else if (value === "true" || value === "false") (s as any)[k] = value === "true";
    else return false;
    return true;
  }
  if (k === "sound" && (value === "phone" || value === "beep")) { s.sound = value; return true; }
  return false;
}
