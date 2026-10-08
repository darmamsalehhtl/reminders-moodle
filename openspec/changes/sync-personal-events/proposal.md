# Proposal

## Why

The tool syncs everything Moodle considers an *action* — assignments with a
deadline, plus (since recently) assignments without one. Personal calendar
entries the user creates on their Moodle dashboard are invisible to it: they
require no action, so `core_calendar_get_action_events_by_timesort` never
returns them. A probe of the live server confirms this shape — the user's
calendar currently holds one `due` event (already covered) and the only event
type they are allowed to create is `user`, i.e. a personal appointment.

The result is a split workflow: deadlines land in Reminders automatically,
personal appointments entered on the same dashboard have to be retyped by
hand. This change closes that gap, so one run covers everything the user put
into Moodle.

## What Changes

- Read personal calendar events (`eventtype: "user"`) from Moodle via
  `core_calendar_get_calendar_events` with `options[userevents]=1`, a function
  this token is confirmed to expose.
- Sync them into their **own** Reminders list, default `Schultermine`,
  configurable via `REMINDERS_EVENTS_LIST`. The existing `Schulaufgaben` list
  keeps its current contents and behavior.
- Give events their **own alarm lead**, `EVENT_ALARM_LEAD_HOURS`, default 1.
  An appointment at 14:00 wants an alarm at 13:00, not the 24 hours that suit
  a submission deadline.
- Set the reminder's due date from the event's **start time** (`timestart`),
  not a deadline. All-day events (midnight start, full-day duration) carry a
  date without a time.
- **Tick off events that are over.** An appointment whose start time has
  passed is completed on the next run.
- **Never tick off an event that merely vanished** from Moodle. A deleted or
  unreachable event leaves its reminder open, mirroring the existing rule that
  "unknown" is never treated as done.
- Exclude events from the submission check entirely: a personal appointment
  has nothing to hand in, so it must never reach
  `mod_assign_get_submission_status`.
- On by default; `--no-events` and `EVENTS=0` turn it off.
- Not breaking: no existing flag, env var, state entry or list changes
  meaning. A run on a calendar with no personal events behaves as today, at
  the cost of one extra web service call.

## Capabilities

### New Capabilities

- `personal-events`: reading the user's own Moodle calendar entries and
  keeping a Reminders list of them — which events qualify, how an appointment
  (start time, duration, all-day) maps onto a reminder, when one is alarmed,
  completed or left alone, and how this stays isolated from assignment sync.

### Modified Capabilities

None. `openspec/specs/` is still empty, so there is no existing capability
whose requirements this redefines; the assignment behavior it sits beside is
unchanged by design.

## Impact

**New code**
- `src/moodle/events.js` — fetch and normalize personal events.

**Modified code**
- `src/model/task.js` — items need a `kind` (`task` | `event`) so the planner
  can apply different completion rules. Ids get an `event:` prefix, beside the
  existing `ws:`, `assign:` and `ical:`.
- `src/reminders/sync.js` — `planSync` must not route events into
  `completionCandidates`, and needs a "start time passed" rule instead;
  `applySync` must address two lists rather than one.
- `src/reminders/policy.js` — an event view with its own lead time, and a
  priority rule that fits an appointment rather than a deadline.
- `src/reminders/jxa.js` — `findReminderIds` and `ensureList` are called
  per list today; both lists must be covered. **This is the one real trap:**
  the deleted-by-user check compares against the ids of a single list, so an
  event reminder living in `Schultermine` would look user-deleted when checked
  against `Schulaufgaben`.
- `src/cli.js` — fetch wiring, the `--no-events` flag, dry-run output.
- `src/config.js` — `REMINDERS_EVENTS_LIST`, `EVENT_ALARM_LEAD_HOURS`,
  `EVENTS`.
- `src/render/terminal.js`, `src/render/json.js` — events shown in their own
  section, so `--dry-run` and `--json` can report what will be synced.
- `src/moodle/submissions.js` — unchanged, but its callers must stop handing
  it events.
- `.env.example`, `README.md` — the new options and the second list.

**State**
- `~/.moodle-task-fetcher/state.json` gains `event:`-prefixed entries in the
  same `tasks` map. Existing entries are untouched and no migration is needed;
  `--status` counts events alongside assignments.

**No new dependencies.** Tests stay `node:test`, covering the normalizer and
the planner's event rules without macOS.
