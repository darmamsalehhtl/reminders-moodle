import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUndatedTasks, FN_TIMELINE_COURSES, FN_ASSIGNMENTS } from '../src/moodle/assignments.js';

const FN_STATUS = 'mod_assign_get_submission_status';

/**
 * Builds a fake client over a canned set of courses/assignments. `submitted`
 * maps an assign id to the status Moodle would report.
 */
function fakeClient({ courses = [], assignmentCourses = [], submitted = {}, calls = [] } = {}) {
  return {
    moodleUrl: 'https://moodle.test',
    call: async (fn, params = {}) => {
      calls.push({ fn, params });
      if (fn === FN_TIMELINE_COURSES) return { courses };
      if (fn === FN_ASSIGNMENTS) return { courses: assignmentCourses };
      if (fn === FN_STATUS) {
        const status = submitted[params.assignid];
        return { lastattempt: { submission: { status: status ? 'submitted' : 'new' } } };
      }
      throw new Error(`unexpected call ${fn}`);
    },
  };
}

const undatedAssign = { id: 500, cmid: 900, name: 'Export Analyzer', intro: '<p>Bitte <b>abgeben</b></p>', duedate: 0 };
const datedAssign = { id: 501, cmid: 901, name: 'Mit Termin', intro: '', duedate: 1_800_000_000 };

test('fetchUndatedTasks returns only assignments without a due date', async () => {
  const client = fakeClient({
    courses: [{ id: 7 }],
    assignmentCourses: [{ fullname: 'POSEOO 4BHIF', assignments: [undatedAssign, datedAssign] }],
  });

  const tasks = await fetchUndatedTasks(client);
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  assert.equal(task.id, 'assign:500');
  assert.equal(task.source, 'ws');
  assert.equal(task.title, 'Export Analyzer');
  assert.equal(task.course, 'POSEOO 4BHIF');
  assert.equal(task.due, null);
  assert.equal(task.description, 'Bitte abgeben');
  assert.equal(task.url, 'https://moodle.test/mod/assign/view.php?id=900');
  // Needed so the completion check can verify a task that has no event.
  assert.equal(task.modulename, 'assign');
  assert.equal(task.instance, 500);
});

test('fetchUndatedTasks drops assignments that were already handed in', async () => {
  const client = fakeClient({
    courses: [{ id: 7 }],
    assignmentCourses: [{ fullname: 'POSEOO 4BHIF', assignments: [undatedAssign] }],
    submitted: { 500: true },
  });
  assert.deepEqual(await fetchUndatedTasks(client), []);
});

test('fetchUndatedTasks keeps a task when the submission check is inconclusive', async () => {
  const client = {
    moodleUrl: 'https://moodle.test',
    call: async (fn) => {
      if (fn === FN_TIMELINE_COURSES) return { courses: [{ id: 7 }] };
      if (fn === FN_ASSIGNMENTS) return { courses: [{ fullname: 'C', assignments: [undatedAssign] }] };
      const err = new Error('nope');
      err.name = 'MoodleApiError';
      throw err;
    },
  };
  const tasks = await fetchUndatedTasks(client);
  assert.equal(tasks.length, 1, 'an unknown submission status must not hide the task');
});

test('fetchUndatedTasks restricts the assignment query to current courses', async () => {
  const calls = [];
  const client = fakeClient({
    courses: [{ id: 11 }, { id: 22 }],
    assignmentCourses: [],
    calls,
  });
  await fetchUndatedTasks(client);

  const timeline = calls.find((c) => c.fn === FN_TIMELINE_COURSES);
  assert.equal(timeline.params.classification, 'inprogress');
  const assignments = calls.find((c) => c.fn === FN_ASSIGNMENTS);
  // Moodle's array encoding, spelled out because the client sends flat params.
  assert.equal(assignments.params['courseids[0]'], 11);
  assert.equal(assignments.params['courseids[1]'], 22);
});

test('fetchUndatedTasks degrades to [] when a function is not exposed', async () => {
  const logged = [];
  const client = {
    moodleUrl: 'https://moodle.test',
    call: async () => {
      const err = new Error('accessexception');
      err.name = 'MoodleApiError';
      throw err;
    },
  };
  assert.deepEqual(await fetchUndatedTasks(client, { log: (m) => logged.push(m) }), []);
  assert.equal(logged.length, 1);
});

test('fetchUndatedTasks lets network errors propagate so the run can retry', async () => {
  const client = {
    moodleUrl: 'https://moodle.test',
    call: async () => {
      const err = new Error('offline');
      err.name = 'MoodleNetworkError';
      throw err;
    },
  };
  await assert.rejects(() => fetchUndatedTasks(client), /offline/);
});

test('fetchUndatedTasks skips the assignment query when no course is current', async () => {
  const calls = [];
  const client = fakeClient({ courses: [], calls });
  assert.deepEqual(await fetchUndatedTasks(client), []);
  assert.equal(calls.filter((c) => c.fn === FN_ASSIGNMENTS).length, 0);
});
