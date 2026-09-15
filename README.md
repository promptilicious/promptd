# Claude Conductor

Schedule Claude prompts and watch them run. A small Node.js server holds a set of crons, spawns `claude -p` on each one's schedule, and streams the output to a web page that updates as it happens. No database: every cron and every log line is a plain file under `~/.claude/claude-conductor`.

- Add, edit and delete crons in the browser, or by editing the JSON files directly — the folder is watched either way.
- Follow a run's output as it is produced, or read back any of the last 50 runs per cron.
- Stop a run in progress. The schedule stays armed for its next trigger.
- Pause every schedule for 15 minutes, an hour, 6 hours, or until the next restart.
- Hold a cron until your Claude usage resets, per limit, instead of firing it into a spent quota.
- Choose the model per cron, from whatever the installed CLI recognises.
- Every finished run records the model, runtime, tokens and cost that the CLI reported.
- Lifetime totals per cron — runs completed, what they cost, how long they took, and the average of each.

## Run it

Needs Node 18 or newer, and Claude Code installed and signed in — `claude --version` should answer.

```bash
npm install
npm start          # http://127.0.0.1:4321
npm run dev        # same, restarts on file changes
```

## Start at login (macOS)

macOS starts per-user background processes with **launchd**. Run this once:

```bash
./scripts/register-app-mac-os.sh
```

It finds your `node` and `claude`, runs `npm install` if `node_modules` is missing, writes the LaunchAgent plist with absolute paths, registers it, and waits until the server answers before reporting success. Output ends with the commands for restarting, stopping and removing it.

Overrides, if you need them:

| Variable | Default                  |                                                                                                              |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `PORT`   | `4321`                   | Port the server listens on                                                                                   |
| `HOST`   | `127.0.0.1`              | Bind address. `0.0.0.0` accepts connections from your network — read [Network access](#network-access) first |
| `LABEL`  | `local.claude-conductor` | launchd service name                                                                                         |
| `FORCE`  | unset                    | Replace an already-registered agent                                                                          |

```bash
PORT=5000 ./scripts/register-app-mac-os.sh     # a different port
HOST=0.0.0.0 ./scripts/register-app-mac-os.sh  # reachable from your network
FORCE=1 ./scripts/register-app-mac-os.sh       # re-register after moving the project
```

Run again without `FORCE` and it changes nothing, just prints how to restart, replace or remove what is already there.

### Network access

By default the server binds `127.0.0.1`, so only this Mac can reach it. To reach it from a phone or another computer on your LAN, register with `HOST=0.0.0.0`:

```bash
HOST=0.0.0.0 ./scripts/register-app-mac-os.sh
```

The address goes into the plist, so it survives restarts and every login. On success the script prints the LAN URL — `http://<this-mac-ip>:4321` — which is the address other devices use. Already registered? Add `FORCE=1` to replace the existing agent:

```bash
HOST=0.0.0.0 FORCE=1 ./scripts/register-app-mac-os.sh
```

To go back to this machine only, re-register with the default:

```bash
FORCE=1 ./scripts/register-app-mac-os.sh
```

> **⚠️ Warning — no password, no authentication.** Claude Conductor has no login, no accounts, and no access control of any kind. Once it is bound to `0.0.0.0`, anyone who can reach the port can add a cron, run an arbitrary Claude prompt in any directory this Mac can read, browse your filesystem through the directory autocomplete, and read every past run's output. It spends your Claude quota doing it.
>
> Protecting it is on you. Keep it on a network you control, and treat exposure as your risk to accept:
>
> - Never put it on a public IP, and never forward a router port to it. Nothing here is safe on the open internet.
> - On an untrusted network — cafés, hotels, shared offices, guest Wi-Fi — leave it on `127.0.0.1`.
> - Prefer a private overlay to opening the LAN: Tailscale or WireGuard gives you remote access without anyone else on the network being able to reach the port.
> - If you need it on a shared LAN, put access control in front of it — a reverse proxy with HTTP basic auth and TLS, or a firewall rule limiting the source addresses.
> - macOS may ask you to allow incoming connections for `node` the first time. That prompt is the firewall, not authentication.
>
> You accept the risk of unauthorized access when you change this setting.

### Doing it by hand

The script writes this; there is no need to do it yourself unless you want to change something it does not expose:

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
    <key>HOST</key><string>127.0.0.1</string>
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

Run that from the project directory, since it uses `$PWD`. Then register and start:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude-conductor.plist
```

That starts it now and at every login. Open http://127.0.0.1:4321.

Set `HOST` to `0.0.0.0` in that plist to accept connections from your network — read [Network access](#network-access) before you do. Editing the plist takes a `bootout` then `bootstrap`, not a `kickstart`.

### Start and stop

| Task                        | Command                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Start (and enable at login) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude-conductor.plist`                            |
| Stop (and disable at login) | `launchctl bootout gui/$(id -u)/local.claude-conductor`                                                           |
| Restart after changing code | `launchctl kickstart -k gui/$(id -u)/local.claude-conductor`                                                      |
| Is it running?              | `launchctl print gui/$(id -u)/local.claude-conductor \| grep -E "state =\|pid ="`                                 |
| Server log                  | `tail -f ~/Library/Logs/claude-conductor/server.log`                                                              |
| Remove entirely             | `launchctl bootout gui/$(id -u)/local.claude-conductor && rm ~/Library/LaunchAgents/local.claude-conductor.plist` |

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

## Pausing every cron

**Pause for…** sits to the left of **+ New cron** on the home page. Pick a length and every schedule is held at once:

| Option        | Held until                                     |
| ------------- | ---------------------------------------------- |
| 15 minutes    | 15 minutes from now                            |
| 1 hour        | an hour from now                               |
| 6 hours       | six hours from now                             |
| Until restart | the pause is cancelled, or the server restarts |

While paused, the dropdown is replaced by **Cancel pause**, which resumes immediately. Every status reads `Paused 15 minutes` (or whichever length you chose), and hovering one says when it lifts.

What a pause does and does not do:

1. **Every trigger is dropped, and says so.** The schedules stay registered, so a cron whose time comes round during the pause still produces a trigger, which is thrown away rather than run. Each one raises a toast naming the cron and the pause (`"Ticker" trigger dropped: all crons are paused 15 minutes`), and repeats add a count in brackets, and the header line counts them. A cron that fires often reuses its own toast and updates the count rather than stacking hundreds of them. The Next run column shows when the next trigger arrives and marks it `dropped`.
2. **A run already in flight is left alone.** It keeps its `running` badge and finishes normally; it picks up the paused badge once it is done.
3. **A drop is missed time, not queued time.** The count says how many runs this cron has now lost, not how many are waiting. Nothing is replayed when the pause lifts; the cron simply runs at its next trigger. Each pause counts from zero.
4. **Nothing new starts, by hand either.** **Run now** is disabled on the home page and the logs page, and says why on hover; `POST /api/crons/:id/run` answers 409. **Stop** is never disabled, so a run already going can always be ended.
5. **Deactivated crons stay `deactivated`.** A pause is not the cron's own `isActive` setting, and lifting the pause will not arm something you turned off.
6. **It is never written to disk.** A restart always comes back unpaused, with every active cron armed again — which is why `Until restart` means what it says.

When the time is up, or you cancel, the crons are re-read from disk and re-armed, so any edit made during the pause takes effect.

## Delaying a cron for usage

Each cron has a **Delay for usage** section on its form: four checkboxes, all off by default.

| Checkbox                | Holds the trigger while                                     |
| ----------------------- | ----------------------------------------------------------- |
| Session                 | the 5-hour session limit is at 100%                          |
| Weekly                  | the rolling 7-day limit, all models, is at 100%              |
| Fable                   | the Fable weekly limit is at 100%                            |
| Monthly Credits 90%     | more than 90% of the extra usage credits are spent           |

These are the same limits the header meters draw, matched on what a limit *is* rather than on its label, so nothing has to change here when the wording does. Tick none and the cron behaves exactly as it always has.

When a cron with at least one box ticked triggers, usage is read and every ticked limit is checked. If any is over its threshold the run does not start: the cron goes to `delayed`, and the trigger waits.

1. **The status reads `delayed`,** and hovering it names every limit it is waiting on, what each is at, when each resets, and the estimated start. The Next run column shows that estimate too.
2. **It starts on the first reading that shows the limit clear.** Waiting costs no extra API requests: the check reads the same cached numbers the header meters draw, and never asks the endpoint out of turn. That reading refreshes at most once every five minutes however many triggers are waiting, so a run can start up to five minutes after its limit actually resets. Getting the account rate limited is the worse outcome, and the endpoint is shared with every other Claude session on this machine.
3. **Only one run waits per cron.** Any trigger arriving while one waits is dropped, not queued, so a cron that sits out a long reset comes back and runs once rather than five times. The dropped trigger raises a toast like any other skipped one.
4. **Run now does not override the setting.** Pressing it on a blocked cron produces the same held trigger, not a run. It answers 202 with the delay rather than starting `claude`.
5. **Stop drops a held trigger.** While a cron is `delayed` the Run now button is a **Stop** button, and pressing it throws the waiting trigger away. The schedule is untouched, so the next trigger checks usage again like any other.

Four more things worth knowing:

- **A restart clears every wait.** Like a pause, held triggers live in memory only. The server comes back with nothing waiting, and the next trigger checks usage fresh.
- **Updates are never held up by one.** A delayed cron is not a running cron, so it does not count towards the runs an update waits to drain. Updates check, apply and restart on their own schedule regardless of what is waiting.
- **Extra credits are treated as monthly.** The endpoint reports no reset time for a spending cap, because it is not a rolling window. The cap is monthly, so the reset is local midnight on the first of the next month. That date is used for the delay estimate and shown in the header meter's own tooltip, which says it is monthly.
- **No reading means no delay.** If the CLI is signed out, or the usage lookup is failing, nothing is held back. A reading we do not have is not evidence that the account is out of usage, and holding every cron on that would be the worse failure.

A run that waited says so in its log header, above the prompt:

```
held       waited 43m 18s for Session
```

A pause outranks a delay. If usage clears while every schedule is paused, the trigger keeps waiting and goes when the pause lifts. Deactivating a cron throws away a scheduled trigger that is still waiting; a **Run now** that is waiting survives, because that one is your own press.

## Settings and self update

The **⚙ Settings** button at the right of the header opens a page for everything below. Changes save as you make them — there is no Save button to forget — and each one confirms with a toast.

`settings.json` sits in the storage root and is written with defaults the first time the server starts:

```json
{
  "selfUpdate": true,
  "updateCheckIntervalHours": 24,
  "lastUpdateCheckAt": null,
  "lastUpdateLaunchedAt": null,
  "lastUpdateFromCommit": null
}
```

The first two are yours to set, from the Settings page, by editing the file, or with `PUT /api/settings`. The `last*` fields are the server's bookkeeping, and are what make "once a day" hold across restarts. A file that will not parse is left alone and the defaults are used, so a bad edit cannot wedge the server.

The check runs on the interval either way. `selfUpdate` decides only whether what it finds gets applied: with it off, the server still fetches and compares, and an available update shows as an amber **Update available** badge in the header that links to this page. Nothing is pulled and no cron is paused until you press **Update now**.

With `selfUpdate` true, the server checks once a day whether the project checkout is behind its remote, and if so updates itself:

1. `git fetch origin main`, then compare `main` with `origin/main`.
2. If `main` is behind, hold every schedule — the same pause as above, shown as `Paused for update` with no dropdown and no **Cancel pause**, because the restart is already committed to.
3. Wait for any run still in flight, re-checking every 10 seconds.
4. Once nothing is running, spawn `scripts/self-update.sh` **detached**, so it outlives the server it is about to restart.
5. That script re-checks everything, runs `git pull --ff-only origin main`, runs `npm install` if `package-lock.json` moved, and restarts the service with `launchctl kickstart -k`.

Steps 2 and 3 exist because a restart does not wait for a run. A run's output is a pipe to the server, so when the server goes down the `claude` process dies of `EPIPE` at its next write — mid-task, with no footer in its log and no last-run recorded. Draining first means an update never lands on top of live work.

Two ways out if the restart never comes, so a pause can't strand the crons:

- The update script exits without restarting — a dirty tree, a failed pull, no launchd agent to kick — and the schedules resume 5 seconds later.
- A run never ends. After 4 hours the wait is abandoned, the schedules resume, and the update is left for the next check.

Everything the updater does is appended to `logs/update.log`. The check itself is also available on demand at `GET /api/update/check`, which only reads — it never pulls.

Because an update pauses every cron until it finishes, a trigger due during one is missed rather than queued. That is the trade in leaving `selfUpdate` on, and the reason to turn it off if your schedules are tight: the badge still tells you an update is waiting, and you pick the moment.

### Checking and updating by hand

The Settings page runs a check as soon as it opens and says what it found:

| Shown                                             | Meaning                   |
| ------------------------------------------------- | ------------------------- |
| `Update available: 2 commits behind origin/main.` | **Update now** is enabled |
| `Up to date with origin/main.`                    | Nothing to do             |
| `No update: <reason>`                             | See the table below       |

**Check for updates** re-runs it. **Update now** applies a pending update immediately and works whether or not `selfUpdate` is on — that is the point of it: turn self update off and update on your own schedule, from the page. Both buttons use the same code path as the daily check, so there is no second behaviour to keep in step.

Update now reports the wait rather than guessing at a reload time:

1. `Waiting for 1 cron to finish executing before restarting…` while runs drain, then `All crons idle. Waiting for the server to restart…`.
2. The header badge turns to `live - refresh window` when this page notices the server came back on a different commit.
3. The page then counts down from 5 seconds and reloads itself.

If the update does not proceed, the message says so and **Update now** becomes clickable again rather than counting down to nothing.

### When it declines to update

The checker refuses rather than guesses, and says why in the server log and in `/api/update/check`:

| Reason                                        | Meaning                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| `not a git repository`                        | The project folder is not a checkout                         |
| `on branch X, not main`                       | Only `main` is updated, and only when it is checked out      |
| `N uncommitted change(s) in the working tree` | Your work is never touched                                   |
| `diverged: N ahead, M behind`                 | Local commits that the remote does not have; resolve by hand |
| `git fetch failed: …`                         | No network, or credentials that need a prompt                |
| `already up to date`                          | Nothing to do                                                |

`git pull --ff-only` means a merge is never attempted. All of these are re-checked inside the detached script too, since the working tree could have changed between the decision and the pull.

### The restart needs the launchd agent

Only launchd can bring the server back after it stops, so the updater restarts the service registered under `local.claude-conductor` (override with `CONDUCTOR_LAUNCHD_LABEL`). See [Start at login](#start-at-login-macos).

If no such agent is registered — you are running `npm start` in a terminal, say — the update is still pulled, but the running server is left alone and the log says so:

```
[…] no launchd agent named local.claude-conductor is registered
[…] the new code is on disk but the running server is still the old one — restart it yourself
```

Killing a server that nothing would restart would be worse than leaving it on old code.

## Storage layout

```
~/.claude/claude-conductor/
├── crons/
│   └── <uuid>.json                 # one file per cron
├── logs/
│   ├── <Cron Name>/
│   │   └── 2026-09-10T06-11-12.789Z.txt   # one file per run, newest 50 kept
│   └── update.log                  # appended by the self updater
└── settings.json                   # app settings, written with defaults on first run
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
  "effort": "",
  "usageDelay": { "session": true, "weekly": false, "fable": false, "credits": true },
  "prompt": "Write a two line summary of today.",
  "isActive": true,
  "createdAt": "2026-09-10T06:11:04.188Z",
  "updatedAt": "2026-09-10T06:11:04.188Z",
  "lastRunAt": "2026-09-10T06:11:12.789Z",
  "lastRunStatus": "succeeded",
  "lastRunLog": "2026-09-10T06-11-12.789Z.txt",
  "lastRunDurationSeconds": 3.3,
  "lifetimeRuns": 7,
  "lifetimeCostUsd": 18.6535,
  "lifetimeRuntimeSeconds": 3161.5
}
```

Files are safe to edit or delete by hand — the server polls the folder and picks changes up within a few seconds. See [Editing files by hand](#editing-files-by-hand).

## Editing files by hand

The `crons` folder is polled every 3 seconds. Changes made outside the app are applied to the scheduler and announced in the UI as a toast:

| On disk              | Effect                       | Toast                                                             |
| -------------------- | ---------------------------- | ----------------------------------------------------------------- |
| New `.json` file     | Scheduled                    | `Cron file added: "X" — now scheduled`                            |
| File edited          | Rescheduled                  | `Cron file updated: "X" — rescheduled`                            |
| File deleted         | Unscheduled                  | `Cron file deleted: "X" — unscheduled`                            |
| File is invalid JSON | Keeps its last good schedule | `x.json is not valid JSON — still running its last saved version` |
| Invalid file fixed   | Rescheduled                  | `Cron file fixed: "X" — rescheduled`                              |

Set `WATCH_INTERVAL_MS` to change the interval, or `0` to switch the watcher off.

Two things the watcher deliberately stays quiet about, so you don't get told twice about your own actions:

- **Changes made through the UI or API.** Those already reload the scheduler and show their own toast.
- **Run bookkeeping.** Every run rewrites `lastRunAt`, `lastRunStatus`, `lastRunLog`, `lastRunDurationSeconds` and the three `lifetime*` totals in the cron file. Only the config fields (`name`, `description`, `cron`, `workingDirectory`, `model`, `effort`, `usageDelay`, `prompt`, `isActive`) count as a change.

A file caught mid-write is treated as unchanged rather than deleted, so a save from an editor that truncates before writing does not cause a delete-then-add flicker.

## How a run works

1. The schedule fires, or you press **Run now**.
2. If the cron has [Delay for usage](#delaying-a-cron-for-usage) boxes ticked, usage is read; the run waits here while any ticked limit is spent.
3. The server spawns `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages` in the cron's working directory.
4. The assistant's text is pulled out of the event stream and written to `logs/<name>/<start time>.txt` as it arrives, so the log reads as plain output and can be tailed mid-run. stderr goes in verbatim, as does any stdout line that is not JSON (a CLI warning, say).
5. On exit, the run's statistics block is written, then a footer records the outcome (`succeeded` / `failed` / `stopped`, duration, exit code). Logs beyond the newest 50 for that cron are deleted.

A cron never runs twice at once. If a schedule fires while the previous run is still going, that trigger is skipped and the UI says so.

## Stopping a run

While a run is in flight, that cron's **Run now** button becomes **Stop**. Stopping signals the whole process group, so anything `claude` spawned goes with it: `SIGTERM` first, then `SIGKILL` five seconds later if it is still alive. Both are written into the log:

```
--- stop requested by user at 2026-09-10T06:41:54.168Z ---
--- still alive 5s after SIGTERM, sending SIGKILL ---
--- stopped after 6.2s (killed by user, signal SIGKILL) ---
```

The run's outcome is recorded as `stopped`, distinct from `succeeded` and `failed`. The schedule is left alone: an active cron stays armed and fires again at its next trigger, so stopping one run never disables the cron. Use the Is Active checkbox for that.

**Stop** is also what the button becomes while a trigger is [held for usage](#delaying-a-cron-for-usage). Nothing is running in that case, so there is no process to signal and nothing to log — pressing it throws the waiting trigger away and the cron goes back to `armed`.

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

## Lifetime totals

The logs page carries three totals under the cron's name: runs completed, total cost with the average per run, and total runtime with the average per run.

```
Logs · Nightly Digest
9 runs kept, newest first. Oldest are pruned past 50.

  7                 $18.65             52m 42s
  runs completed    total cost         total runtime
  lifetime          $2.6648 per run    7m 32s per run
```

They live on the cron file, not in the logs, so they keep counting after the logs they came from are pruned:

```json
"lifetimeRuns": 7,
"lifetimeCostUsd": 18.6535,
"lifetimeRuntimeSeconds": 3161.5
```

**Only successful runs count.** A run that failed or was stopped is left out of all three, so the averages are the cost and length of a run that worked. That is also why the run count here is usually lower than the number of logs listed below it.

**A cron with no totals yet is read off its own logs**, the first time the logs page is opened. Each log's footer says how it ended and how long it took, and its statistics block says what it cost; only the last 4 KB of each file is read, so a folder of 50 long runs is scanned in milliseconds rather than megabytes. A run still being written has no footer yet and is skipped. It is counted when it finishes, which is what stops it being counted twice.

That first pass is a floor, not a true lifetime figure: runs pruned before it ran are gone, so a busy cron starts from its newest 50. Everything after it is counted exactly once, as it finishes, and grows past 50 from there. The cost a run reports is the CLI's own accounting. A run that died before reporting one logs `Cost: unknown`, adding nothing to the total while still counting as a run.

To recount from the logs, delete the three fields from the cron's JSON file; the next visit to its logs page fills them in again.

## Subscription usage

The header carries one small meter per limit on the account the Claude CLI is signed in as — the 5-hour session, the rolling 7-day limit, any model-scoped weekly limit, and extra usage credits when they are turned on. Hovering one gives the full name, the percentage, and when it resets in local time. Credits are a monthly spending cap rather than a rolling window, and their tooltip says so: they reset on the 1st of each month.

The numbers come from the same place the CLI's own `/usage` view reads them: the OAuth usage endpoint, asked with the access token the CLI already stores. Nothing is spawned and nothing is estimated from run logs. Reading that token is the only thing this does with it — it is never logged, never written anywhere, and never sent on to anything else.

Three consequences worth knowing:

- **The reading is up to five minutes old.** Every open tab polls `/api/health`, and every poll is answered from the last lookup, so the endpoint is asked at most once every five minutes no matter how many tabs are open. A page refresh redraws from that same reading rather than triggering a lookup of its own. The reading is also kept in `usage-cache.json`, so a restart or a self-update redraws the meters immediately.
- **A failed lookup keeps the last numbers.** The endpoint rate-limits, and several Claude sessions on one machine share that limit. When a refresh fails the meters dim and their tooltip says when they were last read and why the refresh is waiting, rather than disappearing. Retries back off from five minutes, doubling to an hour, and a `Retry-After` header wins when it asks for longer.
- **Signed out means no meters, not an error.** If the CLI is not signed in, or its login has expired, the meters disappear and `usage.reason` on `/api/health` says which. Expired logins are left for the CLI to refresh: doing it here would rotate the refresh token underneath it.

A cron can also be told to wait on any of these limits rather than run into one; see [Delaying a cron for usage](#delaying-a-cron-for-usage).

Amber and red are the API's own severity for a limit, not a threshold picked here, so they change when the CLI's usage view would change. The endpoint also reports a long tail of unreleased limit types; the server reads its normalized `limits` array instead, which means a limit added to the plan later shows up without a change to this code.

## Real-time updates

Two Server-Sent Event streams, no polling loops in the UI:

- `GET /api/events` — cron changes, run started, run stopping, run finished, trigger skipped, trigger dropped by a pause, trigger held for usage, trigger released. The home page redraws when one arrives.
- `GET /api/crons/:id/logs/:file/stream` — one log file: everything written so far, then each new chunk. Closes itself with a `done` event when the run ends.

## Configuration

| Variable                  | Default                         | Purpose                                                                                                                                          |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                    | `4321`                          | HTTP port                                                                                                                                        |
| `HOST`                    | `127.0.0.1`                     | Bind address. Localhost only by default; `0.0.0.0` accepts connections from your network, with the caveats in [Network access](#network-access). |
| `CONDUCTOR_HOME`          | `~/.claude/claude-conductor`    | Storage root                                                                                                                                     |
| `CLAUDE_BIN`              | `claude`                        | Binary to spawn. Set an absolute path if `claude` is not on the server's `PATH`.                                                                 |
| `WATCH_INTERVAL_MS`       | `3000`                          | How often the crons folder is polled for outside changes. `0` disables it.                                                                       |
| `CONDUCTOR_LAUNCHD_LABEL` | `local.claude-conductor`        | The launchd service the updater restarts                                                                                                         |
| `CONDUCTOR_PROJECT_DIR`   | the checkout this code lives in | Which repository the update check looks at                                                                                                       |

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

| Stored           | Runs in                                                  |
| ---------------- | -------------------------------------------------------- |
| `~/code/project` | `/Users/you/code/project`                                |
| `~` or blank     | `/Users/you`                                             |
| `Documents`      | `/Users/you/Documents` (relative means relative to home) |
| `/tmp`           | `/tmp`                                                   |

Each log's header records the resolved absolute path, so there is never a question about where a run happened.

## Cron expressions

Five fields `(m h dom mon dow)`, evaluated in the server's local timezone. `0 9 * * *` is 9am daily; `*/15 * * * *` is every fifteen minutes.

For sub-minute schedules add a sixth field **at the front** for seconds `(s m h dom mon dow)`, so every 30 seconds is `*/30 * * * * *`. Appending the seconds field at the end instead is the easy mistake, and croner reports it as `Syntax error, max steps for part is (7)`.

Each field name in the form's hint explains itself on hover:

| Field | Range                                           |
| ----- | ----------------------------------------------- |
| `s`   | 0 to 59 (only in the six-field form)            |
| `m`   | 0 to 59                                         |
| `h`   | 0 to 23                                         |
| `dom` | 1 to 31                                         |
| `mon` | 1 to 12, or JAN to DEC                          |
| `dow` | 0 to 7, or SUN to SAT. 0 and 7 are both Sunday. |

Under the field are shortcuts that fill it in for you:

| Control               | Writes                 |
| --------------------- | ---------------------- |
| **30s**               | `*/30 * * * * *`       |
| **15m**               | `*/15 * * * *`         |
| **1hr**               | `0 * * * *`            |
| **Daily at** + a time | `30 9 * * *` for 09:30 |

As the field changes, a green line below it shows when the expression next fires — `Next run: in 12h 58m · Sep 10, 2:45:00 PM`. An expression that does not parse shows the reason in amber instead, and is also rejected on save.

## API

| Method           | Path                               | Purpose                                                                                                                                                                        |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET              | `/api/crons`                       | List, with next run time and live-run state                                                                                                                                    |
| POST             | `/api/crons`                       | Create                                                                                                                                                                         |
| GET, PUT, DELETE | `/api/crons/:id`                   | Read, update, delete                                                                                                                                                           |
| POST             | `/api/crons/:id/run`               | Trigger now. 409 if already running, if crons are paused, or if a trigger is already waiting on usage. 202 with `delayed` instead of a run when a watched limit is spent        |
| POST             | `/api/crons/:id/stop`              | Kill the in-flight run, or drop a trigger waiting on usage (409 if neither)                                                                                                    |
| GET              | `/api/crons/:id/logs`              | Run history newest first, plus the cron's lifetime totals and per-run averages                                                                                                 |
| GET              | `/api/crons/:id/logs/:file`        | One log as JSON                                                                                                                                                                |
| GET              | `/api/crons/:id/logs/:file/stream` | One log as an SSE stream                                                                                                                                                       |
| GET              | `/api/events`                      | Activity stream                                                                                                                                                                |
| GET              | `/api/config`                      | Storage paths, retention limit, effort levels, and the usage-delay categories                                                                                                  |
| GET              | `/api/health`                      | Liveness, how many crons are scheduled, whether they are paused, how many triggers are held for usage, `updateAvailable` with the commits behind, and `usage` with a percentage and reset time per subscription limit |
| GET, PUT         | `/api/settings`                    | Read settings; write `selfUpdate` and `updateCheckIntervalHours`                                                                                                               |
| GET              | `/api/pause`                       | Pause state, the offered lengths, how many runs are still in flight, and how many triggers this pause has dropped                                                               |
| POST             | `/api/pause`                       | Hold every schedule. Body `{"option":"15m"\|"1h"\|"6h"\|"restart"}`                                                                                                            |
| DELETE           | `/api/pause`                       | Resume (409 if not paused, or if the pause belongs to an update)                                                                                                               |
| GET              | `/api/update/check`                | Whether `main` is behind. Read-only, never pulls                                                                                                                               |
| POST             | `/api/update/run`                  | Apply a pending update now. 202 with the updater's pid, or `waiting: true` and a null pid while runs drain. 409 and the reason if there is nothing to do. Ignores `selfUpdate` |
| GET              | `/api/browse?path=`                | Subdirectories matching a partial path, for the Working Directory field                                                                                                        |
| GET              | `/api/next-run?cron=`              | Whether an expression parses, and when it next fires                                                                                                                           |
| GET              | `/api/models`                      | Discovered models, plus whether discovery is running                                                                                                                           |
| POST             | `/api/models/refresh`              | Re-run discovery                                                                                                                                                               |

## Notes

- The server binds to localhost and has no authentication. A cron here runs an arbitrary prompt through Claude in a directory you choose, so don't expose it to a network you don't control. Widening the bind address is possible and documented in [Network access](#network-access); the risk of doing so is yours.
- The directory autocomplete lets any client that can reach the server list directory names anywhere it can read. That is the same trust boundary as the rest of the app, which already runs prompts in any directory you name — another reason to keep it on localhost.
- A pause lives in memory only. Restarting the server clears it, whichever length was chosen. So does a trigger held for usage: a restart comes back with nothing waiting.
- The **Update available** badge reflects the last check, so it can lag a push by up to `updateCheckIntervalHours`. **Check for updates** on the Settings page refreshes it at once.
- Deleting a cron leaves its logs on disk. Remove `logs/<name>/` by hand if you want them gone — and with the cron file gone, its lifetime totals go with it.
- Renaming a cron carries its lifetime totals, because they live on the cron file rather than being recounted from the logs.
- Renaming a cron moves its log folder, so history follows the new name.
