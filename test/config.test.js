import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const NO_ENV_FILE = '/nonexistent/.env';

function cfg(extra = {}) {
  return loadConfig({
    envPath: NO_ENV_FILE,
    env: { MOODLE_URL: 'https://moodle.example.org', ...extra },
  });
}

test('numeric options fall back to their defaults when unset', () => {
  const c = cfg();
  assert.equal(c.soonDays, 3);
  assert.equal(c.lookaheadDays, 30);
  assert.equal(c.alarmLeadHours, 24);
});

test('numeric options are parsed when set', () => {
  const c = cfg({ SOON_DAYS: '7', LOOKAHEAD_DAYS: '14', ALARM_LEAD_HOURS: '0' });
  assert.equal(c.soonDays, 7);
  assert.equal(c.lookaheadDays, 14);
  assert.equal(c.alarmLeadHours, 0);
});

test('event options fall back to their defaults when unset', () => {
  const c = cfg();
  assert.equal(c.remindersEventsList, 'Schultermine');
  assert.equal(c.eventAlarmLeadHours, 1);
  assert.equal(c.events, true);
});

test('event options are parsed when set', () => {
  const c = cfg({ REMINDERS_EVENTS_LIST: 'Termine', EVENT_ALARM_LEAD_HOURS: '3', EVENTS: '0' });
  assert.equal(c.remindersEventsList, 'Termine');
  assert.equal(c.eventAlarmLeadHours, 3);
  assert.equal(c.events, false);
});

test('a non-numeric option is a config error, not a silent NaN', () => {
  for (const key of ['SOON_DAYS', 'LOOKAHEAD_DAYS', 'ALARM_LEAD_HOURS', 'EVENT_ALARM_LEAD_HOURS']) {
    assert.throws(() => cfg({ [key]: 'abc' }), (err) => err instanceof ConfigError && err.message.includes(key), key);
    assert.throws(() => cfg({ [key]: '-1' }), ConfigError, `${key} negative`);
  }
});
