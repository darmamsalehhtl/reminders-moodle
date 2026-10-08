import { stableId } from '../model/task.js';

const FN_SITE_INFO = 'core_webservice_get_site_info';
const FN_ACTION_EVENTS = 'core_calendar_get_action_events_by_timesort';
const PAGE_LIMIT = 50;

/** Validates the token and returns { userId, siteName, functions[] }. */
export async function getSiteInfo(client) {
  const info = await client.call(FN_SITE_INFO);
  return {
    userId: info.userid,
    siteName: info.sitename,
    functions: (info.functions ?? []).map((f) => f.name),
  };
}

function toDate(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000);
}

/** Maps one raw `core_calendar_get_action_events_by_timesort` event to a Task. */
function normalizeEvent(event) {
  const course = event.course?.fullname ?? null;
  const due = toDate(event.timesort);
  return {
    id: stableId('ws', { eventId: event.id, title: event.name, course, due }),
    kind: 'task',
    source: 'ws',
    title: event.name,
    course,
    courseGuessed: false,
    description: stripHtml(event.description ?? ''),
    url: event.url ?? null,
    due,
    overdueHint: Boolean(event.overdue),
    raw: event,
  };
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetches every action event (assignments, quizzes, ... - anything Moodle's
 * own timeline considers "needs action") whose due time falls within
 * [from, to], paginating past Moodle's per-call limit if needed.
 *
 * Only ever returns *dated* tasks: in Moodle a calendar event is created by
 * the due date itself ("X ist fällig."), so an assignment without one has no
 * event to find here at all. Those come from assignments.js instead.
 *
 * @param {import('./client.js').MoodleClient} client
 * @param {{from: Date, to: Date, limit?: number}} range
 */
export async function fetchActionEvents(client, { from, to, limit = PAGE_LIMIT } = {}) {
  const events = [];
  let cursorFrom = Math.floor(from.getTime() / 1000);
  const toSeconds = Math.floor(to.getTime() / 1000);

  // Moodle's timesort cursor is inclusive on both ends and returns at most
  // `limitnum` events per call; when we get a full page there may be more
  // events at the same or later timesort, so we advance the cursor past the
  // last event we saw and re-request. A hard cap prevents ever looping
  // forever if Moodle for some reason keeps returning a full page.
  for (let page = 0; page < 20; page++) {
    const result = await client.call(FN_ACTION_EVENTS, {
      timesortfrom: cursorFrom,
      timesortto: toSeconds,
      limitnum: limit,
    });
    const batch = result.events ?? [];
    events.push(...batch);
    if (batch.length < limit) break;
    const lastTimesort = batch[batch.length - 1].timesort;
    cursorFrom = lastTimesort + 1;
    if (cursorFrom > toSeconds) break;
  }

  return events.map(normalizeEvent);
}

export { stripHtml };
export { normalizeEvent as _normalizeEvent, stripHtml as _stripHtml };
