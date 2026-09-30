import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig, ConfigError, redact } from './config.js';
import { MoodleClient, MoodleError } from './moodle/client.js';
import { mintToken, promptHidden } from './moodle/auth.js';
import { getSiteInfo, fetchActionEvents } from './moodle/tasks.js';
import { fetchIcalTasks } from './moodle/ical.js';
import { dedupeTasks, applyIgnore } from './model/task.js';
import { renderTerminal } from './render/terminal.js';
import { renderJson } from './render/json.js';
import { planSync, applySync, applyCompletions } from './reminders/sync.js';
import { buildView } from './reminders/policy.js';
import { resolveModule, isSubmitted, FN_EVENT_BY_ID, FN_COURSE_MODULE, FN_SUBMISSION_STATUS } from './moodle/submissions.js';
import { findReminderIds } from './reminders/jxa.js';
import { loadState, saveState } from './state/store.js';
import { notify } from './notify.js';

/** Exit codes, documented in the plan: 0 ok, 1 unexpected, 2 config/auth, 3 network. */
export const EXIT = { OK: 0, UNEXPECTED: 1, CONFIG: 2, NETWORK: 3 };

function classifyError(err) {
  if (err instanceof ConfigError) return EXIT.CONFIG;
  if (err?.name === 'MoodleApiError' && ['invalidtoken', 'invalidlogin', 'accessexception'].includes(err.errorcode)) {
    return EXIT.CONFIG;
  }
  if (err?.name === 'MoodleNetworkError' || err?.name === 'MoodleProtocolError') return EXIT.NETWORK;
  return EXIT.UNEXPECTED;
}

async function fetchTasks(cfg, { source, days, log }) {
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const useIcal = source === 'ical' || (!source && !cfg.token && cfg.icalUrl);

  if (useIcal) {
    if (!cfg.icalUrl) {
      throw new ConfigError('MOODLE_ICAL_URL is not set. Copy the Moodle calendar export URL into .env, or run --login to use the web service instead.');
    }
    log('Fetching tasks via iCal calendar export...');
    return { tasks: await fetchIcalTasks(cfg.icalUrl), client: null };
  }

  if (!cfg.token) {
    throw new ConfigError('MOODLE_TOKEN is not set. Run `moodle-tasks --login` first, or set MOODLE_ICAL_URL and pass --source ical.');
  }
  const client = new MoodleClient({ moodleUrl: cfg.moodleUrl, token: cfg.token, secrets: cfg.secrets });
  log('Fetching tasks via Moodle web services...');
  return { tasks: await fetchActionEvents(client, { from, to }), client };
}

function filterByCourse(tasks, courseFilter) {
  if (!courseFilter) return tasks;
  const needle = courseFilter.toLowerCase();
  return tasks.filter((t) => t.course && t.course.toLowerCase().includes(needle));
}

async function runFetch(opts) {
  const cfg = loadConfig();
  const log = opts.json ? (...args) => console.error(...args) : (...args) => console.log(...args);

  const fetched = await fetchTasks(cfg, { source: opts.source, days: opts.days ?? cfg.lookaheadDays, log });
  const client = fetched.client;
  let tasks = dedupeTasks(fetched.tasks);
  // Ids of the whole feed, before --course filtering: a task hidden by the
  // filter must not look like it vanished (i.e. was handed in).
  const feedIds = new Set(tasks.map((t) => t.id));
  // Ignored tasks stay in `feedIds` above, so hiding one can never make it
  // look like a submitted (vanished) assignment.
  tasks = applyIgnore(tasks, { courses: cfg.ignoreCourses, titles: cfg.ignoreTitles });
  tasks = filterByCourse(tasks, opts.course);

  const soonDays = cfg.soonDays;

  if (opts.json) {
    console.log(renderJson(tasks, { soonDays }));
  } else {
    console.log(renderTerminal(tasks, { soonDays, noColor: opts.color === false }));
  }

  const shouldSync = opts.sync !== false && process.platform === 'darwin';
  if (shouldSync) {
    // A Reminders/AppleScript failure (app not running, automation not yet
    // authorized, ...) must never turn a successful task fetch into a
    // failed run - it's reported and the process still exits 0.
    try {
      await syncReminders(tasks, cfg, { dryRun: opts.dryRun, log, client, feedIds });
    } catch (err) {
      log(`Reminders-Sync fehlgeschlagen: ${err.message}`);
    }
  } else if (opts.sync !== false && process.platform !== 'darwin') {
    log('(Reminders-Sync übersprungen: nur unter macOS verfügbar.)');
  }
}

/**
 * Of the synced tasks that vanished from the feed, returns those Moodle
 * confirms as handed in. Vanishing alone is not proof (deadline moved out
 * of the window, event deleted), so each candidate is checked. Errors on a
 * single task are logged and retried on the next run.
 */
async function verifySubmitted(candidates, client, log) {
  const verified = [];
  for (const cand of candidates) {
    const { taskId, entry } = cand;
    try {
      let mod = entry.modulename && entry.instance ? entry : null;
      if (!mod) {
        const eventId = Number(taskId.slice('ws:'.length));
        if (!Number.isInteger(eventId)) continue;
        mod = await resolveModule(client, eventId);
        if (!mod) {
          log(`Abgabestatus für ${entry.title ?? taskId} unbekannt (Modul nicht auffindbar).`);
          continue;
        }
        cand.entry = { ...entry, modulename: mod.modulename, instance: mod.instance };
      }
      const submitted = await isSubmitted(client, mod);
      if (submitted === true) verified.push(cand);
      else if (submitted === null) log(`Abgabestatus für ${entry.title ?? taskId} unbekannt.`);
    } catch (err) {
      log(`Abgabestatus für ${entry.title ?? taskId} nicht prüfbar: ${err.message}`);
    }
  }
  return verified;
}

async function syncReminders(tasks, cfg, { dryRun, log, client, feedIds }) {
  const state = await loadState();
  // Existing reminder ids tell the planner which of *our* previously
  // synced reminders the user deleted on purpose (see reminders/sync.js);
  // a missing Reminders list just means "nothing exists yet" - not an error.
  let existingReminderIds;
  try {
    existingReminderIds = new Set(await findReminderIds(cfg.remindersList));
  } catch {
    existingReminderIds = undefined;
  }
  // One clock reading per run so every task's priority/alarm is computed
  // against the same "now".
  const now = new Date();
  const decorate = (task) =>
    buildView(task, { now, soonDays: cfg.soonDays, leadHours: cfg.alarmLeadHours, prefix: cfg.coursePrefix });
  const plan = planSync(tasks, state, { existingReminderIds, feedIds, decorate });

  let verified = [];
  if (client && plan.completionCandidates.length > 0) {
    verified = await verifySubmitted(plan.completionCandidates, client, log);
  } else if (!client) {
    log('(Automatisches Abhaken übersprungen: braucht die Web-Service-Quelle, nicht iCal.)');
  }

  if (dryRun) {
    log('');
    log(`[dry-run] würde ${plan.create.length} erstellen, ${plan.update.length} aktualisieren, ${plan.skip.length} überspringen.`);
    for (const t of plan.create) log(`  + create: ${t.title}`);
    for (const { task } of plan.update) log(`  ~ update: ${task.title}`);
    for (const { entry, taskId } of verified) log(`  ✓ complete: ${entry.title ?? taskId}`);
    for (const { task } of plan.reopen) log(`  ↺ reopen: ${task.title}`);
    return;
  }

  const result = await applySync(plan, { listName: cfg.remindersList, state, decorate });
  const done = await applyCompletions(verified, { state: result.state });
  await saveState(done.state);
  if (result.created.length > 0) {
    log(`Zu Reminders hinzugefügt: ${result.created.map((t) => t.title).join(', ')}`);
    await notify(`${result.created.length} neue Aufgabe(n) zu "${cfg.remindersList}" hinzugefügt`);
  }
  if (done.completed.length > 0) {
    log(`Als erledigt abgehakt: ${done.completed.map((t) => t.title).join(', ')}`);
    await notify(`${done.completed.length} abgegebene Aufgabe(n) abgehakt`);
  }
  if (result.reopened.length > 0) {
    log(`Wieder geöffnet (Abgabe zurückgezogen): ${result.reopened.map((t) => t.title).join(', ')}`);
  }
  for (const e of [...result.errors, ...done.errors]) log(`Reminders-Fehler: ${e.message}`);
}

async function runLogin() {
  const cfg = loadConfig();
  const username = await promptHidden('Moodle-Benutzername: ', { input: process.stdin, output: process.stdout });
  const password = await promptHidden('Moodle-Passwort: ', { input: process.stdin, output: process.stdout });

  const token = await mintToken({ moodleUrl: cfg.moodleUrl, username, password });
  const client = new MoodleClient({ moodleUrl: cfg.moodleUrl, token, secrets: [token] });
  const info = await getSiteInfo(client);

  writeEnvValue(cfg.envPath, 'MOODLE_TOKEN', token);
  writeEnvValue(cfg.envPath, 'MOODLE_USER_ID', String(info.userId));

  console.log(`Angemeldet als Benutzer #${info.userId} auf "${info.siteName}".`);
  console.log(`Token gespeichert in ${cfg.envPath} (${redact(token)}).`);
}

/** Writes/updates a single KEY=value line in a .env file, preserving the rest. */
function writeEnvValue(envPath, key, value) {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  const prefix = `${key}=`;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${prefix}${value}`;
    }
    return line;
  });
  if (!found) next.push(`${prefix}${value}`);
  writeFileSync(envPath, next.join('\n'), { mode: 0o600 });
}

async function runDoctor() {
  const cfg = loadConfig();
  console.log(`MOODLE_URL:      ${cfg.moodleUrl}`);
  console.log(`MOODLE_TOKEN:    ${redact(cfg.token)}`);
  console.log(`MOODLE_USER_ID:  ${cfg.userId ?? '(unset)'}`);
  console.log(`MOODLE_ICAL_URL: ${cfg.icalUrl ? '(set)' : '(unset)'}`);
  console.log('');

  if (!cfg.token) {
    console.log('❌ No token configured. Run `moodle-tasks --login`.');
    return;
  }

  const client = new MoodleClient({ moodleUrl: cfg.moodleUrl, token: cfg.token, secrets: cfg.secrets });
  const info = await getSiteInfo(client);
  console.log(`✅ Token is valid. User #${info.userId} on "${info.siteName}".`);
  const hasCalendarFn = info.functions.includes('core_calendar_get_action_events_by_timesort');
  console.log(
    hasCalendarFn
      ? '✅ core_calendar_get_action_events_by_timesort is available.'
      : '❌ core_calendar_get_action_events_by_timesort is NOT exposed to this token – use --source ical.',
  );

  for (const fn of [FN_EVENT_BY_ID, FN_COURSE_MODULE, FN_SUBMISSION_STATUS]) {
    console.log(
      info.functions.includes(fn)
        ? `✅ ${fn} is available (auto check-off).`
        : `⚠️  ${fn} is NOT exposed – submitted assignments won't be checked off automatically.`,
    );
  }

  if (process.platform === 'darwin') {
    console.log('✅ Running on macOS – Reminders sync available.');
  } else {
    console.log('⚠️  Not running on macOS – Reminders sync will be skipped.');
  }
}

export function buildProgram() {
  const program = new Command();
  program
    .name('moodle-tasks')
    .description('Fetch open Moodle assignments and sync them into macOS Reminders.')
    .option('--json', 'output machine-readable JSON instead of the terminal view')
    .option('--days <n>', 'lookahead window in days', (v) => Number(v))
    .option('--course <substr>', 'only show courses whose name contains this text')
    .option('--source <ws|ical>', 'force a data source')
    .option('--no-sync', 'render only, do not touch Reminders')
    .option('--sync-reminders', 'explicit sync (alias for the default behavior)')
    .option('--dry-run', 'print the reminder sync plan without changing anything')
    .option('--no-color', 'disable colored output')
    .option('--login', 'interactively mint a new web service token')
    .option('--doctor', 'run connectivity/token/permission diagnostics')
    .action(async (opts) => {
      try {
        if (opts.login) {
          await runLogin();
        } else if (opts.doctor) {
          await runDoctor();
        } else {
          await runFetch(opts);
        }
        process.exitCode = EXIT.OK;
      } catch (err) {
        if (err instanceof MoodleError || err instanceof ConfigError) {
          console.error(`Fehler: ${err.message}`);
        } else {
          console.error(err);
        }
        process.exitCode = classifyError(err);
      }
    });
  return program;
}
