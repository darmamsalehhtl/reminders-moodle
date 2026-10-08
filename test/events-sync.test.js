import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planEvents } from '../src/reminders/events.js';
import { planSync } from '../src/reminders/sync.js';
import { taskChangeHash } from '../src/model/task.js';

const NOW = new Date('2026-10-14T08:00:00');

function mkEvent(overrides = {}) {
  return {
    id: 'event:1',
    kind: 'event',
    source: 'ws',
    title: 'Zahnarzt',
    course: null,
    description: '',
    url: null,
    due: new Date('2026-10-20T14:00:00'),
    allDay: false,
    ...overrides,
  };
}

const ids = (...v) => new Set(v);

test('unknown appointment -> create', () => {
  const event = mkEvent();
  const plan = planEvents([event], { tasks: {} }, { now: NOW });
  assert.deepEqual(plan.create, [event]);
  assert.deepEqual(plan.complete, []);
});

test('an appointment that is already over is never created', () => {
  const plan = planEvents([mkEvent({ due: new Date('2026-10-01T10:00:00') })], { tasks: {} }, { now: NOW });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.complete, []);
});

test('known appointment, unchanged -> skip', () => {
  const event = mkEvent();
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: taskChangeHash(event) } } };
  const plan = planEvents([event], state, { existingReminderIds: ids('r1'), now: NOW });
  assert.deepEqual(plan.skip, [event]);
  assert.deepEqual(plan.update, []);
});

test('the appointment was moved -> update, no duplicate', () => {
  const before = mkEvent();
  const moved = mkEvent({ due: new Date('2026-10-21T09:00:00') });
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: taskChangeHash(before) } } };
  const plan = planEvents([moved], state, { existingReminderIds: ids('r1'), now: NOW });
  assert.deepEqual(plan.create, []);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].reminderId, 'r1');
});

test('a stale view signature -> update even when the appointment is unchanged', () => {
  const event = mkEvent();
  const base = { reminderId: 'r1', hash: taskChangeHash(event) };
  const decorate = () => ({ sig: 'new' });
  const stale = planEvents([event], { tasks: { 'event:1': { ...base, sig: 'old' } } }, { existingReminderIds: ids('r1'), decorate, now: NOW });
  assert.equal(stale.update.length, 1);
  const fresh = planEvents([event], { tasks: { 'event:1': { ...base, sig: 'new' } } }, { existingReminderIds: ids('r1'), decorate, now: NOW });
  assert.deepEqual(fresh.skip, [event]);
});

test('a reminder the user deleted is not recreated', () => {
  const event = mkEvent();
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: taskChangeHash(event) } } };
  const plan = planEvents([event], state, { existingReminderIds: ids('other'), now: NOW });
  assert.deepEqual(plan.deletedByUser, [event]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
});

test('an appointment that is over -> complete', () => {
  const event = mkEvent({ due: new Date('2026-10-14T07:00:00') });
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: taskChangeHash(event), title: 'Zahnarzt' } } };
  const plan = planEvents([event], state, { existingReminderIds: ids('r1'), now: NOW });
  assert.equal(plan.complete.length, 1);
  assert.equal(plan.complete[0].taskId, 'event:1');
  assert.equal(plan.complete[0].entry.reminderId, 'r1');
  assert.deepEqual(plan.skip, []);
});

test('an already completed appointment is not completed twice', () => {
  const event = mkEvent({ due: new Date('2026-10-14T07:00:00') });
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: taskChangeHash(event), completedAt: '2026-10-14T07:30:00Z' } } };
  const plan = planEvents([event], state, { existingReminderIds: ids('r1'), now: NOW });
  assert.deepEqual(plan.complete, []);
});

test('an all-day appointment stays open during its day and is completed after', () => {
  const event = mkEvent({ due: new Date('2026-10-14T00:00:00'), allDay: true });
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: taskChangeHash(event) } } };
  const during = planEvents([event], state, { existingReminderIds: ids('r1'), now: NOW });
  assert.deepEqual(during.complete, []);
  assert.deepEqual(during.skip, [event]);
  const after = planEvents([event], state, { existingReminderIds: ids('r1'), now: new Date('2026-10-15T00:00:01') });
  assert.equal(after.complete.length, 1);
});

test('an appointment absent from the feed produces no action at all', () => {
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: 'whatever' } } };
  const plan = planEvents([], state, { existingReminderIds: ids('r1'), now: NOW });
  for (const bucket of ['create', 'update', 'skip', 'deletedByUser', 'complete']) {
    assert.deepEqual(plan[bucket], [], bucket);
  }
  // the state entry is untouched and still open
  assert.deepEqual(state.tasks['event:1'], { reminderId: 'r1', hash: 'whatever' });
});

test('task state entries are invisible to the event planner', () => {
  const event = mkEvent();
  const state = {
    tasks: {
      'ws:7': { reminderId: 'rT', hash: 'x' },
      'assign:9': { reminderId: 'rA', hash: 'y' },
      'ical:z': { reminderId: 'rI', hash: 'z' },
    },
  };
  const plan = planEvents([event], state, { existingReminderIds: ids('rT', 'rA', 'rI'), now: NOW });
  // the event is simply unknown -> created; no task entry appears anywhere
  assert.deepEqual(plan.create, [event]);
  for (const bucket of ['update', 'skip', 'deletedByUser', 'complete']) {
    assert.deepEqual(plan[bucket], [], bucket);
  }
});

test('an event id never becomes a submission-check candidate', () => {
  const state = { tasks: { 'event:1': { reminderId: 'r1', hash: 'x' } } };
  // planSync sees no event in its feed; it must not treat the entry as a
  // vanished assignment and ask Moodle for a submission status.
  const plan = planSync([], state, { existingReminderIds: ids('r1') });
  assert.deepEqual(plan.completionCandidates, []);
});
