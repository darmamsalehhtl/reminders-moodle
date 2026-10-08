# Tasks

## 1. Configuration and item shape

- [x] 1.1 Add `REMINDERS_EVENTS_LIST` (default `Schultermine`), `EVENT_ALARM_LEAD_HOURS` (default 1) and `EVENTS` (default on) to `loadConfig`, reusing the existing `number()` and `flag()` helpers; verify by extending `test/config.test.js` with defaults, parsed values and a rejected non-numeric lead time
- [x] 1.2 Add `kind` (`'task' | 'event'`) to the item shape in `src/model/task.js`, defaulting existing normalizers to `'task'`; verify `npm test` still passes unchanged
- [x] 1.3 Document the three new options in `.env.example` next to the existing optional block; verify the file lists each with its default

## 2. Reading personal events from Moodle

- [x] 2.1 Add `src/moodle/events.js` with a `fetchPersonalEvents(client, {from, to, log})` that calls `core_calendar_get_calendar_events` with flat `options[...]` params (`timestart`, `timeend`, `userevents=1`, `siteevents=0`, no course ids); verify with a fake `fetchImpl` in a new `test/moodle-events.test.js` asserting the exact POST body
- [x] 2.2 Normalize each event to the item shape with `kind: 'event'`, an `event:<id>` id, start time in `due`, and `allDay` from the midnight/duration heuristic in design.md; verify unit tests cover a timed event, a midnight+86400 event, a midnight+0 event and a non-midnight event
- [x] 2.3 Keep only `eventtype === 'user'` entries, so a course or site event can never arrive through this path; verify a test feeding a mixed payload returns only the personal entry
- [x] 2.4 Degrade to `[]` with a logged German notice when the call is refused with a `MoodleApiError`, letting network errors propagate, exactly as `fetchUndatedTasks` does; verify tests for both error kinds
- [x] 2.5 Report `core_calendar_get_calendar_events` availability in `--doctor` alongside the existing function checks; verify by running `node bin/moodle-tasks.js --doctor` and seeing the new line

## 3. Reminder policy for appointments

- [x] 3.1 Add `buildEventView(event, {now, soonDays, leadHours})` to `src/reminders/policy.js`: alarm `leadHours` before the start, 08:00 local on the day for an all-day event, none once started; verify new cases in `test/policy.test.js` including the elapsed-lead and already-started branches
- [x] 3.2 Give events their own priority rule — high within 24h of the start, medium within `SOON_DAYS`, otherwise none — and include title and priority in the view signature as the task view does; verify tests at each boundary
- [x] 3.3 Carry `allDay` into the reminder so an all-day appointment gets a date without a time; verify the view test asserts no time component for that case

## 4. The event planner

- [x] 4.1 Add `planEvents(events, state, {existingReminderIds, decorate, now})` to a new `src/reminders/events.js`, returning `create` / `update` / `skip` / `deletedByUser` / `complete` in the shape `applySync` already consumes; verify a new `test/events-sync.test.js` covers create, skip on unchanged, update on moved start, update on stale signature and the user-deleted branch
- [x] 4.2 Complete an event that is present and whose start has passed, and take no action at all for one absent from the feed; verify tests for both, asserting the absent event's state entry is untouched and uncompleted
- [x] 4.3 Scope the planner's state walk to `event:`-prefixed entries so task entries are never considered; verify a test with a mixed state map that task entries appear in no bucket
- [x] 4.4 Confirm no event id can reach the submission check; verify a test asserting `planSync` returns no `completionCandidates` for `event:` entries in state

## 5. Wiring the second sync pass

- [x] 5.1 Fetch personal events in `fetchTasks` when the web service source is used and events are enabled, in the same `Promise.all` as the existing two sources; verify `--dry-run` lists collected events
- [x] 5.2 Apply `IGNORE_TITLES` to events and leave `IGNORE_COURSES` without effect on them; verify a test that an ignored title is dropped while a course needle does not match an event
- [x] 5.3 Run a second sync pass in `syncReminders` for the events list, calling `findReminderIds` for that list and `ensureList` only when there is something to create, sharing the one state object and saving once; verify `--dry-run` on a calendar with an event shows the plan against the events list
- [x] 5.4 Add `--no-events` and have `EVENTS=0` skip the fetch and both event passes entirely; verify a `--no-events` run makes no calendar-events call and leaves the events list absent
- [x] 5.5 Print planned event creations, updates and completions in the `--dry-run` block, distinguishable from assignment lines; verify by reading the dry-run output
- [x] 5.6 Document the feature in `README.md` — the new list, the three options, that it needs the web service source, and that an appointment is completed once it is over; verify every documented command runs as written

## 6. Showing events before they sync

- [x] 6.1 Render collected events in their own section in the terminal output, reusing the existing box helpers; verify new cases in `test/terminal.test.js` for a timed event, an all-day event and the empty case
- [x] 6.2 Include events in `--json` output with their `kind` and `allDay`; verify a test asserting the serialized shape

## 7. Integration verification

- [ ] 7.1 Create one timed and one all-day personal event in the real Moodle calendar, run the tool, and confirm the all-day heuristic and both alarms match design.md; correct the heuristic if the real payload differs
- [ ] 7.2 Run a full sync and confirm both lists exist with the right contents, then re-run and confirm the second run reports only skips
- [ ] 7.3 Let an appointment pass and confirm the next run completes exactly that reminder and leaves assignments untouched
- [x] 7.4 Run with `--no-events` and confirm the run is byte-identical to today's output for the same assignment feed
