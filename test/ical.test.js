import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchIcalTasks, _parseVEvents, _eventToTask, _guessCourse } from '../src/moodle/ical.js';
import { MoodleProtocolError } from '../src/moodle/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(path.join(__dirname, 'fixtures/calendar.ics'), 'utf8');

test('fetchIcalTasks parses a realistic Moodle export into Task[]', async () => {
  const fetchImpl = async () => new Response(fixtureText, { status: 200 });
  const tasks = await fetchIcalTasks('https://example/cal.ics', { fetchImpl });

  assert.equal(tasks.length, 3);
  const [mathe, english, projekttag] = tasks;

  assert.equal(mathe.id, 'ical:abc-123-mathe@edufs.edu.htl-leonding.ac.at');
  assert.equal(mathe.source, 'ical');
  assert.equal(mathe.course, '4AHIF Mathematik');
  assert.equal(mathe.courseGuessed, false); // came from CATEGORIES, not a guess
  assert.equal(mathe.due.toISOString(), '2026-09-27T22:00:00.000Z');
  assert.ok(mathe.description.includes('Zweite Zeile'));

  // No CATEGORIES on this event, so the course is a heuristic guess pulled
  // from the trailing "(4AHIF English)" in the summary.
  assert.equal(english.course, '4AHIF English');
  assert.equal(english.courseGuessed, true);
  assert.equal(english.title, 'English: Essay Abgabe (4AHIF English)');

  // VALUE=DATE (all-day) event: parsed as a UTC midnight date, no time component.
  assert.equal(projekttag.due.toISOString(), '2026-10-05T00:00:00.000Z');
});

test('parseVEvents unfolds a continuation line split with CRLF + leading space', () => {
  const crlf = ['BEGIN:VEVENT', 'UID:1', 'SUMMARY:Hallo', ' Welt', 'END:VEVENT'].join('\r\n');
  const [event] = _parseVEvents(crlf);
  assert.equal(event.summary, 'HalloWelt');
});

test('parseVEvents decodes escaped commas/semicolons/backslashes/newlines in text values', () => {
  const [event] = _parseVEvents(
    ['BEGIN:VEVENT', 'UID:1', 'SUMMARY:A\\, B\\; C\\\\D\\nE', 'END:VEVENT'].join('\n'),
  );
  assert.equal(event.summary, 'A, B; C\\D\nE');
});

test('parseVEvents ignores lines outside BEGIN:VEVENT/END:VEVENT', () => {
  const events = _parseVEvents(['VERSION:2.0', 'SUMMARY:should not appear', 'BEGIN:VEVENT', 'UID:1', 'END:VEVENT'].join('\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, undefined);
});

test('eventToTask falls back to a heuristic course guess and flags it', () => {
  const task = _eventToTask({ uid: 'x', summary: 'Deutsch: Aufsatz', dtstart: null });
  assert.equal(task.course, 'Deutsch');
  assert.equal(task.courseGuessed, true);
});

test('eventToTask trusts CATEGORIES over the heuristic and does not flag it as a guess', () => {
  const task = _eventToTask({ uid: 'x', summary: 'Deutsch: Aufsatz', categories: 'Wahlfach', dtstart: null });
  assert.equal(task.course, 'Wahlfach');
  assert.equal(task.courseGuessed, false);
});

test('_guessCourse extracts a trailing parenthesized course name first', () => {
  assert.equal(_guessCourse('Essay Abgabe (4AHIF English)', ''), '4AHIF English');
});

test('fetchIcalTasks rejects a non-calendar response instead of silently returning nothing', async () => {
  const fetchImpl = async () => new Response('<html>login page</html>', { status: 200 });
  await assert.rejects(() => fetchIcalTasks('https://example/cal.ics', { fetchImpl }), MoodleProtocolError);
});
