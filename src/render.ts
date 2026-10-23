// Server-rendered HTML that Datastar patches into the page.
// Datastar runs data-* attributes and <script> tags it receives, so every string that came
// from a transcript or a hook goes through esc(), and only safe ids reach an attribute.

import type { Settings, ViewAgent } from "./types.ts";

const TIER_HEADING = { urgent: "NEEDS YOU", review: "TO REVIEW", quiet: "FINE" };
const SAFE_ID = /^[\w.-]{1,100}$/;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

function ago(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The page reads data-id to jump on a click and to mark the row picked with the keyboard.
const jumpAttr = (id: string) => (SAFE_ID.test(id) ? ` data-id="${id}"` : "");

function row(a: ViewAgent, now: number): string {
  const detail = `${a.detailLabel ? `<span class="dl ${a.tier}">${a.detailLabel}</span>` : ""}${esc(a.detail)}`;
  const helpers = a.helpers.map((h) => `<tr class="helper"><td colspan="4">↳ helper: ${esc(h.label)}</td></tr>`).join("");
  return `<tr class="row"${jumpAttr(a.id)}>` +
    `<td><div class="who"><img class="portrait" data-portrait="${esc(a.id)}" alt=""><div>` +
    `<small class="proj" title="${esc(a.cwd)}">${esc(a.project)}</small><b${a.about ? ` title="${esc(a.about)}"` : ""}>${esc(a.title)}</b> <span class="src">${a.source}</span></div></div></td>` +
    `<td><div class="clamp" title="${esc(a.detail)}">${detail}</div></td>` +
    `<td><span class="pill ${a.tier}">${esc(a.label)}</span></td>` +
    `<td class="wait${a.tier !== "quiet" ? " long" : ""}">${ago(a.since, now)}</td></tr>${helpers}`;
}

export function renderList(view: ViewAgent[], now: number): string {
  const rows: string[] = [];
  let lastTier = "";
  for (const a of view) {
    if (a.state === "ended") continue;
    if (a.tier !== lastTier) rows.push(`<tr class="tier"><td colspan="4">${TIER_HEADING[a.tier]}</td></tr>`);
    lastTier = a.tier;
    rows.push(row(a, now));
  }
  const body = rows.join("") || `<tr><td class="empty" colspan="4">Nobody's in. Start a Claude Code session and it will show up here.</td></tr>`;
  return `<div id="list"><table><thead><tr><th>SESSION</th><th>NOW · ASKS · RESULT</th><th>STATE</th><th>WAITING</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderChips(view: ViewAgent[], settings: Settings): string {
  const n = { urgent: 0, review: 0, quiet: 0 };
  for (const a of view) if (a.state !== "ended") n[a.tier]++;
  return `<div id="chips" class="chips">` +
    `<span class="chip urgent"><b>${n.urgent}</b> need you</span>` +
    `<span class="chip review"><b>${n.review}</b> to review</span>` +
    `<span class="chip quiet"><b>${n.quiet}</b> fine</span>` +
    (settings.muted ? `<span class="chip urgent"><b>Sound muted</b></span>` : "") +
    `</div>`;
}
