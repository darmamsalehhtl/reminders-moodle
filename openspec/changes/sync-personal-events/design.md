# Design

## Context

See `proposal.md` — Why. Three properties of the existing code shape this
design:

- `planSync` in `src/reminders/sync.js` is a pure planner with six
  load-bearing branches and twelve tests. Its second loop walks **every**
  entry in `state.tasks` to find items that vanished from the feed.
- `applySync` / `applyCompletions` take exactly one `listName` and
  `findReminderIds` is called for exactly one list.
- A vanished item is only completed after Moodle confirms a submission.
  Events have no submission, so that verification step has no counterpart —
  and the rule it protects ("unknown is never done") must survive anyway.

Confirmed against the live server: `core_calendar_get_calendar_events` is
exposed and answers with `userevents=1` without warnings;
`core_calendar_get_allowed_event_types` returns `["user"]`, so personal
entries are the only kind the user can create. The calendar currently holds
**no** personal events, so no field shape could be observed from real data.

## Goals / Non-Goals

**Goals:**
- Leave the assignment path byte-identical when events are absent or off.
- Keep the event rules pure and testable without macOS, like the task planner.
- One state file, one run, two lists.

**Non-Goals:**
- Writing to the Moodle calendar. `core_calendar_create_calendar_events` is
  exposed, but this change only reads.
- A separate `--status` breakdown per kind (see Open Questions).
- Recurring-event collapsing. Moodle hands out each repetition as its own
  event with its own id, so repetitions sync as separate reminders — which is
  what a calendar of appointments should look like in Reminders anyway.
- iCal support for events. The fallback source cannot distinguish a personal
  entry, so events are web-service only, like the auto check-off.

## Decisions

### One item shape with a `kind`, not a parallel Event type

Events carry `kind: 'event'`; existing items are `kind: 'task'`. Everything
downstream of normalization — state entries, `taskChangeHash`, `applySync`,
`applyCompletions`, the JXA bridge — then needs no new concepts.

*Alternative:* a distinct `Event` type with its own state map and executor.
Rejected: it duplicates the create/update/skip machinery and the atomic state
file for no behavioral gain.

### A separate `planEvents()` rather than a `kind` flag threaded through `planSync`

New pure function in `src/reminders/events.js`, returning the same plan shape
`applySync` already consumes (`create` / `update` / `skip` / `deletedByUser`)
plus a `complete` bucket for appointments that are over.

*Alternative:* teach `planSync` about `kind`. Rejected: the event rules differ
in all three places that matter — vanished items must be ignored rather than
become completion candidates, "over" is decided locally from the start time
instead of from a network answer, and the state walk must be scoped to one
list. Threading that through six tested branches risks the assignment path,
which is the one thing that must not regress. The cost is roughly thirty
duplicated lines of create/update/skip bookkeeping; that is the cheaper trade.

### Scope each planner's state walk by id prefix

Both planners share `state.tasks`. Event ids get an `event:` prefix, beside
`ws:`, `assign:` and `ical:`. Each planner considers only its own prefixes, so
the task planner never sees event entries as vanished and vice versa.

*Alternative:* two state files. Rejected: it gives up the single atomic write
and would need migration.

### `core_calendar_get_calendar_events` over the dashboard views

Called with `options[timestart]` / `options[timeend]` from the existing
lookahead window, `options[userevents]=1`, `options[siteevents]=0` and no
course ids. Array parameters are spelled out flat (`options[...]`), exactly as
`fetchUndatedAssignments` already does for `courseids[0]`.

*Alternatives:* `..._upcoming_view` has a server-side lookahead this tool
cannot set, and returned nothing even where the explicit range also did;
`..._monthly_view` would need month-by-month paging and returns presentation
data. Both are dashboard renderers, not queries.

### "Over" is computed locally; absence is never a signal

A reminder is completed when the event is **present** in Moodle's answer and
its start time has passed — the opposite of the task rule, where completion is
triggered by *absence* plus a confirmed submission. An event missing from the
answer produces no action at all. This keeps "unknown is never done" intact
without a verification call, and makes a fetch failure harmless by
construction.

### All-day events: a documented heuristic, and a fixed 08:00 alarm

`core_calendar_get_calendar_events` exposes no all-day flag, so an event is
treated as all-day when its start is local midnight and its duration is zero
or exactly 86400 seconds. Such a reminder gets a date without a time, and its
alarm is pinned to 08:00 local on the day itself.

*Rationale for the fixed hour:* applying a lead time to a midnight start fires
the evening before, which reads as the wrong day. 08:00 is hard-coded rather
than configurable to avoid a fourth new option for a rare case.

*Found during implementation:* an all-day event's midnight start also breaks
the two rules that compare against "the start" — it would lose its alarm
before 08:00 ever arrived, and be completed at 00:01 on its own morning. So an
all-day event is current until the **end** of its day; `eventEndMs()` is the
single place that distinguishes the two, and both the alarm and the completion
rule go through it.

### Reuse `applySync`, invoked once per list

`runFetch` performs two sync passes against one state object: tasks into
`REMINDERS_LIST`, events into `REMINDERS_EVENTS_LIST`, each with the
`findReminderIds` result **for its own list**. This is what removes the trap
named in the proposal — an event reminder is never compared against the
assignments list — and it needs no change to `applySync`'s signature beyond
being called twice.

`ensureList` for the events list runs only when there is at least one event to
create, so an unused list is never conjured into the user's app.

### Event priority follows imminence, not urgency

High when the appointment starts within 24 hours, medium within `SOON_DAYS`,
otherwise none. An appointment has no overdue state — once it is past it is
completed, not escalated.

## Risks / Trade-offs

- **The all-day heuristic is unverified** → No personal event exists on the
  server yet, so the field shape is taken from Moodle's documented contract.
  A manual verification step with a real timed event and a real all-day event
  is part of the tasks, before the heuristic is trusted.
- **`core_calendar_get_calendar_events` is an older API** and could be
  restricted or retired on a future Moodle upgrade → `--doctor` reports
  whether it is exposed, and a refused call degrades to a logged skip, exactly
  as the undated-assignment path already does.
- **Two `osascript` list queries per run** make a sync slightly slower → the
  events query is skipped entirely when events are off or none were collected.
- **Thirty-odd duplicated planner lines** between `planSync` and `planEvents`
  → accepted deliberately above; if a third kind ever appears, that is the
  moment to unify them, with both test suites as the safety net.
- **An appointment moved into the past between two runs** is completed on the
  next run without ever having been alarmed → correct behavior, but worth
  stating: the tool reflects the calendar, it does not reconstruct missed
  alarms.
- **Timezone skew in the all-day heuristic**: "local midnight" is the
  machine's zone, which is the user's own machine for a personal calendar, so
  a mismatch would require travelling across zones mid-term. Documented, not
  handled.

## Migration Plan

Additive: no state migration, no changed defaults for existing options, no
renamed flags. New `event:` entries simply appear in `state.json` alongside
existing ones.

Rollback is `--no-events` or `EVENTS=0`, which restores today's behavior
exactly; reminders already created in the events list can then be deleted by
hand and will not be recreated.

## Open Questions

- Should `--status` break its counts down per kind (assignments vs
  appointments)? Deferrable: it changes no spec, no approach and no task here,
  and is a one-line addition to `summarizeState` whenever it becomes annoying.
