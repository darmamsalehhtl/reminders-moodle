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

/** All-day appointments are alarmed at this local hour on the day itself. */
const ALL_DAY_ALARM_HOUR = 8;

/**
 * When an appointment's alarm should fire: `leadHours` before it starts.
 *
 * An all-day appointment is pinned to 08:00 on the day itself instead - a
 * lead time measured from midnight would fire the evening before, which
 * reads as the wrong day. Returns null once the appointment has started;
 * if the lead time has already elapsed but it has not started yet, the
 * alarm fires one minute from now.
 */
export function eventAlarmMs(event, { now = new Date(), leadHours = 1 } = {}) {
  if (!event.due) return null;
  const startMs = event.due.getTime();

  // An all-day appointment occupies its whole day, so "already started" is
  // decided by the end of that day rather than by its midnight start -
  // otherwise it would lose its alarm before the 08:00 it is meant to fire at.
  if (event.allDay) {
    if (now.getTime() >= eventEndMs(event)) return null;
    const day = new Date(startMs);
    day.setHours(ALL_DAY_ALARM_HOUR, 0, 0, 0);
    const at = day.getTime();
    return at > now.getTime() ? at : now.getTime() + 60_000;
  }

  if (startMs <= now.getTime()) return null;
  const at = startMs - leadHours * HOUR_MS;
  return at > now.getTime() ? at : now.getTime() + 60_000;
}

/**
 * When an appointment stops being current: its start for a timed one, the end
 * of its day for an all-day one. Used for the alarm above and for deciding
 * that an appointment is over (see reminders/events.js).
 */
export function eventEndMs(event) {
  if (!event.due) return null;
  if (!event.allDay) return event.due.getTime();
  const endOfDay = new Date(event.due.getTime());
  endOfDay.setHours(0, 0, 0, 0);
  endOfDay.setDate(endOfDay.getDate() + 1);
  return endOfDay.getTime();
}

/**
 * How imminent an appointment is: high within a day of its start, medium
 * within `soonDays`, none beyond that. Unlike a deadline an appointment has
 * no overdue state - once it is past it gets completed, not escalated.
 */
export function eventPriorityFor(event, { now = new Date(), soonDays = 3 } = {}) {
  if (!event.due) return PRIORITY.NONE;
  if (now.getTime() >= eventEndMs(event)) return PRIORITY.NONE;
  const diffMs = Math.max(event.due.getTime() - now.getTime(), 0);
  if (diffMs <= DAY_MS) return PRIORITY.HIGH;
  if (diffMs <= soonDays * DAY_MS) return PRIORITY.MEDIUM;
  return PRIORITY.NONE;
}

/**
 * The Reminders view of an appointment. Mirrors buildView for tasks, with
 * the appointment's own alarm and priority rules, and never a course prefix
 * (an appointment belongs to no course). `allDay` is carried so the caller
 * can give the reminder a date without a time.
 */
export function buildEventView(event, { now = new Date(), soonDays = 3, leadHours = 1 } = {}) {
  const title = event.title;
  const priority = eventPriorityFor(event, { now, soonDays });
  const sig = createHash('sha1').update(`${title}|${priority}`).digest('hex').slice(0, 16);
  return {
    title,
    priority,
    remindMs: eventAlarmMs(event, { now, leadHours }),
    allDay: Boolean(event.allDay),
    sig,
  };
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
