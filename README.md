# Claude Conductor

A small Node.js web app that schedules prompts and runs them through `claude -p`. No database — every cron and every log line lives in plain files under `~/.claude/claude-conductor`.

## Run it

```bash
npm install
npm start          # http://127.0.0.1:4321
npm run dev        # same, restarts on file changes
```

## Start at login (macOS)

macOS starts per-user background processes with **launchd**, via a LaunchAgent plist in `~/Library/LaunchAgents`. Paste this block to generate one with your own absolute paths filled in:

```bash
mkdir -p ~/Library/Logs/claude-conductor
cat > ~/Library/LaunchAgents/local.claude-conductor.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.claude-conductor</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$PWD/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>4321</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/claude-conductor/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/claude-conductor/server.log</string>
</dict>
</plist>
EOF
```

Run it from the project directory, since it uses `$PWD`. Then register and start:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude-conductor.plist
```

That starts it now and at every login. Open http://127.0.0.1:4321.

### Start and stop

| Task | Command |
| --- | --- |
| Start (and enable at login) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude-conductor.plist` |
| Stop (and disable at login) | `launchctl bootout gui/$(id -u)/local.claude-conductor` |
| Restart after changing code | `launchctl kickstart -k gui/$(id -u)/local.claude-conductor` |
| Is it running? | `launchctl print gui/$(id -u)/local.claude-conductor \| grep -E "state =\|pid ="` |
| Server log | `tail -f ~/Library/Logs/claude-conductor/server.log` |
| Remove entirely | `launchctl bootout gui/$(id -u)/local.claude-conductor && rm ~/Library/LaunchAgents/local.claude-conductor.plist` |

`bootout` both stops the server and stops it coming back at login, so it is the pair to `bootstrap` rather than a temporary pause. Editing the plist requires a `bootout` then `bootstrap`; `kickstart -k` only restarts the process with the plist launchd already has.

`KeepAlive` restarts the server if it exits for any reason — verified by killing the process and watching launchd bring it back under a new pid, throttled to one restart per 10 seconds.

### The two settings that are not optional

A launchd agent does not inherit your shell environment. `launchctl getenv PATH` is empty, and an agent's environment is only what the plist provides plus a minimal default of `/usr/bin:/bin:/usr/sbin:/sbin`. Both entries above exist because of that:

- **`HOME`** — without it the server starts and then hangs before it ever listens, writing nothing to its log at all. There is no error to find; it just never answers. This one costs the most time to diagnose, so set it.
- **`PATH`** — without it the server runs fine but every run fails instantly with `process error: spawn claude ENOENT`, because `claude` lives in `~/.local/bin` and `node` in `/opt/homebrew/bin`, neither of which is in launchd's default path. Model discovery also comes up empty. Adjust the entry if your `claude` or `node` live elsewhere; `which claude` and `which node` will say.

That `PATH` is also what `claude` itself inherits for each run, so anything your prompts rely on — `git`, `gh`, project tooling — needs to be reachable from it too.

Model discovery is slower on the first run after login, around 14 seconds against 4 in a warm shell, because it reads the 200MB CLI binary from a cold page cache. The server is serving pages throughout; only the Model dropdown waits.

### Alternatives

- **Login Items** in System Settings only accepts applications, not a Node script, so it does not apply here.
- **`brew services`** manages Homebrew formulae, not arbitrary projects.
- Running `npm start` in a terminal remains fine for occasional use; it stops when the terminal closes.

## Storage layout

```
~/.claude/claude-conductor/
├── crons/
│   └── <uuid>.json                 # one file per cron
└── logs/
    └── <Cron Name>/
        └── 2026-09-10T06-11-12.789Z.txt   # one file per run, newest 50 kept
```

A cron file:

```json
{
  "id": "e628139b-b4dc-4e50-af3f-c439c92515be",
  "name": "Nightly Digest",
  "description": "Summarize the day",
  "cron": "0 9 * * *",
  "workingDirectory": "/Users/you/code/project",
  "model": "claude-sonnet-4-5",
  "prompt": "Write a two line summary of today.",
  "isActive": true,
  "createdAt": "2026-09-10T06:11:04.188Z",
  "updatedAt": "2026-09-10T06:11:04.188Z",
  "lastRunAt": "2026-09-10T06:11:12.789Z",
  "lastRunStatus": "succeeded",
  "lastRunLog": "2026-09-10T06-11-12.789Z.txt",
  "lastRunDurationSeconds": 3.3
}
```

Files are safe to edit or delete by hand — the server polls the folder and picks changes up within a few seconds. See [Editing files by hand](#editing-files-by-hand).

## Editing files by hand

The `crons` folder is polled every 3 seconds. Changes made outside the app are applied to the scheduler and announced in the UI as a toast:

| On disk | Effect | Toast |
| --- | --- | --- |
| New `.json` file | Scheduled | `Cron file added: "X" — now scheduled` |
| File edited | Rescheduled | `Cron file updated: "X" — rescheduled` |
| File deleted | Unscheduled | `Cron file deleted: "X" — unscheduled` |
| File is invalid JSON | Keeps its last good schedule | `x.json is not valid JSON — still running its last saved version` |
| Invalid file fixed | Rescheduled | `Cron file fixed: "X" — rescheduled` |

Set `WATCH_INTERVAL_MS` to change the interval, or `0` to switch the watcher off.

Two things the watcher deliberately stays quiet about, so you don't get told twice about your own actions:

- **Changes made through the UI or API.** Those already reload the scheduler and show their own toast.
- **Run bookkeeping.** Every run rewrites `lastRunAt`, `lastRunStatus`, `lastRunLog` and `lastRunDurationSeconds` in the cron file. Only the config fields (`name`, `description`, `cron`, `workingDirectory`, `prompt`, `isActive`) count as a change.

A file caught mid-write is treated as unchanged rather than deleted, so a save from an editor that truncates before writing does not cause a delete-then-add flicker.

## How a run works

1. The schedule fires, or you press **Run now**.
2. The server spawns `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages` in the cron's working directory.
3. The assistant's text is pulled out of the event stream and written to `logs/<name>/<start time>.txt` as it arrives, so the log reads as plain output and can be tailed mid-run. stderr goes in verbatim, as does any stdout line that is not JSON (a CLI warning, say).
4. On exit, the run's statistics block is written, then a footer records the outcome (`succeeded` / `failed` / `stopped`, duration, exit code). Logs beyond the newest 50 for that cron are deleted.

A cron never runs twice at once. If a schedule fires while the previous run is still going, that trigger is skipped and the UI says so.

## Stopping a run

While a run is in flight, that cron's **Run now** button becomes **Stop**. Stopping signals the whole process group, so anything `claude` spawned goes with it: `SIGTERM` first, then `SIGKILL` five seconds later if it is still alive. Both are written into the log:

```
--- stop requested by user at 2026-09-10T06:41:54.168Z ---
--- still alive 5s after SIGTERM, sending SIGKILL ---
--- stopped after 6.2s (killed by user, signal SIGKILL) ---
```

The run's outcome is recorded as `stopped`, distinct from `succeeded` and `failed`. The schedule is left alone: an active cron stays armed and fires again at its next trigger, so stopping one run never disables the cron. Use the Is Active checkbox for that.

## Run statistics

Every completed run ends with a block built from the CLI's own accounting, not from anything the model says about itself:

```
=-----------------------------------=
Model: claude-opus-5[1m]
Runtime: 5.8s
Tokens: 35,665 (in 2 / out 57 / cache 35,606)
Cost: $0.2342
=-----------------------------------=
```

The numbers come from the `result` event's `modelUsage`, `duration_ms`, `usage` and `total_cost_usd` fields. `Runtime` is the CLI's own measure of the turn, which is shorter than the footer's wall-clock duration because that includes process startup. Cache tokens dominate the token count on short prompts — that is the system prompt and context being read back, and it is what you are billed for.

A run that is stopped or that fails before producing a result event has no statistics block, only the footer.

## Real-time updates

Two Server-Sent Event streams, no polling loops in the UI:

- `GET /api/events` — cron changes, run started, run stopping, run finished, trigger skipped. The home page redraws when one arrives.
- `GET /api/crons/:id/logs/:file/stream` — one log file: everything written so far, then each new chunk. Closes itself with a `done` event when the run ends.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Localhost only by default. |
| `CONDUCTOR_HOME` | `~/.claude/claude-conductor` | Storage root |
| `CLAUDE_BIN` | `claude` | Binary to spawn. Set an absolute path if `claude` is not on the server's `PATH`. |

## Model

The form has a Model dropdown. Leave it on **Default** and nothing is passed, so the run uses whatever the CLI is configured to use. Pick anything else and it is passed as `claude --model <value>`.

The list is discovered from the installed CLI, not hardcoded, so it tracks the version you have:

1. Candidate ids are read out of the `claude` binary, where the version's own model catalog lives, along with the documented aliases `opus`, `sonnet`, `haiku` and `fable`.
2. Each candidate is checked with `claude -p "" --model <id>`, which validates the model and then exits on the missing prompt. That costs no tokens.
3. Whatever the CLI recognises becomes the dropdown, newest first per family.

Discovery runs at startup in the background, takes about four seconds, and found 21 of 25 candidates here — the four rejects were scraping noise, which is exactly what step 2 is for. The dropdown and its **Refresh** button are both disabled while it runs. Press Refresh after updating Claude Code to pick up new models.

An alias records what it resolved to: a cron set to `haiku` logs `Model: claude-haiku-4-5-20251001` in its statistics block, so you can always tell what actually ran. A model saved in a cron file that the current CLI no longer lists is kept and shown as `(not in this CLI's catalog)` rather than being silently reset.

## Working directory

The field defaults to `~/` on a new cron and autocompletes as you type: suggestions come from the filesystem, `↑`/`↓` picks one, `Enter` or `Tab` accepts it. Accepting ends the path in `/`, so pressing `Enter` again drills into that directory. Under the field, a live note shows the absolute path the run will use, or says the path does not exist.

Paths are stored exactly as typed. They are resolved at spawn time:

| Stored | Runs in |
| --- | --- |
| `~/code/project` | `/Users/you/code/project` |
| `~` or blank | `/Users/you` |
| `Documents` | `/Users/you/Documents` (relative means relative to home) |
| `/tmp` | `/tmp` |

Each log's header records the resolved absolute path, so there is never a question about where a run happened.

## Cron expressions

Five fields `(m h dom mon dow)`, evaluated in the server's local timezone. `0 9 * * *` is 9am daily; `*/15 * * * *` is every fifteen minutes.

For sub-minute schedules add a sixth field **at the front** for seconds `(s m h dom mon dow)`, so every 30 seconds is `*/30 * * * * *`. Appending the seconds field at the end instead is the easy mistake, and croner reports it as `Syntax error, max steps for part is (7)`.

Each field name in the form's hint explains itself on hover:

| Field | Range |
| --- | --- |
| `s` | 0 to 59 (only in the six-field form) |
| `m` | 0 to 59 |
| `h` | 0 to 23 |
| `dom` | 1 to 31 |
| `mon` | 1 to 12, or JAN to DEC |
| `dow` | 0 to 7, or SUN to SAT. 0 and 7 are both Sunday. |

Under the field are shortcuts that fill it in for you:

| Control | Writes |
| --- | --- |
| **30s** | `*/30 * * * * *` |
| **15m** | `*/15 * * * *` |
| **1hr** | `0 * * * *` |
| **Daily at** + a time | `30 9 * * *` for 09:30 |

As the field changes, a green line below it shows when the expression next fires — `Next run: in 12h 58m · Sep 10, 2:45:00 PM`. An expression that does not parse shows the reason in amber instead, and is also rejected on save.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/crons` | List, with next run time and live-run state |
| POST | `/api/crons` | Create |
| GET, PUT, DELETE | `/api/crons/:id` | Read, update, delete |
| POST | `/api/crons/:id/run` | Trigger now (409 if already running) |
| POST | `/api/crons/:id/stop` | Kill the in-flight run (409 if not running) |
| GET | `/api/crons/:id/logs` | Run history, newest first |
| GET | `/api/crons/:id/logs/:file` | One log as JSON |
| GET | `/api/crons/:id/logs/:file/stream` | One log as an SSE stream |
| GET | `/api/events` | Activity stream |
| GET | `/api/config` | Storage paths and retention limit |
| GET | `/api/browse?path=` | Subdirectories matching a partial path, for the Working Directory field |
| GET | `/api/next-run?cron=` | Whether an expression parses, and when it next fires |
| GET | `/api/models` | Discovered models, plus whether discovery is running |
| POST | `/api/models/refresh` | Re-run discovery |

## Notes

- The server binds to localhost and has no authentication. A cron here runs an arbitrary prompt through Claude in a directory you choose, so don't expose it to a network you don't control.
- The directory autocomplete lets any client that can reach the server list directory names anywhere it can read. That is the same trust boundary as the rest of the app, which already runs prompts in any directory you name — another reason to keep it on localhost.
- Deleting a cron leaves its logs on disk. Remove `logs/<name>/` by hand if you want them gone.
- Renaming a cron moves its log folder, so history follows the new name.
