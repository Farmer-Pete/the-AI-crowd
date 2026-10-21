# The AI Crowd

A dashboard of every Claude Code session on your Mac, drawn as a pixel-art IT basement. It's a nod to The IT Crowd. Each session gets a desk and a randomly generated staffer. Agents that need you ring the red phone; the rest type quietly, drink tea, or fall asleep. A plain list next to the office gives the facts: session, what it's doing now, what it's asking, what it finished, and how long it has waited.

```
 claude sessions ──(plugin hooks, async curl)──▶ ┌────────────────┐ ──SSE (Datastar)──▶ office + list
 ~/.claude/sessions/*.json + transcripts ──poll──▶│ src/server.ts  │
 ~/.config/the-ai-crowd/config.json ◀──────────▶ └────────────────┘ ◀── clicks (jump, settings)
```

## Run it

Needs Node 26 or newer. There are no dependencies to install.

```sh
npm start        # http://localhost:4747
npm test
```

Set `AI_CROWD_PORT` to use another port; the plugin reads the same variable.

## Exact states with the plugin

Without the plugin, The AI Crowd reads `~/.claude/sessions` and the tail of each transcript. That's enough to see every session, but a permission prompt vs. a question is a guess, and API errors don't show. The plugin sends each hook event to the dashboard. The hooks are async and fail quietly, so Claude never waits on them, even when the dashboard isn't running.

In Claude Code:

```
/plugin marketplace add Farmer-Pete/the-AI-crowd
/plugin install the-ai-crowd@the-ai-crowd
```

Hooks load when a session starts, so sessions that were already running keep the guessed states until you restart them.

## What needs you

| Tier | When | In the office |
|---|---|---|
| Urgent | Needs permission, asked a question, or hit an API error | Red outline, ringing phone or raised hand, a speech bubble with the ask |
| Review | Finished a turn you haven't looked at | Amber outline, leaning back with tea |
| Quiet | Working, seen, or asleep | Typing, or an empty chair with z's |

A finished session stays in Review until you click it or send it a prompt. It falls asleep 30 minutes after you've seen it.

Clicking a session focuses its cmux pane. Start The AI Crowd from a cmux terminal so it can reach cmux.

## Alerts and chatter

By default, an urgent session plays a ring and shows a macOS notification. Browsers need one click before they allow either, so the page shows an "Enable alerts" bar until you do. The ALERTS switch on the office wall mutes everything. The CHATTER switch turns off the speech bubbles that pop up when a session starts something new or finishes. Urgent asks still show. The extinguisher jumps to the session that has waited longest.

Settings are saved to `~/.config/the-ai-crowd/config.json`.

## Layout

| Path | What |
|---|---|
| `src/server.ts` | HTTP server, Datastar SSE stream, actions |
| `src/store.ts` | Merges hook events with the registry; tiers, Seen, Asleep |
| `src/transcript.ts`, `src/registry.ts` | Reading Claude Code's local files |
| `src/render.ts` | The list and header HTML. Escapes everything from transcripts |
| `src/cmux.ts` | Finds and focuses a session's cmux pane |
| `src/demo.ts` | Scripted demo agents (Settings → Show demo agents) |
| `web/office.js` | The office canvas, characters, bubbles, alerts |
| `plugin/` | The Claude Code plugin with the hooks |

Datastar 1.0.4 loads from jsDelivr, pinned by a Subresource Integrity hash.
