import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../src/digest.js';

const now = new Date('2026-10-01T10:00:00Z');
const at = (h) => new Date(now.getTime() + h * 3600_000);

test('no open tasks -> no digest', () => {
  assert.equal(buildDigest([], { now }), null);
});

test('counts open and overdue tasks and names the most urgent one', () => {
  const tasks = [
    { id: '1', title: 'Essay', due: at(72) },
    { id: '2', title: 'HÜ 5', due: at(-30) },
  ];
  assert.equal(buildDigest(tasks, { now }), '2 offen, 1 überfällig · Nächste: HÜ 5 (seit 1 Tg. überfällig)');
});

test('phrases near deadlines in hours and days', () => {
  assert.match(buildDigest([{ id: '1', title: 'A', due: at(5) }], { now }), /\(in 5 Std\.\)/);
  assert.match(buildDigest([{ id: '1', title: 'A', due: at(24) }], { now }), /\(morgen\)/);
  assert.match(buildDigest([{ id: '1', title: 'A', due: at(96) }], { now }), /\(in 4 Tagen\)/);
});

test('undated tasks are counted but have no "next"', () => {
  assert.equal(buildDigest([{ id: '1', title: 'A', due: null }], { now }), '1 offen');
});
