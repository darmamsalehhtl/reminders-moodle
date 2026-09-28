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
 * @param {{existingReminderIds?: Set<string>}} [opts] pass the real ids from
 *   findReminderIds() to detect user-deleted reminders; omit to skip that
 *   check (e.g. in tests that don't care about it).
 */
export function planSync(tasks, state, { existingReminderIds } = {}) {
  const create = [];
  const update = [];
  const skip = [];
  const deletedByUser = [];

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

    if (known.hash !== hash) {
      update.push({ task, reminderId: known.reminderId });
    } else {
      skip.push(task);
    }
  }

  return { create, update, skip, deletedByUser };
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
      nextTasks[task.id] = { reminderId, hash: taskChangeHash(task), syncedAt: new Date().toISOString() };
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
      nextTasks[task.id] = { reminderId, hash: taskChangeHash(task), syncedAt: new Date().toISOString() };
    } catch (err) {
      errors.push(err);
    }
  }

  for (const task of plan.deletedByUser) {
    // Keep the state entry so we remember not to recreate it, but mark it.
    if (nextTasks[task.id]) nextTasks[task.id].deletedByUser = true;
  }

  return { state: { ...state, tasks: nextTasks }, created, errors };
}
