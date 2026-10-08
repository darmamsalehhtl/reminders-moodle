import { stripHtml } from './tasks.js';

const FN_CALENDAR_EVENTS = 'core_calendar_get_calendar_events';
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Personal calendar entries the user created themselves. Moodle's timeline
 * API (tasks.js) cannot see these: it returns only *action* events, and an
 * appointment requires no action. `core_calendar_get_allowed_event_types`
 * reports "user" as the only type a student may create, so these are exactly
 * the entries the user put into their own dashboard calendar.
 */

/**
 * True when an entry covers a whole day rather than starting at a time.
 *
 * The web service exposes no all-day flag, so this is a heuristic (see
 * design.md): a start at local midnight plus a duration of either a full day
 * or none at all. Deliberately narrow - a 09:00 appointment is never mistaken
 * for an all-day one.
 */
export function isAllDay({ timestart, timeduration }) {
  const start = new Date(timestart * 1000);
  const atMidnight =
    start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0;
  if (!atMidnight) return false;
  return !timeduration || timeduration === DAY_SECONDS;
}

/** Maps one raw calendar event to the shared item shape. */
function normalizeEvent(event, moodleUrl) {
  const allDay = isAllDay(event);
  return {
    // Its own prefix, beside ws:/assign:/ical: - the planners use it to tell
    // whose state entries are whose (see reminders/events.js).
    id: `event:${event.id}`,
    kind: 'event',
    source: 'ws',
    title: event.name,
    // An appointment belongs to no course; `course` stays null so the course
    // prefix and IGNORE_COURSES simply never apply to it.
    course: null,
    courseGuessed: false,
    description: stripHtml(event.description ?? ''),
    url: `${moodleUrl}/calendar/view.php?view=day&time=${event.timestart}`,
    // The *start* of the appointment, not a deadline.
    due: new Date(event.timestart * 1000),
    allDay,
    overdueHint: false,
    raw: event,
  };
}

/**
 * The user's own appointments starting within [from, to], as items.
 *
 * Returns [] (and logs) when the token may not call the function, so a server
 * that exposes only the calendar timeline keeps working as before.
 * Network errors propagate so the run can retry next time.
 */
export async function fetchPersonalEvents(client, { from, to, log = () => {} } = {}) {
  let res;
  try {
    res = await client.call(FN_CALENDAR_EVENTS, {
      'options[timestart]': Math.floor(from.getTime() / 1000),
      'options[timeend]': Math.floor(to.getTime() / 1000),
      'options[userevents]': 1,
      'options[siteevents]': 0,
      'options[ignorehidden]': 1,
    });
  } catch (err) {
    if (err?.name !== 'MoodleApiError') throw err;
    log(`(Eigene Termine übersprungen: ${FN_CALENDAR_EVENTS} nicht verfügbar.)`);
    return [];
  }

  return (res?.events ?? [])
    // Without course ids Moodle returns user (and site) events only, but the
    // filter is explicit: a course event must never arrive through this path
    // and end up in the appointments list.
    .filter((e) => e.eventtype === 'user')
    .map((e) => normalizeEvent(e, client.moodleUrl));
}

export { FN_CALENDAR_EVENTS, normalizeEvent as _normalizeEvent };
