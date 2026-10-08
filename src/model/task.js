import { createHash } from 'node:crypto';

/**
 * @typedef {Object} Task
 * @property {string} id           stable dedupe key, see stableId()
 * @property {'task'|'event'} kind what the item is: something to hand in, or
 *                                 an appointment to be at. Decides which
 *                                 planner and which Reminders list it belongs
 *                                 to, see reminders/events.js.
 * @property {'ws'|'ical'} source
 * @property {string} title
 * @property {string|null} course  null when the source couldn't determine it
 * @property {boolean} courseGuessed true when `course` was heuristically
 *                                    parsed rather than given directly (iCal)
 * @property {string} description
 * @property {string|null} url
 * @property {Date|null} due
 * @property {unknown} raw         the untouched source payload, for debugging
 */

/**
 * Builds the dedupe id for a task. When the source gives a real event id we
 * use it directly (stable across runs by construction); otherwise we hash
 * the fields a user would consider "the same task" so re-fetching the same
 * assignment always yields the same id even without a numeric id.
 */
export function stableId(source, { eventId, title, course, due } = {}) {
  if (eventId !== undefined && eventId !== null) {
    return `${source}:${eventId}`;
  }
  const key = `${title ?? ''}|${course ?? ''}|${due ? due.toISOString() : ''}`;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `${source}:${hash}`;
}

/** @returns {'overdue'|'soon'|'later'|'undated'} */
export function taskStatus(task, { now = new Date(), soonDays = 3 } = {}) {
  if (!task.due) return 'undated';
  const diffMs = task.due.getTime() - now.getTime();
  if (diffMs < 0) return 'overdue';
  const soonMs = soonDays * 24 * 60 * 60 * 1000;
  if (diffMs <= soonMs) return 'soon';
  return 'later';
}

const STATUS_ORDER = { overdue: 0, soon: 1, later: 2, undated: 3 };

/**
 * Sorts tasks the way the terminal/reminders views expect: grouped by
 * urgency bucket, then by due date ascending within a bucket, undated tasks
 * last and ordered by title for a stable tie-break.
 */
export function sortTasks(tasks, opts = {}) {
  return [...tasks].sort((a, b) => {
    const sa = STATUS_ORDER[taskStatus(a, opts)];
    const sb = STATUS_ORDER[taskStatus(b, opts)];
    if (sa !== sb) return sa - sb;
    if (a.due && b.due) {
      const d = a.due.getTime() - b.due.getTime();
      if (d !== 0) return d;
    }
    return a.title.localeCompare(b.title);
  });
}

/** Deduplicates tasks by stableId, keeping the first occurrence. */
export function dedupeTasks(tasks) {
  const seen = new Set();
  const out = [];
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/**
 * A hash of the fields a reminder should track (title/due), used by the
 * sync planner to detect "this task changed since we last synced it"
 * without depending on the id itself changing.
 */
export function taskChangeHash(task) {
  const key = `${task.title}|${task.due ? task.due.toISOString() : ''}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * Drops tasks whose course or title contains any of the given substrings
 * (case-insensitive). Used for the IGNORE_COURSES / IGNORE_TITLES config.
 */
export function applyIgnore(tasks, { courses = [], titles = [] } = {}) {
  const lower = (list) => list.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const courseNeedles = lower(courses);
  const titleNeedles = lower(titles);
  if (courseNeedles.length === 0 && titleNeedles.length === 0) return tasks;
  return tasks.filter((t) => {
    const course = (t.course ?? '').toLowerCase();
    const title = t.title.toLowerCase();
    return !courseNeedles.some((n) => course.includes(n)) && !titleNeedles.some((n) => title.includes(n));
  });
}
