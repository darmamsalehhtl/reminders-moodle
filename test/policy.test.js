import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alarmMs, priorityFor, displayTitle, buildView, PRIORITY } from '../src/reminders/policy.js';

const now = new Date('2026-10-01T10:00:00Z');
const inHours = (h) => new Date(now.getTime() + h * 3600_000);
const mk = (due, extra = {}) => ({ title: 'HÜ 5', course: 'Mathematik', due, ...extra });

test('alarm fires leadHours before the due date', () => {
  const due = inHours(72);
  assert.equal(alarmMs(mk(due), { now, leadHours: 24 }), due.getTime() - 24 * 3600_000);
});

test('alarm inside the lead window fires one minute from now', () => {
  assert.equal(alarmMs(mk(inHours(5)), { now, leadHours: 24 }), now.getTime() + 60_000);
});

test('no alarm for undated or overdue tasks', () => {
  assert.equal(alarmMs(mk(null), { now }), null);
  assert.equal(alarmMs(mk(inHours(-2)), { now }), null);
});

test('priority buckets: overdue/soon high, within a week medium, else none', () => {
  assert.equal(priorityFor(mk(inHours(-5)), { now }), PRIORITY.HIGH);
  assert.equal(priorityFor(mk(inHours(48)), { now }), PRIORITY.HIGH);
  assert.equal(priorityFor(mk(inHours(24 * 6)), { now }), PRIORITY.MEDIUM);
  assert.equal(priorityFor(mk(inHours(24 * 20)), { now }), PRIORITY.NONE);
  assert.equal(priorityFor(mk(null), { now }), PRIORITY.NONE);
});

test('displayTitle prefixes the course only when known and enabled', () => {
  assert.equal(displayTitle(mk(null)), '[Mathematik] HÜ 5');
  assert.equal(displayTitle(mk(null), { prefix: false }), 'HÜ 5');
  assert.equal(displayTitle(mk(null, { course: null })), 'HÜ 5');
});

test('view signature changes with priority or title, not with the clock', () => {
  const a = buildView(mk(inHours(24 * 6)), { now });
  const sameLater = buildView(mk(inHours(24 * 6)), { now: new Date(now.getTime() + 60_000) });
  const escalated = buildView(mk(inHours(24 * 6)), { now: new Date(now.getTime() + 4 * 24 * 3600_000) });
  assert.equal(a.sig, sameLater.sig);
  assert.notEqual(a.sig, escalated.sig);
});
