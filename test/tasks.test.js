import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchActionEvents, getSiteInfo, _stripHtml } from '../src/moodle/tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/action-events.json'), 'utf8'));

test('getSiteInfo maps raw site info to a flat shape', async () => {
  const client = {
    call: async (fn) => {
      assert.equal(fn, 'core_webservice_get_site_info');
      return { userid: 42001, sitename: 'HTL Moodle', functions: [{ name: 'core_calendar_get_action_events_by_timesort' }] };
    },
  };
  const info = await getSiteInfo(client);
  assert.deepEqual(info, {
    userId: 42001,
    siteName: 'HTL Moodle',
    functions: ['core_calendar_get_action_events_by_timesort'],
  });
});

test('fetchActionEvents normalizes a real-shaped payload into Task[]', async () => {
  const client = {
    call: async (fn, params) => {
      assert.equal(fn, 'core_calendar_get_action_events_by_timesort');
      assert.ok('timesortfrom' in params && 'timesortto' in params);
      return fixture;
    },
  };
  const tasks = await fetchActionEvents(client, { from: new Date('2026-09-01'), to: new Date('2026-10-31') });

  assert.equal(tasks.length, 2);
  const [mathe, english] = tasks;

  assert.equal(mathe.id, 'ws:12345');
  assert.equal(mathe.source, 'ws');
  assert.equal(mathe.title, 'Mathe Hausaufgabe 5');
  assert.equal(mathe.course, '4AHIF Mathematik');
  assert.equal(mathe.overdueHint, true);
  assert.equal(mathe.due.toISOString(), new Date(1758844800 * 1000).toISOString());
  assert.equal(mathe.description, 'Bitte Aufgaben 1-4 bearbeiten & hochladen.');

  assert.equal(english.id, 'ws:12346');
  assert.equal(english.course, '4AHIF English');
  assert.equal(english.description, '');
});

test('fetchActionEvents paginates when a page comes back full', async () => {
  const page1 = {
    events: Array.from({ length: 3 }, (_, i) => ({
      id: i,
      name: `Task ${i}`,
      description: '',
      timesort: 1000 + i,
      overdue: false,
      url: null,
      course: { id: 1, fullname: 'Course' },
    })),
  };
  const page2 = { events: [{ id: 99, name: 'Last task', description: '', timesort: 2000, overdue: false, url: null, course: { id: 1, fullname: 'Course' } }] };

  let callCount = 0;
  const client = {
    call: async (fn, params) => {
      callCount++;
      if (callCount === 1) {
        assert.equal(params.limitnum, 3);
        return page1;
      }
      assert.equal(params.timesortfrom, 1000 + 2 + 1); // last event's timesort + 1
      return page2;
    },
  };

  const tasks = await fetchActionEvents(client, { from: new Date(0), to: new Date(9_999_999_000), limit: 3 });
  assert.equal(callCount, 2);
  assert.equal(tasks.length, 4);
  assert.equal(tasks[3].title, 'Last task');
});

test('fetchActionEvents stops paginating once a page is not full', async () => {
  let callCount = 0;
  const client = {
    call: async () => {
      callCount++;
      return { events: [{ id: 1, name: 'Only one', description: '', timesort: 1000, overdue: false, url: null, course: null }] };
    },
  };
  const tasks = await fetchActionEvents(client, { from: new Date(0), to: new Date(9_999_999_000), limit: 50 });
  assert.equal(callCount, 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].course, null);
});

test('_stripHtml decodes common entities and collapses whitespace', () => {
  assert.equal(_stripHtml('<p>Hallo &amp; Tschüss</p>'), 'Hallo & Tschüss');
  assert.equal(_stripHtml('a\n\n  b'), 'a b');
  assert.equal(_stripHtml(''), '');
});
