import { taskChangeHash } from '../model/task.js';
import * as jxa from './jxa.js';

/**
 * Pure planning step: given the fetched tasks and the current sync state,
 * decides what needs to happen in Reminders. Kept free of any osascript
 * calls so the six branches below are unit-testable without macOS.
 *
 * Branches (see plan section 6):
 *  - unknown taskId                              -> create
 *  - known, hash unchanged                       -> skip
 *  - known, hash changed (title/due moved)        -> update
 *  - known, but reminder no longer exists in app -> the user deleted it on
 *                                                    purpose; skip forever
 *  - task vanished from the feed                  -> leave state alone
 *
 * @param {import('../model/task.js').Task[]} tasks
 * @param {{tasks: Record<string, {reminderId:string, hash:string}>}} state
 * @param {{existingReminderIds?: Set<string>, feedIds?: Set<string>,
 *   decorate?: (task) => {sig: string}}} [opts]
 *   existingReminderIds: the real ids from findReminderIds() to detect
 *   user-deleted reminders; omit to skip that check.
 *   feedIds: ids of every task in the fetched feed *before* any --course
 *   filtering (defaults to the ids of `tasks`); used to tell which synced
 *   tasks vanished from the feed.
 *   decorate: maps a task to its reminder view (see policy.js buildView). When
 *   given, a reminder whose stored view signature differs (title prefix or
 *   priority changed) is planned as an update even if the task itself is
 *   unchanged; entries without a signature count as stale once.
 *
 * Besides the create/update/skip buckets it returns:
 *  - completionCandidates: ws tasks that vanished from the feed and whose
 *    reminder is still open - possibly submitted, must be verified against
 *    Moodle before being ticked off
 *  - reopen: tasks we ticked off earlier that are back in the feed
 *    (the submission was reverted)
 */
export function planSync(tasks, state, { existingReminderIds, feedIds, decorate } = {}) {
  const create = [];
  const update = [];
  const skip = [];
  const deletedByUser = [];
  const reopen = [];
  const completionCandidates = [];
  const inFeed = feedIds ?? new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    const known = state.tasks[task.id];
    const hash = taskChangeHash(task);

    if (!known) {
      create.push(task);
      continue;
    }

    if (existingReminderIds && !existingReminderIds.has(known.reminderId)) {
      deletedByUser.push(task);
      continue;
    }

    if (known.completedAt) reopen.push({ task, reminderId: known.reminderId });

    const viewStale = decorate ? known.sig !== decorate(task).sig : false;
    if (known.hash !== hash || viewStale) {
      update.push({ task, reminderId: known.reminderId });
    } else {
      skip.push(task);
    }
  }

  for (const [taskId, entry] of Object.entries(state.tasks)) {
    // iCal gives us no way to query a submission, so those can never be
    // verified; calendar-event (ws:) and assignment (assign:) tasks can.
    if (taskId.startsWith('ical:')) continue;
    // Appointments have nothing to hand in and belong to the other planner
    // (reminders/events.js); they must never reach the submission check.
    if (taskId.startsWith('event:')) continue;
    if (inFeed.has(taskId) || entry.deletedByUser || entry.completedAt) continue;
    if (existingReminderIds && !existingReminderIds.has(entry.reminderId)) continue;
    completionCandidates.push({ taskId, entry });
  }

  return { create, update, skip, deletedByUser, reopen, completionCandidates };
}

/**
 * Executes a sync plan against the real Reminders app and returns an
 * updated state plus the list of tasks that were newly created (for the
 * notification/log line). Individual reminder failures are collected in
 * `errors` rather than aborting the whole run.
 */
export async function applySync(plan, { listName, state, decorate }) {
  await jxa.ensureList(listName);

  const nextTasks = { ...state.tasks };
  const created = [];
  const errors = [];

  for (const task of plan.create) {
    try {
      const view = decorate?.(task);
      const reminderId = await jxa.createReminder({
        list: listName,
        title: view?.title ?? task.title,
        priority: view?.priority,
        remindMs: view?.remindMs,
        body: [task.course, task.description].filter(Boolean).join('\n\n'),
        dueMs: task.due ? task.due.getTime() : null,
        allDay: Boolean(view?.allDay),
        url: task.url,
      });
      nextTasks[task.id] = {
        reminderId,
        hash: taskChangeHash(task),
        syncedAt: new Date().toISOString(),
        title: task.title,
        ...(view && { sig: view.sig }),
        // Carried so the completion check can verify the task without
        // resolving a calendar event (undated tasks have none).
        ...(task.modulename && task.instance && { modulename: task.modulename, instance: task.instance }),
      };
      created.push(task);
    } catch (err) {
      errors.push(err);
    }
  }

  for (const { task, reminderId } of plan.update) {
    try {
      const view = decorate?.(task);
      await jxa.updateReminder({
        id: reminderId,
        title: view?.title ?? task.title,
        dueMs: task.due ? task.due.getTime() : null,
        allDay: Boolean(view?.allDay),
        ...(view && { priority: view.priority, remindMs: view.remindMs }),
      });
      nextTasks[task.id] = {
        ...nextTasks[task.id],
        reminderId,
        hash: taskChangeHash(task),
        syncedAt: new Date().toISOString(),
        title: task.title,
        ...(view && { sig: view.sig }),
      };
    } catch (err) {
      errors.push(err);
    }
  }

  const reopened = [];
  for (const { task, reminderId } of plan.reopen ?? []) {
    try {
      await jxa.setCompleted({ id: reminderId, completed: false });
      const { completedAt, ...rest } = nextTasks[task.id];
      nextTasks[task.id] = rest;
      reopened.push(task);
    } catch (err) {
      errors.push(err);
    }
  }

  for (const task of plan.deletedByUser) {
    // Keep the state entry so we remember not to recreate it, but mark it.
    // Written as a fresh object: `nextTasks` is a shallow copy, so mutating
    // the entry in place would write through into the caller's state.
    if (nextTasks[task.id]) nextTasks[task.id] = { ...nextTasks[task.id], deletedByUser: true };
  }

  return { state: { ...state, tasks: nextTasks }, created, reopened, errors };
}

/**
 * Ticks off the reminders of tasks that were verified as handed in.
 * @param {{taskId: string, entry: object}[]} verified
 */
export async function applyCompletions(verified, { state }) {
  const nextTasks = { ...state.tasks };
  const completed = [];
  const errors = [];

  for (const { taskId, entry } of verified) {
    try {
      await jxa.setCompleted({ id: entry.reminderId, completed: true });
      nextTasks[taskId] = { ...entry, completedAt: new Date().toISOString() };
      completed.push({ taskId, title: entry.title ?? taskId });
    } catch (err) {
      errors.push(err);
    }
  }

  return { state: { ...state, tasks: nextTasks }, completed, errors };
}
