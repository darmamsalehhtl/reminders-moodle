import { createHash } from 'node:crypto';
import { taskStatus } from '../model/task.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Apple Reminders priority values: 1 = high, 5 = medium, 9 = low, 0 = none. */
export const PRIORITY = { HIGH: 1, MEDIUM: 5, NONE: 0 };

/**
 * When the reminder's alarm should fire: `leadHours` before the due date.
 * Returns null for undated or already-overdue tasks (an alarm in the past
 * would either be ignored or fire instantly for something you can't act on
 * in time anyway). If the lead time has already passed but the task is not
 * yet due, the alarm fires one minute from now.
 */
export function alarmMs(task, { now = new Date(), leadHours = 24 } = {}) {
  if (!task.due) return null;
  const dueMs = task.due.getTime();
  if (dueMs <= now.getTime()) return null;
  const at = dueMs - leadHours * HOUR_MS;
  return at > now.getTime() ? at : now.getTime() + 60_000;
}

/** High when overdue or due soon, medium within a week, none otherwise. */
export function priorityFor(task, { now = new Date(), soonDays = 3 } = {}) {
  const status = taskStatus(task, { now, soonDays });
  if (status === 'overdue' || status === 'soon') return PRIORITY.HIGH;
  if (status === 'later' && task.due.getTime() - now.getTime() <= 7 * DAY_MS) return PRIORITY.MEDIUM;
  return PRIORITY.NONE;
}

/** "[Mathematik] Hausaufgabe 5" when the course is known and prefixing is on. */
export function displayTitle(task, { prefix = true } = {}) {
  if (!prefix || !task.course) return task.title;
  return `[${task.course}] ${task.title}`;
}

/**
 * Builds the "view" of a task that should be reflected in Reminders: the
 * title shown, its priority and a signature over both. The signature is
 * stored in state so the planner can tell when a reminder is stale even
 * though the task itself did not change (the priority drifts as the
 * deadline approaches). The alarm time is deliberately not part of the
 * signature - it depends on "now" and is re-derived whenever the due date
 * changes, which already triggers an update via the task hash.
 */
export function buildView(task, { now = new Date(), soonDays = 3, leadHours = 24, prefix = true } = {}) {
  const title = displayTitle(task, { prefix });
  const priority = priorityFor(task, { now, soonDays });
  const sig = createHash('sha1').update(`${title}|${priority}`).digest('hex').slice(0, 16);
  return { title, priority, remindMs: alarmMs(task, { now, leadHours }), sig };
}
