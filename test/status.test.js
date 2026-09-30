import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeState } from '../src/status.js';

test('summarizeState counts buckets and finds the latest timestamps', () => {
  const s = summarizeState({
    tasks: {
      a: { syncedAt: '2026-09-01T00:00:00Z' },
      b: { syncedAt: '2026-09-03T00:00:00Z', completedAt: '2026-09-04T00:00:00Z' },
      c: { syncedAt: '2026-09-02T00:00:00Z', deletedByUser: true },
    },
  });
  assert.deepEqual(s, {
    tracked: 3,
    completed: 1,
    deletedByUser: 1,
    active: 1,
    lastSyncedAt: '2026-09-03T00:00:00Z',
    lastCompletedAt: '2026-09-04T00:00:00Z',
  });
});

test('summarizeState handles an empty state', () => {
  const s = summarizeState({ tasks: {} });
  assert.equal(s.tracked, 0);
  assert.equal(s.lastSyncedAt, null);
});
