import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig, ConfigError, redact } from './config.js';
import { MoodleClient, MoodleError } from './moodle/client.js';
import { mintToken, promptHidden } from './moodle/auth.js';
import { getSiteInfo, fetchActionEvents } from './moodle/tasks.js';
import { fetchIcalTasks } from './moodle/ical.js';
import { dedupeTasks } from './model/task.js';
import { renderTerminal } from './render/terminal.js';
import { renderJson } from './render/json.js';
import { planSync, applySync } from './reminders/sync.js';
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
    return fetchIcalTasks(cfg.icalUrl);
  }

  if (!cfg.token) {
    throw new ConfigError('MOODLE_TOKEN is not set. Run `moodle-tasks --login` first, or set MOODLE_ICAL_URL and pass --source ical.');
  }
  const client = new MoodleClient({ moodleUrl: cfg.moodleUrl, token: cfg.token, secrets: cfg.secrets });
  log('Fetching tasks via Moodle web services...');
  return fetchActionEvents(client, { from, to });
}

function filterByCourse(tasks, courseFilter) {
  if (!courseFilter) return tasks;
  const needle = courseFilter.toLowerCase();
  return tasks.filter((t) => t.course && t.course.toLowerCase().includes(needle));
}

async function runFetch(opts) {
  const cfg = loadConfig();
  const log = opts.json ? (...args) => console.error(...args) : (...args) => console.log(...args);

  let tasks = await fetchTasks(cfg, { source: opts.source, days: opts.days ?? cfg.lookaheadDays, log });
  tasks = dedupeTasks(tasks);
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
      await syncReminders(tasks, cfg, { dryRun: opts.dryRun, log });
    } catch (err) {
      log(`Reminders-Sync fehlgeschlagen: ${err.message}`);
    }
  } else if (opts.sync !== false && process.platform !== 'darwin') {
    log('(Reminders-Sync übersprungen: nur unter macOS verfügbar.)');
  }
}

async function syncReminders(tasks, cfg, { dryRun, log }) {
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
  const plan = planSync(tasks, state, { existingReminderIds });

  if (dryRun) {
    log('');
    log(`[dry-run] würde ${plan.create.length} erstellen, ${plan.update.length} aktualisieren, ${plan.skip.length} überspringen.`);
    for (const t of plan.create) log(`  + create: ${t.title}`);
    for (const t of plan.update) log(`  ~ update: ${t.title}`);
    return;
  }

  const result = await applySync(plan, { listName: cfg.remindersList, state });
  await saveState(result.state);
  if (result.created.length > 0) {
    log(`Zu Reminders hinzugefügt: ${result.created.map((t) => t.title).join(', ')}`);
    await notify(`${result.created.length} neue Aufgabe(n) zu "${cfg.remindersList}" hinzugefügt`);
  }
  for (const e of result.errors) log(`Reminders-Fehler: ${e.message}`);
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
