import { taskStatus, sortTasks } from '../model/task.js';

/**
 * Renders tasks as machine-readable JSON for --json / downstream tooling.
 * Logs must go to stderr when this mode is active so stdout stays valid
 * JSON for piping (`moodle-tasks --json | jq ...`).
 */
export function renderJson(tasks, { now = new Date(), soonDays = 3, events = [] } = {}) {
  const sorted = sortTasks(tasks, { now, soonDays });
  const byStart = [...events].sort((a, b) => (a.due?.getTime() ?? 0) - (b.due?.getTime() ?? 0));
  return JSON.stringify(
    {
      generatedAt: now.toISOString(),
      count: sorted.length,
      eventCount: byStart.length,
      tasks: sorted.map((task) => ({
        id: task.id,
        source: task.source,
        title: task.title,
        course: task.course,
        courseGuessed: Boolean(task.courseGuessed),
        description: task.description,
        url: task.url,
        due: task.due ? task.due.toISOString() : null,
        status: taskStatus(task, { now, soonDays }),
      })),
      events: byStart.map((event) => ({
        id: event.id,
        kind: event.kind,
        source: event.source,
        title: event.title,
        description: event.description,
        url: event.url,
        start: event.due ? event.due.toISOString() : null,
        allDay: Boolean(event.allDay),
      })),
    },
    null,
    2,
  );
}
