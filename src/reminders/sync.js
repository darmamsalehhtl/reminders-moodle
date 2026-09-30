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
 * @param {{existingReminderIds?: Set<string>, feedIds?: Set<string>}} [opts]
 *   existingReminderIds: the real ids from findReminderIds() to detect
 *   user-deleted reminders; omit to skip that check.
 *   feedIds: ids of every task in the fetched feed *before* any --course
 *   filtering (defaults to the ids of `tasks`); used to tell which synced
 *   tasks vanished from the feed.
 *
 * Besides the create/update/skip buckets it returns:
 *  - completionCandidates: ws tasks that vanished from the feed and whose
 *    reminder is still open - possibly submitted, must be verified against
 *    Moodle before being ticked off
 *  - reopen: tasks we ticked off earlier that are back in the feed
 *    (the submission was reverted)
 */
export function planSync(tasks, state, { existingReminderIds, feedIds } = {}) {
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

    if (known.hash !== hash) {
      update.push({ task, reminderId: known.reminderId });
    } else {
      skip.push(task);
    }
  }

  for (const [taskId, entry] of Object.entries(state.tasks)) {
    if (!taskId.startsWith('ws:')) continue;
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
export async function applySync(plan, { listName, state }) {
  await jxa.ensureList(listName);

  const nextTasks = { ...state.tasks };
  const created = [];
  const errors = [];

  for (const task of plan.create) {
    try {
      const reminderId = await jxa.createReminder({
        list: listName,
        title: task.title,
        body: [task.course, task.description].filter(Boolean).join('\n\n'),
        dueMs: task.due ? task.due.getTime() : null,
        url: task.url,
      });
      nextTasks[task.id] = {
        reminderId,
        hash: taskChangeHash(task),
        syncedAt: new Date().toISOString(),
        title: task.title,
      };
      created.push(task);
    } catch (err) {
      errors.push(err);
    }
  }

  for (const { task, reminderId } of plan.update) {
    try {
      await jxa.updateReminder({
        id: reminderId,
        title: task.title,
        dueMs: task.due ? task.due.getTime() : null,
      });
      nextTasks[task.id] = {
        ...nextTasks[task.id],
        reminderId,
        hash: taskChangeHash(task),
        syncedAt: new Date().toISOString(),
        title: task.title,
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
    if (nextTasks[task.id]) nextTasks[task.id].deletedByUser = true;
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
