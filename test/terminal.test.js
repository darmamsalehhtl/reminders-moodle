import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTerminal } from '../src/render/terminal.js';

const now = new Date('2026-10-01T08:00:00Z');

function mkTask(overrides = {}) {
  return { id: 'ws:1', source: 'ws', title: 'Task', course: null, description: '', url: null, due: null, ...overrides };
}

function render(tasks, opts) {
  return renderTerminal(tasks, { now, noColor: true, ...opts });
}

test('bucket headers state the configured soonDays cutoff', () => {
  const days = (n) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
  const tasks = [mkTask({ id: 'a', due: days(1) }), mkTask({ id: 'b', due: days(20) })];

  const out = render(tasks, { soonDays: 7 });
  assert.match(out, /BALD FÄLLIG \(< 7 Tage\)/);
  assert.match(out, /NOCH ZEIT \(> 7 Tage\)/);
  assert.doesNotMatch(out, /3 Tage/);
});

test('a one-day cutoff is spelled in the singular', () => {
  const out = render([mkTask({ due: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000) })], { soonDays: 1 });
  assert.match(out, /NOCH ZEIT \(> 1 Tag\)/);
});

test('the default cutoff is still 3 days', () => {
  const out = render([mkTask({ due: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000) })]);
  assert.match(out, /NOCH ZEIT \(> 3 Tage\)/);
});
