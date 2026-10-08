import { stripHtml } from './tasks.js';
import { isSubmitted } from './submissions.js';

const FN_TIMELINE_COURSES = 'core_course_get_enrolled_courses_by_timeline_classification';
const FN_ASSIGNMENTS = 'mod_assign_get_assignments';

/**
 * Ids of the courses Moodle's own dashboard considers currently running.
 * Enrolments are never removed on this server, so without this filter the
 * assignment list below reaches back years into finished courses.
 */
async function fetchCurrentCourseIds(client) {
  const res = await client.call(FN_TIMELINE_COURSES, { classification: 'inprogress', limit: 0 });
  return (res?.courses ?? []).map((c) => c.id);
}

/**
 * Assignments with `duedate = 0` have no calendar event, so the timeline API
 * in tasks.js cannot see them. This reads them straight off the assign module
 * for the given courses.
 */
async function fetchUndatedAssignments(client, courseIds) {
  // Moodle wants arrays as courseids[0]=..&courseids[1]=.. - the client
  // passes params through flat, so the indices are spelled out here.
  const params = {};
  courseIds.forEach((id, i) => {
    params[`courseids[${i}]`] = id;
  });

  const res = await client.call(FN_ASSIGNMENTS, params);
  const out = [];
  for (const course of res?.courses ?? []) {
    for (const assign of course.assignments ?? []) {
      if (assign.duedate) continue;
      out.push({ assign, courseName: course.fullname ?? null });
    }
  }
  return out;
}

function normalizeAssignment({ assign, courseName }, moodleUrl) {
  return {
    // Deliberately not the `ws:` prefix used for calendar events: those ids
    // are event ids and the completion check resolves them as such.
    id: `assign:${assign.id}`,
    kind: 'task',
    source: 'ws',
    title: assign.name,
    course: courseName,
    courseGuessed: false,
    description: stripHtml(assign.intro ?? ''),
    url: assign.cmid ? `${moodleUrl}/mod/assign/view.php?id=${assign.cmid}` : null,
    due: null,
    overdueHint: false,
    // Lets the completion check verify this task directly instead of going
    // through a calendar event it does not have.
    modulename: 'assign',
    instance: assign.id,
    raw: assign,
  };
}

/**
 * Open assignments without a due date, as Task[]. Already handed-in ones are
 * dropped so they do not show up as eternally open.
 *
 * Returns [] (and logs) when the token may not call one of the two functions,
 * so a server that exposes only the calendar API keeps working as before.
 */
export async function fetchUndatedTasks(client, { log = () => {} } = {}) {
  let courseIds;
  try {
    courseIds = await fetchCurrentCourseIds(client);
  } catch (err) {
    if (err?.name !== 'MoodleApiError') throw err;
    log(`(Aufgaben ohne Fälligkeitsdatum übersprungen: ${FN_TIMELINE_COURSES} nicht verfügbar.)`);
    return [];
  }
  if (courseIds.length === 0) return [];

  let candidates;
  try {
    candidates = await fetchUndatedAssignments(client, courseIds);
  } catch (err) {
    if (err?.name !== 'MoodleApiError') throw err;
    log(`(Aufgaben ohne Fälligkeitsdatum übersprungen: ${FN_ASSIGNMENTS} nicht verfügbar.)`);
    return [];
  }

  const tasks = [];
  for (const candidate of candidates) {
    // isSubmitted returns null when it cannot tell; only a definite `true`
    // hides the task, so an unreachable check never silently loses a task.
    const submitted = await isSubmitted(client, { modulename: 'assign', instance: candidate.assign.id });
    if (submitted === true) continue;
    tasks.push(normalizeAssignment(candidate, client.moodleUrl));
  }
  return tasks;
}

export { FN_TIMELINE_COURSES, FN_ASSIGNMENTS, normalizeAssignment as _normalizeAssignment };
