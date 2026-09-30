# moodle-task-fetcher

Fetches your open assignments from a Moodle server and shows them in the
terminal, and (on macOS) syncs them into a Reminders list so you get a
notification and never have to remember to check Moodle.

See [`moodle-task-fetcher-brief.md`](./moodle-task-fetcher-brief.md) for the
original project brief and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)
for the design rationale, including why this doesn't use RSS (Moodle has no
per-user task RSS feed) and instead uses the Web Services REST API, with an
iCal calendar export as a fallback.

## Requirements

- Node.js >= 20
- macOS, for the Reminders sync (everything else runs fine on Linux too)

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `MOODLE_URL` in `.env`, then mint a web service token by logging in
once with your real Moodle credentials:

```bash
node bin/moodle-tasks.js --login
```

This POSTs your username/password to Moodle's `/login/token.php` a single
time, saves the resulting **token** (not your password) into `.env`, and
looks up your user id automatically. Check that it worked:

```bash
node bin/moodle-tasks.js --doctor
```

## Usage

```bash
# Fetch + show tasks in the terminal + sync new/changed ones to Reminders
node bin/moodle-tasks.js

# Just look, don't touch Reminders
node bin/moodle-tasks.js --no-sync

# See what would change in Reminders without changing anything
node bin/moodle-tasks.js --dry-run

# Machine-readable output (for piping into jq etc. - logs go to stderr)
node bin/moodle-tasks.js --json

# Only one course
node bin/moodle-tasks.js --course Mathematik

# Look further/less far ahead than the default 30 days
node bin/moodle-tasks.js --days 14
```

Full flag list: `node bin/moodle-tasks.js --help`.

### If the web service isn't available to you

Some Moodle admins restrict which functions a student token can call. Run
`--doctor` to check - it tells you explicitly whether
`core_calendar_get_action_events_by_timesort` (the call this tool uses) is
exposed to your account. If it isn't, use the calendar export fallback
instead:

1. In Moodle: **Kalender → Kalender exportieren → Ereignisse zum Export
   auswählen: Alles → Exportieren** → copy the **"Interne Kalender-URL"**.
2. Paste it into `.env` as `MOODLE_ICAL_URL`.
3. Run with `--source ical` (or just leave `MOODLE_TOKEN` unset - it's used
   automatically when there's no token).

The tradeoff: the calendar export doesn't reliably include the course name
per event, so course names shown via this path are a best-effort guess
(flagged as `courseGuessed: true` in `--json` output).

## Automatic check-off

When you hand in an assignment, its reminder is ticked off on the next run
(manual, or the daily 08:00 launchd run). A synced task that has vanished
from Moodle's open-task feed is checked with `mod_assign_get_submission_status`;
only if Moodle confirms it was submitted is the reminder completed. If you
revert the submission and the task reappears, the reminder is reopened.
Needs the web service source (not iCal); `--doctor` shows whether the two
required functions are available, `--dry-run` shows what would be ticked off.

## Smarter reminders

Every synced reminder gets:

- an **alarm** `ALARM_LEAD_HOURS` (default 24) before it is due, so macOS
  actually notifies you (overdue and undated tasks get none),
- a **priority**: high when overdue or due within `SOON_DAYS`, medium within
  a week, none otherwise - it is refreshed as the deadline approaches,
- a **course tag** in the title, e.g. `[4AHIF Mathematik] Hausaufgabe 5`
  (turn off with `COURSE_PREFIX=0`; switching it updates existing
  reminders once).

After a real sync you also get one **digest notification**
("3 offen, 1 überfällig · Nächste: HÜ 5 (in 2 Tagen)"); disable it with
`DIGEST=0` or `--no-digest`.

Hide courses or tasks you don't care about with `IGNORE_COURSES` and
`IGNORE_TITLES` (comma-separated substrings, case-insensitive). Ignored tasks
are never synced and never mistaken for handed-in ones.

`node bin/moodle-tasks.js --status` shows how many tasks are tracked, open,
ticked off and deleted, and when the last sync happened.

## Daily automation

```bash
npm run schedule:install
```

Installs a `launchd` agent that runs this once a day at 08:00, survives
logout/reboot, and logs to `~/Library/Logs/moodle-task-fetcher/`. Uninstall
command is printed after install.

`npm run schedule` (node-cron) is kept as a portable alternative for Linux
or quick testing, but only runs while that process stays alive - it does
**not** survive closing the terminal, so it isn't the recommended path on
macOS.

## macOS permissions (Reminders)

The first time this tool creates or updates a reminder, macOS will ask you
to authorize the automation. If you accidentally deny it, re-enable it at:

**Systemeinstellungen → Datenschutz & Sicherheit → Automatisierung →
Terminal (or whatever app you ran this from) → Erinnerungen**

The tool never touches Reminders on non-macOS systems - it just prints a
one-line notice and skips that step.

## Security

- `.env` (your token) and `state.json` (sync bookkeeping) are gitignored -
  never commit them.
- Every printed/logged error redacts the token to something like
  `7358…6802`.
- Web service tokens don't expire by default. To revoke one (e.g. if it
  leaks), go to Moodle **Sicherheitsschlüssel** in your profile, or ask an
  admin, and run `--login` again to mint a fresh one.

## Development

```bash
npm test          # runs the unit test suite (node:test, no framework)
```

Test coverage: task status/sort/dedupe logic, the Reminders sync planner's
create/update/skip/deleted-by-user branches, the REST client's retry and
error-mapping behavior, the action-events normalizer (with pagination), and
the iCal fallback parser (folded lines, CRLF, escapes, all-day events,
TZID). The Reminders/AppleScript bridge itself isn't unit tested (it needs
the real app) - use `--dry-run` to check its plan without side effects.

## Project layout

```
bin/moodle-tasks.js        entrypoint
src/cli.js                 commander wiring, exit codes
src/config.js              .env loading/validation, secret redaction
src/moodle/client.js       Web Services REST transport (timeout/retry/errors)
src/moodle/auth.js         --login: mint a token via /login/token.php
src/moodle/tasks.js        fetch + normalize core_calendar_get_action_events_by_timesort
src/moodle/submissions.js  resolve event -> assignment, check submission status
src/moodle/ical.js         fallback: parse a Moodle calendar export URL
src/model/task.js          the shared Task shape, status buckets, sorting
src/render/terminal.js     boxed terminal output
src/render/json.js         --json output
src/reminders/jxa.js       JXA bridge to Reminders.app (list/create/update)
src/reminders/sync.js      pure create/update/skip/deleted-by-user planner
src/reminders/policy.js    alarm time, priority and title prefix rules
src/state/store.js         atomic JSON state file for dedupe tracking
src/notify.js              macOS notification banner
src/digest.js              one-line summary for the digest notification
src/status.js              --status summary of the state file
src/schedule/cron.js       node-cron fallback scheduler
launchd/                   recommended daily-run scheduling
test/                      node:test unit tests + fixtures
```
