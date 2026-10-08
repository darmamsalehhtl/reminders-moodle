import { taskChangeHash } from '../model/task.js';
import { eventEndMs } from './policy.js';

/** State entries belonging to appointments, as opposed to tasks. */
const EVENT_PREFIX = 'event:';

/**
 * Pure planning step for appointments, the counterpart to planSync() for
 * tasks. Returns the same plan shape applySync() consumes, plus `complete`.
 *
 * It is a separate planner rather than a flag on planSync because the rules
 * invert in the three places that matter (see design.md):
 *
 *  - an appointment that is over is completed from its own time, with no
 *    network call - there is nothing to hand in,
 *  - an appointment missing from Moodle's answer produces no action at all,
 *    so a deleted or unreachable event never looks "dealt with",
 *  - only `event:` state entries are considered, so the two planners sharing
 *    one state file never see each other's items as vanished.
 *
 * @param {object[]} events
 * @param {{tasks: Record<string, object>}} state
 * @param {{existingReminderIds?: Set<string>, decorate?: (e) => {sig: string},
 *   now?: Date}} [opts]
 *   existingReminderIds: ids from findReminderIds() **for the appointments
 *   list**, to detect reminders the user deleted; omit to skip that check.
 */
export function planEvents(events, state, { existingReminderIds, decorate, now = new Date() } = {}) {
  const create = [];
  const update = [];
  const skip = [];
  const deletedByUser = [];
  const complete = [];

  for (const event of events) {
    const known = state.tasks[event.id];
    const isOver = now.getTime() >= eventEndMs(event);

    if (!known) {
      // An appointment that is already over was never worth a reminder.
      if (isOver) continue;
      create.push(event);
      continue;
    }

    if (existingReminderIds && !existingReminderIds.has(known.reminderId)) {
      deletedByUser.push(event);
      continue;
    }

    if (isOver) {
      if (!known.completedAt) {
        complete.push({ taskId: event.id, entry: { ...known, title: known.title ?? event.title } });
      }
      continue;
    }

    const hash = taskChangeHash(event);
    const viewStale = decorate ? known.sig !== decorate(event).sig : false;
    if (known.hash !== hash || viewStale) {
      update.push({ task: event, reminderId: known.reminderId });
    } else {
      skip.push(event);
    }
  }

  return { create, update, skip, deletedByUser, complete, reopen: [] };
}

export { EVENT_PREFIX };
