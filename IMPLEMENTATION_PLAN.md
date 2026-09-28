# Implementation Plan — Moodle Task Fetcher

> Planning doc for the implementer (Sonnet). Read this fully before writing code.
> Source brief: `moodle-task-fetcher-brief.md`.

---

## 0. Findings that change the brief (verified against the live server)

All four probes below were run against `https://edufs.edu.htl-leonding.ac.at/moodle` on 2026-09-28.

| Assumption in brief | Reality | Consequence |
|---|---|---|
| `/rss/user.php?id=…&token=…` is the user feed | **HTTP 404** — this endpoint does not exist in Moodle. There is no per-user "my tasks" RSS feed in any Moodle version. | The RSS approach cannot work. Do **not** build `rss-parser` code. |
| `/rss/course.php?id=…` | Same — not a Moodle route. Moodle's only RSS route is `/rss/file.php/<contextid>/<userid>/<token>/<component>/<args>/rss.xml`, and it serves **forum posts / blogs only**, never assignment deadlines. | Dead end for deadlines. |
| The given token authenticates the feed | Token is **31 hex chars** and is rejected by every scheme: web service → `invalidtoken`, calendar iCal → `Invalid authentication`. (Moodle ws tokens are 32 hex, calendar authtokens are 40 hex — so it is malformed/truncated as well as wrong.) | A new token must be minted. Treat the one in the brief as invalid **and leaked** (see §8). |
| — | `/webservice/rest/server.php` **is enabled** and returns structured JSON errors. `/login/token.php` with `service=moodle_mobile_app` returns `invalidlogin` (not `servicenotavailable`), which confirms the **mobile web service is switched on** and only real credentials are missing. | ✅ This is the data source to build on. |

**Decision: build on the Moodle Web Services REST API, with the iCal calendar export as a no-API fallback. Drop RSS entirely.**

Rationale: the web service returns exactly the domain object the brief wants — "things that need action, with a due date" — as structured JSON (`name`, `timesort`, `course.fullname`, `url`, `overdue`), including assignments and quizzes. RSS would at best give forum announcements with no due dates.

---

## 1. Data sources

### Primary — Web Services REST (`src/moodle/client.js`)
All calls: `POST /webservice/rest/server.php` with `wstoken`, `wsfunction`, `moodlewsrestformat=json`.

1. `core_webservice_get_site_info` → validates the token, yields `userid`, `sitename`, `functions[]`. Run once at startup; used by `--doctor`.
2. `core_calendar_get_action_events_by_timesort` → **the main call.** Params: `timesortfrom` (now − 30d, to catch overdue), `timesortto` (now + `--days`, default 30d), `limitnum=50`. Returns `events[]` with `id`, `name`, `timesort` (unix), `overdue` (bool), `url`, `activityname` (`assign`/`quiz`), `course.fullname`, `description`.
3. `core_enrol_get_users_courses` (userid) → only if a course name is missing from an event; also powers `--course <filter>`.

Paginate/guard: if `events.length === limitnum`, re-request with a later `timesortfrom` until exhausted.

### Fallback — iCal export (`src/moodle/ical.js`)
`GET /calendar/export_execute.php?userid=<id>&authtoken=<40-hex>&preset_what=all&preset_time=recentupcoming`
The user copies this URL from **Moodle → Kalender → Kalender exportieren**. Parse VEVENTs (`SUMMARY`, `DTSTART`, `URL`, `CATEGORIES`, `UID`). Course name is only inside `SUMMARY`/`DESCRIPTION` here, so parse it best-effort and mark `courseGuessed: true`.

Selected at runtime by which env vars are present; `--source ws|ical` forces one.

---

## 2. Tech stack

- **Node.js ESM**, `"type": "module"`, engines `>=20`. Node 26 is installed → global `fetch`, `node:test`, `AbortSignal.timeout` are all built in.
- **Dependencies (4, deliberately lean):** `dotenv`, `chalk`, `cli-table3`, `commander`.
  - No `axios`/`node-fetch` — global fetch covers it.
  - No `rss-parser` — see §0.
  - No `node-ical` — the fallback parses a handful of VEVENT fields; a ~60-line parser beats a dependency, and it avoids `node-ical`'s timezone quirks. (Reassess only if RRULEs show up in the real feed.)
  - `node-cron` **only** if `npm run schedule` is kept; prefer launchd (§7).

---

## 3. Module layout

```
bin/moodle-tasks.js        # shebang, thin wrapper → src/cli.js
src/cli.js                 # commander wiring, exit codes, top-level error handling
src/config.js              # dotenv load, validate, redact() for logs
src/moodle/client.js       # REST transport: timeout, retry, Moodle error → typed Error
src/moodle/auth.js         # POST /login/token.php → mint token (--login)
src/moodle/tasks.js        # calendar action events → Task[]
src/moodle/ical.js         # fallback: iCal → Task[]
src/model/task.js          # Task shape, stableId(), status(), sort, dedupe
src/render/terminal.js     # the boxed output from the brief
src/render/json.js         # --json
src/reminders/sync.js      # diff Task[] vs state → create/update plan
src/reminders/jxa.js       # osascript -l JavaScript bridge (see §5)
src/state/store.js         # ~/.moodle-task-fetcher/state.json
src/notify.js              # display notification
test/                      # node:test + fixtures/
```

### `Task` model (single normalized shape both sources produce)
```js
{ id, source, title, course, description, url, due /* Date|null */, overdue, raw }
```
- `id` = `${source}:${eventId}` when the API gives an id, else `sha1(title|course|dueISO)`. This is the dedupe key and it must be stable across runs — everything in §6 depends on it.

### Status (`src/model/task.js`)
`overdue` (due < now) → `soon` (due ≤ now + 3d) → `later`. Threshold from `SOON_DAYS`, default 3. Tasks with `due === null` → bucket `undated`, listed last (the brief's mockup has no such bucket; add it rather than dropping data).
Sort: by `due` ascending, `null` last, tie-break on title.

---

## 4. CLI surface

```
moodle-tasks                     # fetch + render + sync reminders (default)
  --no-sync                      # render only
  --sync-reminders               # explicit sync (brief compat)
  --dry-run                      # print the reminder plan, touch nothing
  --json                         # machine output to stdout, logs to stderr
  --days <n>        (30)         # lookahead window
  --course <substr>              # filter by course name
  --source <ws|ical>             # force a source
  --login                        # prompt user+password → mint & save ws token
  --doctor                       # connectivity/token/permission diagnostics
  --no-color                     # also honour NO_COLOR / non-TTY
```
Exit codes: `0` ok · `1` unexpected · `2` config/auth problem · `3` network/server unreachable. (Matters for launchd/cron alerting.)

`--login` reads the password via a no-echo prompt (`readline` with `terminal:false` + raw mode), never via argv, and writes `MOODLE_TOKEN` into `.env` with mode `0600`.

---

## 5. Apple Reminders integration — do it differently than the brief

The brief's snippet has three real defects; fix all of them:

1. **Shell/AppleScript injection & breakage.** `exec("osascript -e '" + script + "'")` breaks on any apostrophe or `"` in a German task title (`Schüler's…`, quoted titles) and is an injection vector for feed content. → Use `execFile('osascript', ['-l','JavaScript','-'], …)`, feed the script on **stdin**, and pass the data as a **single JSON argument** (`on run argv` / JXA `run(argv)`). Never string-interpolate feed data into a script.
2. **Locale-dependent dates.** `date "28.09.2026"` is parsed against the user's system locale and silently misreads or throws. → In JXA, construct dates from an **epoch milliseconds number**: `new Date(ms)` is passed straight to `reminder.dueDate`.
3. **List creation.** The brief assumes the list exists. → `if (!app.lists.byName(name).exists()) app.lists.push(app.List({name}))`, on the default account.

`src/reminders/jxa.js` exposes one primitive per operation, each a separate `osascript` invocation taking JSON on stdin and printing JSON on stdout:
- `listExists(name)` / `createList(name)`
- `createReminder({list,title,body,dueMs,url})` → returns the new reminder's `id`
- `updateReminder({id,dueMs,title,body})`
- `findReminderIds(list)` → for reconciling state against reality
- `completedIds(list)` → enables the brief's optional reverse sync (report only; do **not** write back to Moodle — the web service has no "mark done" for assignments).

Do **not** call `activate` (the brief does) — it steals focus on every run. Use `src/notify.js` instead.

**Guards:** `process.platform !== 'darwin'` → skip with a single warning, never fail the run. First run triggers the macOS Automation (TCC) consent dialog; if `osascript` exits with `-1743`/`errAEEventNotPermitted`, print the exact path *System Settings → Privacy & Security → Automation → Terminal → Reminders* rather than a raw stack trace.

---

## 6. Dedupe & state (`src/state/store.js`)

`~/.moodle-task-fetcher/state.json`, written atomically (tmp file + `rename`):
```json
{ "version": 1, "tasks": { "<taskId>": { "reminderId": "x-apple-…", "dueMs": 0, "hash": "…", "syncedAt": "…" } } }
```
Sync algorithm (`src/reminders/sync.js`, pure function → `{create[],update[],skip[],orphaned[]}` so it is unit-testable):
- unknown `taskId` → **create**
- known and `hash` unchanged → **skip**
- known and deadline/title changed → **update** the existing reminder (the brief only ever creates, which duplicates a task whenever a teacher moves a deadline)
- known but `reminderId` no longer in `findReminderIds()` → user deleted it deliberately → **do not recreate**; mark `deletedByUser` and keep skipping it
- tasks that vanished from the feed → leave the reminder alone, drop nothing from state for 30 days

---

## 7. Scheduling

Ship **launchd** as the recommended path (`launchd/com.daryan.moodle-tasks.plist`, `StartCalendarInterval` 08:00, `StandardErrorPath` to a log) plus a `npm run schedule:install` that `launchctl bootstrap`s it. Reason: `node-cron` needs a process to stay alive and dies on logout/reboot, which defeats a daily reminder. Keep a `node-cron` mode behind `npm run schedule` for the Linux/portability story the brief mentions.

---

## 8. Security

- `.gitignore`: `.env`, `state.json`, `*.log`, `node_modules`. Commit `.env.example` only.
- `config.redact(str)` scrubs the token from every error/log line; `--doctor` prints `7358…802`-style masks only.
- **Action item for the user:** `moodle-task-fetcher-brief.md` contains a (now known-invalid) token and a user id. Scrub those two lines before the repo goes public on GitHub — it is a portfolio repo, and a reviewer finding a pasted credential reads badly even when it is dead. The plan assumes this scrub happens before first push.
- Web service tokens do not expire by default → note in README how to revoke under *Sicherheitsschlüssel*.

---

## 9. Error handling

- `fetch` with `AbortSignal.timeout(15000)`, 3 attempts, backoff 0.5s/2s, retry only on network errors + HTTP 5xx/429.
- Map Moodle `errorcode` → actionable message: `invalidtoken` → "run `moodle-tasks --login`"; `accessexception` → "token lacks this capability"; `servicenotavailable` → "mobile service disabled by admin, use `--source ical`".
- HTML response where JSON was expected (login redirect / maintenance page) → its own error, not a `JSON.parse` crash.

---

## 10. Testing (`node:test`, no framework)

- `test/model.test.js` — status bucketing across the 3d boundary, null dues, sort stability, `stableId` determinism.
- `test/sync.test.js` — the six branches in §6 against a fake store.
- `test/ical.test.js` — fixture with umlauts, CRLF, folded lines, `DTSTART;TZID=`, an all-day event.
- `test/tasks.test.js` — fixture of a real `core_calendar_get_action_events_by_timesort` payload → `Task[]`; plus the pagination guard.
- `test/client.test.js` — injected `fetch` double: retry, timeout, Moodle error mapping, HTML-instead-of-JSON.
- Reminders/JXA layer is **not** unit tested (needs the real app); it is covered by `--dry-run` and one manual checklist item in the README.

---

## 11. Build order & commit plan

Small, self-contained commits, each one leaving the repo runnable:

1. `chore: scaffold project (package.json, .gitignore, .env.example, eslint/editorconfig)`
2. `feat(config): env loading, validation and token redaction`
3. `feat(moodle): REST client with timeout, retry and typed error mapping`
4. `feat(moodle): mint web service token via login/token.php (--login)`
5. `feat(model): Task shape, stable ids, status bucketing and sorting`
6. `feat(moodle): fetch action events and normalize to tasks`
7. `feat(render): boxed terminal output with colored urgency buckets`
8. `feat(cli): commander wiring, exit codes, --json output`
9. `feat(state): atomic JSON state store for sync tracking`
10. `feat(reminders): JXA bridge for list and reminder operations`
11. `feat(reminders): create/update/skip sync planner with --dry-run`
12. `feat(notify): macOS notification on newly added tasks`
13. `feat(moodle): iCal calendar export fallback source`
14. `feat(cli): --doctor diagnostics`
15. `feat(schedule): launchd plist + install script, node-cron fallback`
16. `test: unit tests for model, sync, client, ical and tasks`
17. `docs: README with setup, token minting, TCC permissions and troubleshooting`
18. `chore: scrub credentials from the project brief`

---

## 12. Definition of done

- `--doctor` green against the real server with a freshly minted token.
- Real assignments appear in the terminal in the brief's layout, correctly bucketed.
- Reminders list `Schulaufgaben` gets them once; a second run adds nothing; a moved deadline updates in place; a manually deleted reminder stays deleted.
- Runs clean on a non-macOS box (reminders skipped, warning only).
- `npm test` passes; no token in `git log -p`.

## 13. Open question (non-blocking)

Does this Moodle actually expose `core_calendar_get_action_events_by_timesort` to students? The function list is only readable with a valid token, so it is unverifiable until §11 step 4 lands. If the admin restricted it, the fallback ordering is: `mod_assign_get_assignments` + `mod_assign_get_submission_status` per course → then iCal. Build steps 1–5 source-agnostic so this swap touches only `src/moodle/tasks.js`.
