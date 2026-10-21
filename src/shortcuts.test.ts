import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBinding, formatStored, resolve, stripJsonc } from "./shortcuts.ts";

const plist = (action: string, stored: object) =>
  `<dict><key>shortcut.${action}</key>\n\t<data>\n\t${Buffer.from(JSON.stringify(stored)).toString("base64")}\n\t</data></dict>`;

test("JSONC comments and trailing commas go, strings with // stay", () => {
  const text = `{
    // a comment
    "url": "https://example.com", /* block */
    "shortcuts": { "bindings": { "focusRightSidebar": "cmd+shift+e", }, },
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)), { url: "https://example.com", shortcuts: { bindings: { focusRightSidebar: "cmd+shift+e" } } });
});

test("cmux.json bindings read as macOS key symbols", () => {
  assert.equal(formatBinding("cmd+opt+b"), "⌥⌘B");
  assert.equal(formatBinding("ctrl+shift+e"), "⌃⇧E");
  assert.equal(formatBinding(["ctrl+b", "e"]), "⌃B then E");
  assert.equal(formatBinding("none"), null);
  assert.equal(formatBinding(null), null);
});

test("shortcuts saved in cmux Settings read the same way", () => {
  assert.equal(formatStored({ key: "d", command: true, control: true }), "⌃⌘D");
  assert.equal(formatStored({ key: "" }), null);
});

test("cmux.json wins, then Settings, then the default", () => {
  const saved = plist("focusRightSidebar", { key: "f", command: true, option: true, shift: false, control: false });
  assert.equal(resolve("focusRightSidebar", { focusRightSidebar: "ctrl+e" }, saved), "⌃E");
  assert.equal(resolve("focusRightSidebar", {}, saved), "⌥⌘F");
  assert.equal(resolve("focusRightSidebar", {}, ""), "⇧⌘E");
  assert.equal(resolve("toggleFileExplorer", {}, ""), "⌥⌘B");
  assert.equal(resolve("toggleFileExplorer", { toggleFileExplorer: "disabled" }, ""), null);
});
