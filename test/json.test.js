import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderJson } from '../src/render/json.js';

const now = new Date('2026-10-14T08:00:00Z');

test('appointments are serialized with their kind, start and allDay flag', () => {
  const event = {
    id: 'event:1', kind: 'event', source: 'ws', title: 'Zahnarzt',
    description: 'Prophylaxe', url: 'https://moodle.example.org/calendar/view.php',
    due: new Date('2026-10-20T14:00:00Z'), allDay: false,
  };
  const out = JSON.parse(renderJson([], { now, events: [event] }));
  assert.equal(out.eventCount, 1);
  assert.deepEqual(out.events[0], {
    id: 'event:1',
    kind: 'event',
    source: 'ws',
    title: 'Zahnarzt',
    description: 'Prophylaxe',
    url: 'https://moodle.example.org/calendar/view.php',
    start: '2026-10-20T14:00:00.000Z',
    allDay: false,
  });
});

test('appointments are sorted by start and all-day is flagged', () => {
  const mk = (id, iso, allDay = false) => ({
    id, kind: 'event', source: 'ws', title: id, description: '', url: null,
    due: new Date(iso), allDay,
  });
  const out = JSON.parse(renderJson([], {
    now,
    events: [mk('b', '2026-10-25T09:00:00Z'), mk('a', '2026-10-20T00:00:00Z', true)],
  }));
  assert.deepEqual(out.events.map((e) => e.id), ['a', 'b']);
  assert.equal(out.events[0].allDay, true);
});

test('with no appointments the keys are present but empty', () => {
  const out = JSON.parse(renderJson([], { now }));
  assert.equal(out.eventCount, 0);
  assert.deepEqual(out.events, []);
});
