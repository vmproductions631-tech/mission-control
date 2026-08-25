# Spec — VMP Mission Control

A local web app that sits on top of Claude Code: dashboard, one-click skill buttons, session log. Definition of done: a teammate who has never opened a terminal can open the app, read the daily report, and run any skill with one click.

## Architecture

- **R1.** The app lives at the repository directory and has zero npm dependencies — Node built-in modules only (`http`, `fs`, `path`, `child_process`, `os`).
- **R2.** Launched by double-clicking `VMP Mission Control.cmd`, which invokes Node by full path (a configurable full path, for machines where Node is not on PATH). The server opens the browser at `http://localhost:4173` once listening. If the port is already in use, the launcher just opens the browser (server already running) instead of erroring.
- **R3.** Headless runs invoke Claude Code by spawning `node.exe` directly on the npm-installed `cli.js` (resolved from `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js`), falling back to `claude.cmd` via shell if that path is missing. The prompt is passed via stdin (never shell-interpolated).
- **R4.** Runs use `-p --output-format stream-json --verbose`, a per-button `--allowedTools` list, and a global `--disallowedTools` denylist. Default working directory for runs is the configured workspace root so CLAUDE.md/MEMORY.md/TASKS.md context loads; per-button override allowed.
- **R5.** Safety posture: `--dangerously-skip-permissions` is never used. The global denylist blocks every outbound/destructive tool available to the CLI (GHL send/delete/void tools, Meta publish tools, Telegram send) on every run regardless of button config. Draft-only is enforced structurally.

## Configuration (the 5-minute rule)

- **R6.** All buttons are defined in `skills.json`. Adding a button requires only appending one JSON object — no server or HTML changes. Fields: `id`, `label`, `group`, `description`, `prompt`, optional `input` (`{label, placeholder}`), optional `allowedTools` (merged with a default read-only set), optional `model`, optional `cwd`, optional `maxTurns`.
- **R7.** `{input}` in a prompt template is replaced by the text the user typed in the button's input field. Buttons with an `input` field render a text box; the run is blocked client-side if a required input is empty.
- **R8.** Server-level settings (port, paths, default allowed tools, global disallowed tools) live in `config.json`.
- **R9.** `README.md` documents how to add a button with a copy-paste template, and lists known limitations (Outlook/Gmail/QuickBooks/Monday not reachable headless).

## Dashboard (view 1)

- **R10.** Daily report card rendered from `data/report.json`: yesterday's completions, today's calendar (the CRM Production Days), open task counts by priority + top items (from TASKS.md), pipeline value by stage, overdue invoices. Shows "last updated" timestamp and a Refresh button.
- **R11.** The Refresh button triggers a special headless run whose prompt instructs Claude to output ONLY a JSON object matching the report schema; the server parses the final result message and writes `data/report.json`. A failed parse keeps the previous report and surfaces an error.
- **R12.** Social stats panel (IG followers, recent post performance) is part of the same report JSON, pulled via the `meta` MCP read tools.
- **R13.** "Sessions this week" panel: the server scans `~/.claude/projects/*/*.jsonl` mtimes locally (no Claude call) and renders per-day counts for the last 7 days plus a recent-sessions list (project, time).
- **R14.** "Ran overnight / automations" panel: lists app runs since 8 PM the previous day (from the run log) plus the known automations registry (`automations.json`: morning-brief, lead-response-drafts, Plaid Weekly Sync, vmp-morning-command-center) with schedule and where they run (cloud/local).

## Skill buttons (view 2)

- **R15.** Every button from `skills.json` renders grouped by `group`, with label + description, one-click run.
- **R16.** Clicking Run starts a headless run and streams output live into a panel via SSE: assistant text, tool-use events (tool name + one-line summary), and the final result. The panel shows status (running/succeeded/failed), elapsed time, and cost when finished.
- **R17.** Buttons ship in six groups: Daily Ops (Daily Report, Pipeline Drift Check vs TASKS.md, Task Triage), Sales (Pipeline Review, Lead Dossier*, Outreach Drafts, Blue Ocean*), Content (Editing Brief*, Post-Shoot, TikTok Trend Hunter*, Caption Generator*, X Long-form*, YT Competitive Analysis*), Finance (Revenue Snapshot, Invoice Chase, Invoice Organizer, Client Timesheet), Research (Deep Research*, Quick Research*), System (Weekly Skill Review, Session Audit). Starred = has an input field.
- **R18.** Only one concurrent run per button; multiple different buttons may run in parallel. A running button shows a stop control that kills the child process.

## Session log (view 3)

- **R19.** Every run is persisted in `runs/`: a `meta.json` (id, skill, label, input, start/end, status, duration, cost, model, short result summary) and a `transcript.ndjson` (raw stream-json events).
- **R20.** The log view lists runs newest-first (skill, when, status, duration, cost, first line of result); clicking one expands the full rendered transcript. The log survives restarts (files, not memory).

## UI / brand

- **R21.** Dark UI: ink `#040707` background, neutral panels, gold `#EDC332` held to ~10% (buttons/accents/rules — never washes). Headlines in Archivo (uppercase), body Poppins, at most one Permanent Marker accent - all open-licensed and loaded from Google Fonts. Supplied logo file (`logo-lockup-dark.png` on ink), never rebuilt.
- **R22.** Single-page app, three tabs, no build step: plain HTML/CSS/JS served by the same server.

## Verification

- **R23.** Every button is tested end to end through the real HTTP API (POST run → SSE stream → run log entry). Expensive buttons may substitute a cheaper model or reduced prompt for the test, but must prove: spawn works, allowlist is sufficient for the skill's tools, stream renders, log persists.
- **R24.** The denylist is verified by at least one test proving a blocked tool is actually denied.
- **R25.** Final walkthrough in the browser: open app, read report, run one skill, show its log entry.
