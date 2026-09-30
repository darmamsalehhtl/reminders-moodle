import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubmitted, resolveModule } from '../src/moodle/submissions.js';

const apiError = () => Object.assign(new Error('nope'), { name: 'MoodleApiError' });
const stub = (result) => ({ call: async () => (result instanceof Error ? Promise.reject(result) : result) });
const assign = { modulename: 'assign', instance: 7 };

test('submitted status -> true', async () => {
  assert.equal(await isSubmitted(stub({ lastattempt: { submission: { status: 'submitted' } } }), assign), true);
});

test('team submission submitted -> true', async () => {
  assert.equal(await isSubmitted(stub({ lastattempt: { teamsubmission: { status: 'submitted' } } }), assign), true);
});

test('draft / new / no attempt -> false', async () => {
  assert.equal(await isSubmitted(stub({ lastattempt: { submission: { status: 'draft' } } }), assign), false);
  assert.equal(await isSubmitted(stub({ lastattempt: { submission: { status: 'new' } } }), assign), false);
  assert.equal(await isSubmitted(stub({}), assign), false);
});

test('non-assign module -> null', async () => {
  assert.equal(await isSubmitted(stub({}), { modulename: 'quiz', instance: 1 }), null);
});

test('Moodle API error -> null, network error propagates', async () => {
  assert.equal(await isSubmitted(stub(apiError()), assign), null);
  const net = Object.assign(new Error('down'), { name: 'MoodleNetworkError' });
  await assert.rejects(isSubmitted(stub(net), assign));
});

test('resolveModule maps the event\'s cmid to the real assign id', async () => {
  const client = {
    call: async (fn, params) => {
      if (fn === 'core_calendar_get_calendar_event_by_id') return { event: { modulename: 'assign', instance: 236172 } };
      if (fn === 'core_course_get_course_module' && params.cmid === 236172) return { cm: { modname: 'assign', instance: 72729 } };
      throw apiError();
    },
  };
  assert.deepEqual(await resolveModule(client, 1), { modulename: 'assign', instance: 72729 });
});

test('resolveModule -> null when a lookup is refused', async () => {
  assert.equal(await resolveModule(stub(apiError()), 1), null);
  const halfway = {
    call: async (fn) => {
      if (fn === 'core_calendar_get_calendar_event_by_id') return { event: { modulename: 'assign', instance: 5 } };
      throw apiError();
    },
  };
  assert.equal(await resolveModule(halfway, 1), null);
});
