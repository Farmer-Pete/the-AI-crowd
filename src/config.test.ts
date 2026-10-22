import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CONFIG_PATH is fixed at import, so point it at a temporary folder first.
const home = mkdtempSync(join(tmpdir(), "crowd-config-"));
process.env.XDG_CONFIG_HOME = home;
const { DEFAULTS, applySetting, loadSettings } = await import("./config.ts");

test("a saved sound of phone, the old name, loads as office", () => {
  mkdirSync(join(home, "the-ai-crowd"), { recursive: true });
  writeFileSync(join(home, "the-ai-crowd", "config.json"), JSON.stringify({ sound: "phone", muted: true }));
  assert.equal(loadSettings().sound, "office");
  assert.equal(loadSettings().muted, true);
});

test("the sound setting takes office or beep", () => {
  const s = { ...DEFAULTS };
  assert.equal(applySetting(s, "sound", "beep"), true);
  assert.equal(s.sound, "beep");
  assert.equal(applySetting(s, "sound", "phone"), false);
  assert.equal(applySetting(s, "sound", "office"), true);
  assert.equal(s.sound, "office");
});
