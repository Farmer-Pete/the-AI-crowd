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
  sound: "office",
  muted: false,
  popBubbles: true,
  hooksDismissed: false,
};

export function loadSettings(): Settings {
  try {
    const saved: Record<string, unknown> = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const out: Settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof DEFAULTS[key]) Object.assign(out, { [key]: saved[key] });
    }
    if (out.sound !== "beep") out.sound = "office"; // "phone" was the office sounds' old name
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s: Settings) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(s, null, 2) + "\n");
}

// The settings that are on or off.
type Flag = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
const isFlag = (key: string): key is Flag => Object.hasOwn(DEFAULTS, key) && typeof DEFAULTS[key as keyof Settings] === "boolean";

// Applies one change from the page: "toggle", "true", "false", or a sound name. Returns false if invalid.
export function applySetting(s: Settings, key: string, value: string): boolean {
  if (isFlag(key)) {
    if (value === "toggle") s[key] = !s[key];
    else if (value === "true" || value === "false") s[key] = value === "true";
    else return false;
    return true;
  }
  if (key === "sound" && (value === "office" || value === "beep")) { s.sound = value; return true; }
  return false;
}
