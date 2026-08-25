# Mission Control

A local, zero-dependency web dashboard that turns recurring Claude Code tasks into
buttons. One click runs a headless agent with a fixed prompt and a fixed tool
allowlist, streams its reasoning to the browser live, and files the transcript.

## The problem

Running a small production company generates a dozen recurring analytical jobs:
review the sales pipeline, find overdue invoices and draft chase notes, check
whether project phases in the task list still match the CRM, research a prospect,
draft an editing brief. Each one is a well-understood procedure that takes an
agent five minutes and a person forty.

Doing them through a chat window has two failure modes. Either you retype a long,
carefully-worded prompt from memory each time and get a slightly different job
each time — or you save time by handing the agent broad permissions and hope it
doesn't email a client. The prompt and the permissions are the actual artifact,
and a chat window has nowhere to keep them.

This app is that missing place. Every recurring job is an entry in
[skills.json](skills.json) holding its prompt, its model, its turn limit, and
crucially its own tool allowlist. Adding a job means adding a JSON object; the
server re-reads the file on every page load, so there is no build and no restart.

## Architecture

Node built-ins only — `http`, `fs`, `path`, `child_process`, `os`. No npm
dependencies, no framework, no bundler. It serves a static page and shells out to
the Claude Code CLI in headless mode, relaying the agent's event stream to the
browser over server-sent events.

```
  Browser  (public/index.html + app.js)
      |  fetch /api/run          ^  EventSource /api/stream/<runId>
      v                          |
  +---+--------------------------+------------------------+
  |  server.js   zero-dependency http server              |
  |    reads skills.json per request (no restart needed)  |
  |    computes allowlist = defaults + per-skill tools    |
  |    applies global denylist from config                |
  |    persists every run to runs/<id>/                   |
  +---------------------+---------------------------------+
                        | spawn
       claude -p --output-format stream-json --verbose
              --allowedTools ... --disallowedTools ...
                        |
              JSON-lines event stream
```

Each run gets a directory under `runs/` holding its metadata, the raw event
stream, and the final result, so a run that finished yesterday can still be
reopened. Buttons declared `"kind": "report"` have their final message parsed as
JSON and written to `data/report.json`, which is what the dashboard's status card
renders — the agent produces the dashboard's own data.

## The genuinely hard part

Making the guardrails structural rather than advisory.

The obvious way to stop an agent emailing a client is to write "do not send
anything" in the prompt. That is a request, not a constraint, and it is one
misread instruction away from failing. The interesting version is to make the
capability absent: a button that drafts client outreach is launched with an
allowlist containing `Write` and the CRM's *read* tools, and nothing else. It
cannot send a message because no send tool exists in its process — the same
reason you cannot dial a phone that was never installed.

Two layers implement it. Each skill declares `allowedTools`, unioned with a
conservative default set, and passed as `--allowedTools`. Separately a global
`disallowedTools` denylist in [config.example.json](config.example.json) names
every outward-facing operation across the connected integrations — send message,
send invoice, publish post, and every delete — and is passed on every run
regardless of what a skill asked for. The allowlist is the real control; the
denylist is there so a careless future edit to one skill's tool list cannot
quietly re-enable sending.

### Where that model leaks, honestly

Nine of the twenty-one buttons grant `Bash`, because they call skills that
genuinely need it — running ffmpeg, filling a PDF, invoking another CLI. `Bash`
is a universal escape hatch: a denylist naming integration tools does nothing to
stop `curl`. For those nine buttons the guarantee degrades from "cannot" back to
"instructed not to."

That is the honest state of it. The app runs locally, bound to `127.0.0.1`, on a
machine whose owner could run those commands anyway, so the practical risk is
low — but the claim "this app cannot send anything" is only true of the twelve
buttons that do not grant `Bash`, and it is worth saying so precisely rather than
claiming the stronger version.

## What I'd do differently

1. **Split the tool tiers explicitly.** Buttons should be declared `readonly`,
   `writes-files`, or `shells-out`, with the UI showing which tier it is about to
   run. Right now that distinction exists in the JSON but is invisible at the
   moment of clicking.
2. **No schema validation on `skills.json`.** Re-reading it per request is what
   makes editing feel instant, but a trailing comma takes the whole page down
   with a JSON parse error. It should validate and surface the bad entry while
   still serving the good ones.
3. **`runs/` grows without bound.** Every run persists forever. Needs a retention
   window.
4. **No tests.** The stream parser deserves them most — it reassembles JSON
   objects from a chunked stdout stream, which is exactly the code that breaks on
   an unlucky buffer boundary and not in any obvious way.
5. **Single-user by construction.** State lives in a module-level `Map`, so two
   browser tabs share one view of what is running. Fine for a local dashboard,
   wrong for anything else.

## Setup

Requires Node 18+ and the [Claude Code CLI](https://claude.com/claude-code)
installed and authenticated.

```bash
git clone <this-repo>
cd mission-control
node server.js --open
```

There is nothing to install — the server has no dependencies. It binds
`127.0.0.1:4173` and opens a browser.

### Configuration

Defaults work on a clean clone: the Claude binary is found on `PATH`, runs use
the repo directory as their working directory, and transcripts are read from
`~/.claude/projects`. To change any of that, either set environment variables —
`MC_PORT`, `MC_CLAUDE_EXE`, `MC_DEFAULT_CWD`, `MC_CLAUDE_PROJECTS_DIR` — or copy
[config.example.json](config.example.json) to `config.json` and edit it.
`config.json` is gitignored so machine-specific paths never get committed.

Point `MC_DEFAULT_CWD` at a workspace containing your own `CLAUDE.md` /
`MEMORY.md` / `TASKS.md`; the button prompts assume that context is loadable.

### Adding a button

Append an object to `skills.json` and reload the page:

```json
{
  "id": "my-task",
  "label": "My Task",
  "group": "Daily Ops",
  "description": "What it does, shown under the button.",
  "input": { "label": "Topic", "placeholder": "optional free text", "required": false },
  "allowedTools": ["Read", "Write"],
  "maxTurns": 30,
  "prompt": "Do the thing with: {input}"
}
```

`{input}` is substituted with whatever the user typed. `allowedTools` is merged
with the defaults in config; the global denylist always applies on top.

## Notes on this public version

- The sample buttons are generic examples. The original wired them to real CRM
  pipeline identifiers and client-specific procedures; those are replaced with
  named placeholders (`SALES_PIPELINE_ID`, `PRODUCTION_PIPELINE_ID`,
  `PRODUCTION_CALENDAR_ID`) you would fill in for your own install.
- `data/report.example.json` is fabricated sample data so the dashboard renders
  something before the first real run.
- The original used two commercially licensed brand typefaces. This version loads
  the open-licensed Archivo, Poppins and Permanent Marker from Google Fonts
  instead.

## Licence

MIT — see [LICENSE](LICENSE). The logo files under `public/assets/` are
trademarks and are excluded; replace them if you fork this.
