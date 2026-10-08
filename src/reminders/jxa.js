import { execFile } from 'node:child_process';

/** Thrown for anything Reminders.app / osascript specific went wrong. */
export class RemindersError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RemindersError';
    this.code = code;
  }
}

// macOS error -1743 is "not authorized to send Apple events" - i.e. the
// user hasn't granted this terminal app permission to control Reminders
// under Privacy & Security > Automation.
const NOT_AUTHORIZED_CODE = '-1743';

const AUTOMATION_HINT =
  'Terminal ist nicht berechtigt, die Erinnerungen-App zu steuern.\n' +
  'Bitte erlauben unter: Systemeinstellungen → Datenschutz & Sicherheit → Automatisierung → Terminal → Erinnerungen.';

/**
 * Runs a JXA (JavaScript for Automation) script against Reminders.app.
 *
 * The script source is written on stdin (so it never has to be shell-quoted
 * or embedded in a command line), and the caller's data is passed as a
 * single JSON-encoded argv entry that the script reads via `run(argv)`.
 * Data is NEVER string-interpolated into the script text - that is what
 * made the brief's original AppleScript snippet both fragile (any quote or
 * apostrophe in a task title broke it) and an injection risk.
 *
 * The script itself must be a JXA function body assigned to a `main`
 * function; this wrapper handles JSON in/out and error translation.
 */
function runJxa(scriptBody, payload) {
  const wrapped = `
function run(argv) {
  const input = JSON.parse(argv[0]);
  function main(data) {
    ${scriptBody}
  }
  const result = main(input);
  return JSON.stringify(result === undefined ? null : result);
}`;

  return new Promise((resolve, reject) => {
    const child = execFile(
      'osascript',
      ['-l', 'JavaScript', '-', JSON.stringify(payload ?? null)],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const message = stderr?.trim() || err.message;
          if (message.includes(NOT_AUTHORIZED_CODE)) {
            reject(new RemindersError(AUTOMATION_HINT, { cause: err, code: 'not_authorized' }));
            return;
          }
          reject(new RemindersError(`osascript failed: ${message}`, { cause: err }));
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        } catch (parseErr) {
          reject(new RemindersError(`Could not parse osascript output: ${stdout}`, { cause: parseErr }));
        }
      },
    );
    child.stdin.write(wrapped);
    child.stdin.end();
  });
}

/** True if a Reminders list with this name exists. */
export async function listExists(name) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    return Reminders.lists.whose({ name: data.name })().length > 0;
  `,
    { name },
  );
}

/** Creates a Reminders list, no-op if it already exists. */
export async function ensureList(name) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    const existing = Reminders.lists.whose({ name: data.name })();
    if (existing.length > 0) return { created: false };
    const list = Reminders.List({ name: data.name });
    Reminders.lists.push(list);
    return { created: true };
  `,
    { name },
  );
}

/**
 * Creates a reminder in the given list.
 * @param {{list: string, title: string, body?: string, dueMs?: number|null, url?: string|null,
 *   priority?: number, remindMs?: number|null, allDay?: boolean}} params
 *   allDay: set the date without a time of day (Reminders' "allday due
 *   date"), for an appointment that covers a whole day.
 * @returns {Promise<string>} the new reminder's persistent id
 */
export async function createReminder({ list, title, body = '', dueMs = null, url = null, priority = 0, remindMs = null, allDay = false }) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    const lists = Reminders.lists.whose({ name: data.list })();
    if (lists.length === 0) throw new Error('List not found: ' + data.list);
    const targetList = lists[0];
    const props = { name: data.title, body: data.body || '' };
    if (data.dueMs !== null && data.dueMs !== undefined) {
      if (data.allDay) props.alldayDueDate = new Date(data.dueMs);
      else props.dueDate = new Date(data.dueMs);
    }
    if (data.priority) props.priority = data.priority;
    if (data.remindMs !== null && data.remindMs !== undefined) {
      props.remindMeDate = new Date(data.remindMs);
    }
    if (data.url) props.body = (props.body ? props.body + '\\n\\n' : '') + data.url;
    const reminder = Reminders.Reminder(props);
    targetList.reminders.push(reminder);
    return reminder.id();
  `,
    { list, title, body, dueMs, url, priority, remindMs, allDay },
  );
}

/** Updates an existing reminder's title/due date/priority/alarm by its persistent id. */
export async function updateReminder({ id, title, body, dueMs, priority, remindMs, allDay = false }) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    const matches = Reminders.reminders.whose({ id: data.id })();
    if (matches.length === 0) return { updated: false };
    const reminder = matches[0];
    if (data.title !== undefined) reminder.name = data.title;
    if (data.body !== undefined) reminder.body = data.body;
    if (data.dueMs !== undefined) {
      const when = data.dueMs === null ? null : new Date(data.dueMs);
      if (data.allDay) reminder.alldayDueDate = when;
      else reminder.dueDate = when;
    }
    if (data.priority !== undefined) reminder.priority = data.priority;
    if (data.remindMs !== undefined) {
      reminder.remindMeDate = data.remindMs === null ? null : new Date(data.remindMs);
    }
    return { updated: true };
  `,
    { id, title, body, dueMs, priority, remindMs, allDay },
  );
}

/** Marks a reminder completed/uncompleted by its persistent id. */
export async function setCompleted({ id, completed }) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    const matches = Reminders.reminders.whose({ id: data.id })();
    if (matches.length === 0) return { updated: false };
    matches[0].completed = data.completed;
    return { updated: true };
  `,
    { id, completed },
  );
}

/** Returns the persistent ids of every reminder currently in a list (any completion state). */
export async function findReminderIds(list) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    const lists = Reminders.lists.whose({ name: data.list })();
    if (lists.length === 0) return [];
    return lists[0].reminders().map(r => r.id());
  `,
    { list },
  );
}

/** Returns the ids of reminders in a list that are marked completed. */
export async function completedIds(list) {
  return runJxa(
    `
    const Reminders = Application('Reminders');
    const lists = Reminders.lists.whose({ name: data.list })();
    if (lists.length === 0) return [];
    return lists[0].reminders.whose({ completed: true })().map(r => r.id());
  `,
    { list },
  );
}

export { runJxa as _runJxa };
