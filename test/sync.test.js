import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSync } from '../src/reminders/sync.js';
import { taskChangeHash } from '../src/model/task.js';

function mkTask(overrides = {}) {
  return {
    id: 't1',
    source: 'ws',
    title: 'Task',
    course: 'Course',
    description: '',
    url: null,
    due: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

test('unknown task id -> create', () => {
  const task = mkTask({ id: 'ws:1' });
  const plan = planSync([task], { tasks: {} });
  assert.deepEqual(plan.create, [task]);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.skip, []);
  assert.deepEqual(plan.deletedByUser, []);
});

test('known task, unchanged hash -> skip', () => {
  const task = mkTask({ id: 'ws:1' });
  const state = { tasks: { 'ws:1': { reminderId: 'r1', hash: taskChangeHash(task) } } };
  const plan = planSync([task], state, { existingReminderIds: new Set(['r1']) });
  assert.deepEqual(plan.skip, [task]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
});

test('known task, changed due date -> update (not a duplicate create)', () => {
  const oldTask = mkTask({ id: 'ws:1', due: new Date('2026-10-01T00:00:00Z') });
  const movedTask = mkTask({ id: 'ws:1', due: new Date('2026-10-05T00:00:00Z') });
  const state = { tasks: { 'ws:1': { reminderId: 'r1', hash: taskChangeHash(oldTask) } } };
  const plan = planSync([movedTask], state, { existingReminderIds: new Set(['r1']) });
  assert.equal(plan.create.length, 0);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].task, movedTask);
  assert.equal(plan.update[0].reminderId, 'r1');
});

test('known task, changed title -> update', () => {
  const oldTask = mkTask({ id: 'ws:1', title: 'Old title' });
  const renamed = mkTask({ id: 'ws:1', title: 'New title' });
  const state = { tasks: { 'ws:1': { reminderId: 'r1', hash: taskChangeHash(oldTask) } } };
  const plan = planSync([renamed], state, { existingReminderIds: new Set(['r1']) });
  assert.equal(plan.update.length, 1);
});

test('known task whose reminder was deleted by the user -> not recreated', () => {
  const task = mkTask({ id: 'ws:1' });
  const state = { tasks: { 'ws:1': { reminderId: 'r1', hash: taskChangeHash(task) } } };
  // r1 is no longer among the reminders that actually exist in the app.
  const plan = planSync([task], state, { existingReminderIds: new Set(['some-other-id']) });
  assert.deepEqual(plan.deletedByUser, [task]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.skip, []);
});

test('task vanished from the feed leaves its state entry untouched', () => {
  // planSync only iterates over the *current* fetch, so a task that no
  // longer appears simply produces no plan entry for it - callers must not
  // delete its state entry themselves (that is the "leave alone" behavior).
  const stillHere = mkTask({ id: 'ws:1' });
  const state = {
    tasks: {
      'ws:1': { reminderId: 'r1', hash: taskChangeHash(stillHere) },
      'ws:2': { reminderId: 'r2', hash: 'whatever' }, // task ws:2 no longer in the feed
    },
  };
  const plan = planSync([stillHere], state, { existingReminderIds: new Set(['r1', 'r2']) });
  assert.deepEqual(plan.skip, [stillHere]);
  const touchedIds = [...plan.create, ...plan.update.map((u) => u.task), ...plan.skip, ...plan.deletedByUser].map(
    (t) => t.id,
  );
  assert.ok(!touchedIds.includes('ws:2'));
});

test('without existingReminderIds, deletedByUser detection is skipped entirely', () => {
  const task = mkTask({ id: 'ws:1' });
  const state = { tasks: { 'ws:1': { reminderId: 'r1', hash: taskChangeHash(task) } } };
  const plan = planSync([task], state); // no existingReminderIds passed
  assert.deepEqual(plan.skip, [task]);
  assert.deepEqual(plan.deletedByUser, []);
});

test('vanished ws task with open reminder -> completion candidate', () => {
  const stillHere = mkTask({ id: 'ws:1' });
  const state = {
    tasks: {
      'ws:1': { reminderId: 'r1', hash: taskChangeHash(stillHere) },
      'ws:2': { reminderId: 'r2', hash: 'x' },
      'ws:3': { reminderId: 'r3', hash: 'x', completedAt: '2026-09-01T00:00:00Z' },
      'ws:4': { reminderId: 'r4', hash: 'x', deletedByUser: true },
      'ws:5': { reminderId: 'r5', hash: 'x' }, // reminder gone from the app
      'ical:6': { reminderId: 'r6', hash: 'x' },
    },
  };
  const plan = planSync([stillHere], state, { existingReminderIds: new Set(['r1', 'r2', 'r3', 'r4', 'r6']) });
  assert.deepEqual(plan.completionCandidates.map((c) => c.taskId), ['ws:2']);
});

test('feedIds keeps course-filtered tasks from looking vanished', () => {
  const shown = mkTask({ id: 'ws:1' });
  const state = { tasks: { 'ws:2': { reminderId: 'r2', hash: 'x' } } };
  const plan = planSync([shown], state, { feedIds: new Set(['ws:1', 'ws:2']) });
  assert.deepEqual(plan.completionCandidates, []);
});

test('completed task back in the feed -> reopen', () => {
  const task = mkTask({ id: 'ws:1' });
  const state = { tasks: { 'ws:1': { reminderId: 'r1', hash: taskChangeHash(task), completedAt: '2026-09-01T00:00:00Z' } } };
  const plan = planSync([task], state, { existingReminderIds: new Set(['r1']) });
  assert.deepEqual(plan.reopen, [{ task, reminderId: 'r1' }]);
});
