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

test('appointments are rendered in their own section', () => {
  const event = {
    id: 'event:1', kind: 'event', title: 'Zahnarzt', course: null,
    due: new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000), allDay: false,
  };
  const out = render([mkTask({ due: new Date(now.getTime() + 24 * 60 * 60 * 1000) })], { events: [event] });
  assert.match(out, /DEINE TERMINE/);
  assert.match(out, /Zahnarzt/);
  assert.match(out, /Beginn:/);
  assert.match(out, /1 Termin \|/);
});

test('an all-day appointment is shown without a time', () => {
  const event = {
    id: 'event:1', kind: 'event', title: 'Wandertag', course: null,
    due: new Date(2026, 9, 20, 0, 0, 0), allDay: true,
  };
  const out = render([], { events: [event] });
  assert.match(out, /20\.10\.2026 \(ganztägig\)/);
  assert.doesNotMatch(out, /20\.10\.2026 00:00/);
});

test('without appointments no section and no suffix appear', () => {
  const out = render([mkTask({ due: new Date(now.getTime() + 24 * 60 * 60 * 1000) })]);
  assert.doesNotMatch(out, /DEINE TERMINE/);
  assert.doesNotMatch(out, /Termine \|/);
});

test('appointments use appointment wording, not deadline wording', () => {
  const mkEv = (d) => ({ id: 'event:1', kind: 'event', title: 'T', course: null, due: d, allDay: false });
  const day = (n) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
  assert.match(render([], { events: [mkEv(new Date(now.getTime() + 3600_000))] }), /\(heute\)/);
  assert.match(render([], { events: [mkEv(day(1))] }), /\(morgen\)/);
  assert.match(render([], { events: [mkEv(day(5))] }), /\(in 5 Tagen\)/);
  assert.match(render([], { events: [mkEv(new Date(now.getTime() - 3600_000))] }), /\(vorbei\)/);
  assert.doesNotMatch(render([], { events: [mkEv(day(1))] }), /fällig/);
});
