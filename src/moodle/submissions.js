const FN_EVENT_BY_ID = 'core_calendar_get_calendar_event_by_id';
const FN_COURSE_MODULE = 'core_course_get_course_module';
const FN_SUBMISSION_STATUS = 'mod_assign_get_submission_status';

/**
 * Looks up which Moodle module (e.g. "assign") and instance id a calendar
 * event belongs to. On this kind of server the event's `instance` is the
 * course-module id (the `id` in mod/assign/view.php?id=...), not the
 * assignment id, so it is translated via core_course_get_course_module.
 * Returns null when the event no longer exists or a call is refused -
 * callers treat that as "unknown", never as "submitted".
 */
export async function resolveModule(client, eventId) {
  try {
    const res = await client.call(FN_EVENT_BY_ID, { eventid: eventId });
    const ev = res?.event;
    if (!ev?.modulename || !ev.instance) return null;
    const cm = (await client.call(FN_COURSE_MODULE, { cmid: ev.instance }))?.cm;
    if (!cm?.modname || !cm.instance) return null;
    return { modulename: cm.modname, instance: cm.instance };
  } catch (err) {
    if (err?.name === 'MoodleApiError') return null;
    throw err;
  }
}

/**
 * True/false if we can tell whether the assignment was handed in, null if
 * unknown (non-assignment module, missing record, function not exposed).
 * Network errors propagate so the run can retry next time.
 */
export async function isSubmitted(client, { modulename, instance }) {
  if (modulename !== 'assign' || !instance) return null;
  let res;
  try {
    res = await client.call(FN_SUBMISSION_STATUS, { assignid: instance });
  } catch (err) {
    if (err?.name === 'MoodleApiError') return null;
    throw err;
  }
  const last = res?.lastattempt;
  if (!last) return false;
  return last.submission?.status === 'submitted' || last.teamsubmission?.status === 'submitted';
}

export { FN_EVENT_BY_ID, FN_COURSE_MODULE, FN_SUBMISSION_STATUS };
