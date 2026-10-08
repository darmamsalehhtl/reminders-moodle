import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoodleClient } from '../src/moodle/client.js';
import { fetchPersonalEvents, isAllDay, FN_CALENDAR_EVENTS } from '../src/moodle/events.js';

const DAY = 24 * 60 * 60;

/** Unix seconds for a local date/time, so midnight means midnight here. */
function at(y, mo, d, h = 0, mi = 0) {
  return Math.floor(new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000);
}

function clientReturning(payload, { onBody } = {}) {
  return new MoodleClient({
    moodleUrl: 'https://moodle.example.org',
    token: 'abc',
    fetchImpl: async (url, init) => {
      onBody?.(new URLSearchParams(init.body.toString()));
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
}

function rawEvent(overrides = {}) {
  return {
    id: 42,
    name: 'Zahnarzt',
    eventtype: 'user',
    timestart: at(2026, 10, 14, 14, 0),
    timeduration: 0,
    description: '<p>Nicht vergessen&nbsp;&amp; pünktlich</p>',
    ...overrides,
  };
}

const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };

test('fetchPersonalEvents asks for the user-only calendar window', async () => {
  let body;
  const client = clientReturning({ events: [] }, { onBody: (b) => (body = b) });
  await fetchPersonalEvents(client, range);

  assert.equal(body.get('wsfunction'), FN_CALENDAR_EVENTS);
  assert.equal(body.get('options[timestart]'), String(Math.floor(range.from.getTime() / 1000)));
  assert.equal(body.get('options[timeend]'), String(Math.floor(range.to.getTime() / 1000)));
  assert.equal(body.get('options[userevents]'), '1');
  assert.equal(body.get('options[siteevents]'), '0');
  // No course ids: asking for courses would pull in assignment deadlines.
  assert.equal([...body.keys()].filter((k) => k.startsWith('courseids')).length, 0);
});

test('fetchPersonalEvents normalizes a timed appointment', async () => {
  const client = clientReturning({ events: [rawEvent()] });
  const [item] = await fetchPersonalEvents(client, range);

  assert.equal(item.id, 'event:42');
  assert.equal(item.kind, 'event');
  assert.equal(item.title, 'Zahnarzt');
  assert.equal(item.course, null);
  assert.equal(item.allDay, false);
  assert.equal(item.due.getTime(), at(2026, 10, 14, 14, 0) * 1000);
  assert.equal(item.description, 'Nicht vergessen & pünktlich');
  assert.match(item.url, /^https:\/\/moodle\.example\.org\/calendar\//);
});

test('fetchPersonalEvents keeps only the user-created entries', async () => {
  const client = clientReturning({
    events: [
      rawEvent({ id: 1, eventtype: 'user', name: 'Mine' }),
      rawEvent({ id: 2, eventtype: 'course', name: 'Course event' }),
      rawEvent({ id: 3, eventtype: 'site', name: 'Site event' }),
    ],
  });
  const items = await fetchPersonalEvents(client, range);
  assert.deepEqual(items.map((i) => i.title), ['Mine']);
});

test('isAllDay recognizes a whole-day appointment and nothing else', () => {
  assert.equal(isAllDay({ timestart: at(2026, 10, 14), timeduration: DAY }), true);
  assert.equal(isAllDay({ timestart: at(2026, 10, 14), timeduration: 0 }), true);
  // A timed appointment, even a long one, is not all-day.
  assert.equal(isAllDay({ timestart: at(2026, 10, 14, 9, 0), timeduration: DAY }), false);
  assert.equal(isAllDay({ timestart: at(2026, 10, 14, 0, 30), timeduration: 0 }), false);
  // A midnight start with an odd duration is a timed event that happens to
  // begin at midnight, not a whole day.
  assert.equal(isAllDay({ timestart: at(2026, 10, 14), timeduration: 3600 }), false);
});

test('fetchPersonalEvents marks an all-day appointment', async () => {
  const client = clientReturning({
    events: [rawEvent({ timestart: at(2026, 10, 14), timeduration: DAY })],
  });
  const [item] = await fetchPersonalEvents(client, range);
  assert.equal(item.allDay, true);
});

test('a refused call degrades to no events and a logged notice', async () => {
  const client = clientReturning({ exception: 'x', errorcode: 'accessexception', message: 'nope' });
  const logs = [];
  const items = await fetchPersonalEvents(client, { ...range, log: (m) => logs.push(m) });
  assert.deepEqual(items, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Termine/);
});

test('a network error propagates so the next run can retry', async () => {
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: 'abc',
    timeoutMs: 5,
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(fetchPersonalEvents(client, range), (err) => err.name === 'MoodleNetworkError');
});
