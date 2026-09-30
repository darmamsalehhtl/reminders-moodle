import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableId, taskStatus, sortTasks, dedupeTasks, taskChangeHash } from '../src/model/task.js';

const NOW = new Date('2026-09-28T12:00:00Z');

function mkTask(overrides = {}) {
  return {
    id: 'x',
    source: 'ws',
    title: 'Task',
    course: 'Course',
    courseGuessed: false,
    description: '',
    url: null,
    due: null,
    raw: null,
    ...overrides,
  };
}

test('stableId uses the source event id when present', () => {
  const id = stableId('ws', { eventId: 42, title: 'A', course: 'B', due: null });
  assert.equal(id, 'ws:42');
});

test('stableId is deterministic and source-specific when no event id exists', () => {
  const due = new Date('2026-10-01T00:00:00Z');
  const id1 = stableId('ical', { title: 'Essay', course: 'English', due });
  const id2 = stableId('ical', { title: 'Essay', course: 'English', due });
  const id3 = stableId('ws', { title: 'Essay', course: 'English', due });
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});

test('stableId changes when title/course/due changes', () => {
  const id1 = stableId('ical', { title: 'Essay', course: 'English', due: null });
  const id2 = stableId('ical', { title: 'Essay v2', course: 'English', due: null });
  assert.notEqual(id1, id2);
});

test('taskStatus buckets overdue / soon / later / undated', () => {
  const overdue = mkTask({ due: new Date('2026-09-27T00:00:00Z') });
  const soon = mkTask({ due: new Date('2026-09-30T00:00:00Z') }); // +2d
  const later = mkTask({ due: new Date('2026-10-10T00:00:00Z') }); // +12d
  const undated = mkTask({ due: null });

  assert.equal(taskStatus(overdue, { now: NOW }), 'overdue');
  assert.equal(taskStatus(soon, { now: NOW, soonDays: 3 }), 'soon');
  assert.equal(taskStatus(later, { now: NOW, soonDays: 3 }), 'later');
  assert.equal(taskStatus(undated, { now: NOW }), 'undated');
});

test('taskStatus boundary: exactly soonDays away counts as soon, not later', () => {
  const exact = mkTask({ due: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000) });
  assert.equal(taskStatus(exact, { now: NOW, soonDays: 3 }), 'soon');
});

test('taskStatus boundary: due exactly now is not overdue (diff = 0)', () => {
  const exact = mkTask({ due: new Date(NOW.getTime()) });
  assert.equal(taskStatus(exact, { now: NOW }), 'soon');
});

test('sortTasks orders by urgency bucket, then due date, undated last', () => {
  const later = mkTask({ title: 'Later task', due: new Date('2026-10-10T00:00:00Z') });
  const overdue = mkTask({ title: 'Overdue task', due: new Date('2026-09-27T00:00:00Z') });
  const soonEarlier = mkTask({ title: 'Soon A', due: new Date('2026-09-29T00:00:00Z') });
  const soonLater = mkTask({ title: 'Soon B', due: new Date('2026-09-30T00:00:00Z') });
  const undated = mkTask({ title: 'No date', due: null });

  const sorted = sortTasks([later, undated, soonLater, overdue, soonEarlier], { now: NOW, soonDays: 3 });
  assert.deepEqual(
    sorted.map((t) => t.title),
    ['Overdue task', 'Soon A', 'Soon B', 'Later task', 'No date'],
  );
});

test('sortTasks tie-breaks same-bucket same-date tasks by title', () => {
  const b = mkTask({ title: 'B task', due: new Date('2026-10-10T00:00:00Z') });
  const a = mkTask({ title: 'A task', due: new Date('2026-10-10T00:00:00Z') });
  const sorted = sortTasks([b, a], { now: NOW });
  assert.deepEqual(sorted.map((t) => t.title), ['A task', 'B task']);
});

test('sortTasks does not mutate the input array', () => {
  const list = [mkTask({ title: 'Z' }), mkTask({ title: 'A' })];
  const copy = [...list];
  sortTasks(list, { now: NOW });
  assert.deepEqual(list, copy);
});

test('dedupeTasks keeps only the first occurrence of each id', () => {
  const tasks = [mkTask({ id: '1', title: 'first' }), mkTask({ id: '1', title: 'duplicate' }), mkTask({ id: '2', title: 'other' })];
  const out = dedupeTasks(tasks);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'first');
  assert.equal(out[1].id, '2');
});

test('taskChangeHash is stable for identical title+due and changes otherwise', () => {
  const due = new Date('2026-10-01T00:00:00Z');
  const h1 = taskChangeHash(mkTask({ title: 'Essay', due }));
  const h2 = taskChangeHash(mkTask({ title: 'Essay', due }));
  const h3 = taskChangeHash(mkTask({ title: 'Essay', due: new Date('2026-10-02T00:00:00Z') }));
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

import { applyIgnore } from '../src/model/task.js';

test('applyIgnore drops tasks by course or title substring, case-insensitively', () => {
  const tasks = [
    { id: '1', title: 'HÜ 5', course: '4AHIF Mathematik' },
    { id: '2', title: 'Laufen', course: '4AHIF Sport' },
    { id: '3', title: 'Anwesenheit eintragen', course: null },
  ];
  assert.deepEqual(applyIgnore(tasks, { courses: ['sport'], titles: ['ANWESENHEIT'] }).map((t) => t.id), ['1']);
  assert.equal(applyIgnore(tasks, {}), tasks);
  assert.equal(applyIgnore(tasks, { courses: [' ', ''] }).length, 3);
});
