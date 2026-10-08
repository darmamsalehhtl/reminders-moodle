# Spec Delta

## Purpose

Keeps a Reminders list of the personal appointments a user entered in their
own Moodle calendar, so the dashboard's two halves — deadlines that need an
action and appointments that only need to be remembered — both reach the
user's phone without being retyped.

## ADDED Requirements

### Requirement: Personal calendar entries are collected

The system SHALL collect the calendar entries the user created themselves
(Moodle event type `user`) that start within the configured lookahead window.
It SHALL NOT collect course, category or site events, nor any entry that
requires a submission — those remain the concern of assignment sync.

#### Scenario: A personal appointment is in the window
- **WHEN** the user's Moodle calendar holds a personal entry starting inside the lookahead window
- **THEN** that entry is collected as an event

#### Scenario: An assignment deadline is not collected as an event
- **WHEN** the calendar holds an assignment due date
- **THEN** it is not collected as an event, and assignment sync continues to handle it unchanged

#### Scenario: The calendar holds no personal entries
- **WHEN** the user has created no personal entries in the window
- **THEN** no event is collected, no events list is created, and the run reports success

### Requirement: An appointment becomes a reminder keyed to its start

The system SHALL represent an event's time by its **start**, since an
appointment is a point in time rather than a deadline. A timed event's
reminder SHALL carry that date and time. An event covering a whole day SHALL
carry the date without a time.

#### Scenario: A timed appointment
- **WHEN** an event starts on 14.10.2026 at 14:00
- **THEN** its reminder is due 14.10.2026 at 14:00

#### Scenario: An all-day appointment
- **WHEN** an event covers a whole day
- **THEN** its reminder is due on that date with no time of day

### Requirement: Events are alarmed on their own lead time

The system SHALL alarm an event's reminder `EVENT_ALARM_LEAD_HOURS` (default
1) before it starts, independent of the lead time used for assignment
deadlines. An all-day event SHALL instead be alarmed at 08:00 local time on
the day it falls, because a lead time measured from midnight would fire the
evening before. A timed event that has already started SHALL NOT be alarmed;
an all-day event SHALL remain alarmable until the end of its day, since it
occupies the whole day rather than the instant of its midnight start.

#### Scenario: Default lead time
- **WHEN** an event starts at 14:00 and `EVENT_ALARM_LEAD_HOURS` is unset
- **THEN** its reminder is alarmed at 13:00 the same day

#### Scenario: Configured lead time
- **WHEN** `EVENT_ALARM_LEAD_HOURS` is 3 and an event starts at 14:00
- **THEN** its reminder is alarmed at 11:00 the same day

#### Scenario: All-day event
- **WHEN** an all-day event falls on 14.10.2026
- **THEN** its reminder is alarmed 14.10.2026 at 08:00, not on the evening of 13.10.2026

#### Scenario: The lead time has already elapsed
- **WHEN** an event starts in 20 minutes and the lead time is 1 hour
- **THEN** the reminder is alarmed shortly from now rather than in the past

#### Scenario: The event has already started
- **WHEN** a timed event's start time has passed
- **THEN** its reminder carries no alarm

#### Scenario: An all-day event on the day itself
- **WHEN** an all-day event falls today and the run happens before 08:00
- **THEN** its reminder is alarmed at 08:00 today

#### Scenario: An all-day event already under way
- **WHEN** an all-day event falls today and the run happens after 08:00
- **THEN** its reminder is alarmed shortly from now, because the day is not over

#### Scenario: An all-day event whose day is over
- **WHEN** an all-day event fell on an earlier day
- **THEN** its reminder carries no alarm

### Requirement: Events and assignments stay in separate lists

The system SHALL sync events into a list of their own, named by
`REMINDERS_EVENTS_LIST` (default `Schultermine`), and SHALL NOT place an event
in the assignments list or an assignment in the events list. Bookkeeping that
compares a reminder against the contents of a list SHALL compare it against
the list that reminder belongs to.

#### Scenario: An event is synced
- **WHEN** an event is synced and `REMINDERS_EVENTS_LIST` is unset
- **THEN** its reminder is created in `Schultermine` and the assignments list is left untouched

#### Scenario: A configured list name
- **WHEN** `REMINDERS_EVENTS_LIST` is `Termine`
- **THEN** event reminders are created in `Termine`

#### Scenario: An event reminder is not mistaken for deleted
- **WHEN** an event's reminder exists in the events list while the assignments list does not contain it
- **THEN** it is not treated as deleted by the user, and no duplicate is created

### Requirement: An event that is over is completed

The system SHALL complete an event's reminder once the event is over. A timed
event is over when its start time has passed. An all-day event is over only at
the end of its day, so an appointment taking place today is never completed
during that day.

#### Scenario: The appointment is over
- **WHEN** a synced timed event's start time lies in the past
- **THEN** its reminder is marked completed and reported in the run's output

#### Scenario: The appointment is still ahead
- **WHEN** a synced event starts in the future
- **THEN** its reminder is left open

#### Scenario: An all-day appointment during its own day
- **WHEN** a synced all-day event falls today
- **THEN** its reminder is left open for the whole day

#### Scenario: An all-day appointment after its day
- **WHEN** a synced all-day event fell on an earlier day
- **THEN** its reminder is marked completed

### Requirement: A vanished event is never completed

An event that is no longer returned by Moodle MAY have been deleted, moved
out of the window, or be temporarily unreachable. The system SHALL leave such
a reminder open and SHALL NOT complete or delete it, so an absence is never
read as "dealt with".

#### Scenario: The event was deleted in Moodle
- **WHEN** a synced event is absent from Moodle's answer and its start time is still in the future
- **THEN** its reminder stays open and uncompleted

#### Scenario: Events could not be fetched at all
- **WHEN** the call for personal events fails
- **THEN** no event reminder is completed, the failure is reported, and assignment sync still runs

### Requirement: Events are excluded from the submission check

An appointment has nothing to hand in. The system SHALL NOT ask Moodle for
the submission status of an event, and SHALL NOT let an event influence
whether an assignment is considered handed in.

#### Scenario: An event is absent from the feed
- **WHEN** a synced event is absent from Moodle's answer
- **THEN** no submission status is requested for it

### Requirement: A changed appointment updates its reminder

The system SHALL keep an event's reminder in step with the event: when its
title or start time changes, the existing reminder SHALL be updated rather
than a second one created.

#### Scenario: The appointment was moved
- **WHEN** a synced event's start time changes in Moodle
- **THEN** its existing reminder's due date and alarm are updated and no duplicate is created

#### Scenario: Nothing changed
- **WHEN** a synced event is unchanged since the last run
- **THEN** its reminder is left as it is

### Requirement: A reminder the user deleted is not recreated

Deleting an event reminder is a deliberate act. The system SHALL remember
that it existed and SHALL NOT create it again while the event is still in
Moodle.

#### Scenario: The user deleted an event reminder
- **WHEN** an event's reminder was deleted from the events list by the user and the event is still in Moodle
- **THEN** the reminder is not recreated on later runs

### Requirement: Event sync can be switched off

The system SHALL sync events by default and SHALL skip them entirely when
`--no-events` is passed or `EVENTS` is set to a false value. When skipped, no
call for personal events is made and no events list is created.

#### Scenario: Switched off by flag
- **WHEN** the tool runs with `--no-events`
- **THEN** no personal events are fetched or synced, and assignment sync is unaffected

### Requirement: Events are visible before they are synced

The system SHALL show collected events in its terminal and JSON output, in a
section separate from assignments, and SHALL list the event reminders it would
create, update or complete when run with `--dry-run`.

#### Scenario: Terminal output
- **WHEN** events were collected
- **THEN** they are shown under their own heading, distinct from the assignment buckets

#### Scenario: Dry run
- **WHEN** the tool runs with `--dry-run` and an event is new
- **THEN** the planned creation is printed and Reminders is not modified

### Requirement: Title ignore rules apply to events

The system SHALL hide an event whose title matches `IGNORE_TITLES`, and SHALL
NOT sync it. `IGNORE_COURSES` SHALL have no effect on events, which belong to
no course.

#### Scenario: An ignored title
- **WHEN** `IGNORE_TITLES` contains a substring of an event's title
- **THEN** that event is neither shown nor synced
