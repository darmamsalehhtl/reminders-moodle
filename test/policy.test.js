import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alarmMs, priorityFor, displayTitle, buildView, PRIORITY, eventAlarmMs, eventPriorityFor, buildEventView, eventEndMs } from '../src/reminders/policy.js';

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

// --- appointments -----------------------------------------------------------

function mkEvent(overrides = {}) {
  return { kind: 'event', title: 'Zahnarzt', course: null, due: null, allDay: false, ...overrides };
}

test('an appointment is alarmed leadHours before it starts', () => {
  const now = new Date('2026-10-14T08:00:00');
  const event = mkEvent({ due: new Date('2026-10-14T14:00:00') });
  assert.equal(eventAlarmMs(event, { now }).valueOf(), new Date('2026-10-14T13:00:00').getTime());
  assert.equal(
    eventAlarmMs(event, { now, leadHours: 3 }).valueOf(),
    new Date('2026-10-14T11:00:00').getTime(),
  );
});

test('an all-day appointment is alarmed at 08:00 on the day, not the evening before', () => {
  const now = new Date('2026-10-12T09:00:00');
  const event = mkEvent({ due: new Date('2026-10-14T00:00:00'), allDay: true });
  const at = new Date(eventAlarmMs(event, { now }));
  assert.equal(at.getDate(), 14);
  assert.equal(at.getHours(), 8);
});

test('an elapsed lead time alarms shortly from now instead of in the past', () => {
  const now = new Date('2026-10-14T13:40:00');
  const event = mkEvent({ due: new Date('2026-10-14T14:00:00') });
  assert.equal(eventAlarmMs(event, { now }), now.getTime() + 60_000);
});

test('an appointment that already started carries no alarm', () => {
  const now = new Date('2026-10-14T15:00:00');
  assert.equal(eventAlarmMs(mkEvent({ due: new Date('2026-10-14T14:00:00') }), { now }), null);
});

test('appointment priority follows imminence and never escalates once past', () => {
  const now = new Date('2026-10-14T08:00:00');
  const p = (iso, extra) => eventPriorityFor(mkEvent({ due: new Date(iso), ...extra }), { now });
  assert.equal(p('2026-10-14T20:00:00'), PRIORITY.HIGH);
  assert.equal(p('2026-10-16T08:00:00'), PRIORITY.MEDIUM);
  assert.equal(p('2026-10-20T08:00:00'), PRIORITY.NONE);
  assert.equal(p('2026-10-13T08:00:00'), PRIORITY.NONE);
  // An all-day appointment today is still current, not past.
  assert.equal(p('2026-10-14T00:00:00', { allDay: true }), PRIORITY.HIGH);
});

test('an all-day appointment keeps its alarm until its day is over', () => {
  const event = mkEvent({ due: new Date('2026-10-14T00:00:00'), allDay: true });
  // Synced at 07:00 on the day: 08:00 has not passed yet.
  assert.equal(
    eventAlarmMs(event, { now: new Date('2026-10-14T07:00:00') }).valueOf(),
    new Date('2026-10-14T08:00:00').getTime(),
  );
  // Synced at 10:00 on the day: still today, so alarm shortly from now.
  const late = new Date('2026-10-14T10:00:00');
  assert.equal(eventAlarmMs(event, { now: late }), late.getTime() + 60_000);
  // The day is over.
  assert.equal(eventAlarmMs(event, { now: new Date('2026-10-15T00:00:00') }), null);
});

test('buildEventView carries allDay and never prefixes a course', () => {
  const now = new Date('2026-10-14T07:00:00');
  const view = buildEventView(mkEvent({ due: new Date('2026-10-14T00:00:00'), allDay: true }), { now });
  assert.equal(view.title, 'Zahnarzt');
  assert.equal(view.allDay, true);
  assert.equal(new Date(view.remindMs).getHours(), 8);
  assert.match(view.sig, /^[0-9a-f]{16}$/);
});

test('the view signature changes with the priority', () => {
  const event = mkEvent({ due: new Date('2026-10-14T14:00:00') });
  const near = buildEventView(event, { now: new Date('2026-10-14T08:00:00') });
  const far = buildEventView(event, { now: new Date('2026-10-01T08:00:00') });
  assert.notEqual(near.sig, far.sig);
});
