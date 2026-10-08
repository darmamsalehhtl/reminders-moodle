import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/** Thrown for anything the user needs to fix (missing/invalid config, auth). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Masks a secret so it is safe to print/log, keeping only a short prefix
 * and suffix. "deadbeefdeadbeefdeadbeefdeadbeef" -> "dead…beef".
 */
export function redact(secret) {
  if (!secret) return '(unset)';
  const s = String(secret);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Strips any known secret values out of an arbitrary string, so error
 * messages and stack traces can be logged/printed without leaking the
 * Moodle token even if it ends up embedded in a URL or response body.
 */
export function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(redact(secret));
  }
  return out;
}

/** Parses a 0/1/true/false/yes/no env value, falling back to `def` when unset. */
function flag(value, def) {
  if (value === undefined || value === '') return def;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

/**
 * Parses a numeric env value, falling back to `def` when unset. Throws for
 * anything that isn't a non-negative finite number, so a typo surfaces as a
 * config error instead of a silent NaN that makes every date comparison
 * false and quietly mis-buckets every task.
 */
function number(name, value, def) {
  if (value === undefined || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative number: "${value}"`);
  }
  return n;
}

/** Splits a comma-separated env value into trimmed, non-empty entries. */
function list(value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Loads and validates configuration from process.env (populated from .env
 * via dotenv). Returns null fields instead of throwing where a value is
 * merely optional (e.g. MOODLE_TOKEN before the first --login run).
 */
export function loadConfig({ envPath, env = process.env } = {}) {
  loadDotenv({ path: envPath ?? path.join(projectRoot, '.env'), quiet: true });
  const e = env;

  const url = e.MOODLE_URL;
  if (!url) {
    throw new ConfigError(
      'MOODLE_URL is not set. Copy .env.example to .env and fill it in.',
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`MOODLE_URL is not a valid URL: "${url}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`MOODLE_URL must be http(s): "${url}"`);
  }

  const token = e.MOODLE_TOKEN || null;
  const userId = e.MOODLE_USER_ID ? Number(e.MOODLE_USER_ID) : null;
  if (e.MOODLE_USER_ID && !Number.isInteger(userId)) {
    throw new ConfigError(`MOODLE_USER_ID must be an integer: "${e.MOODLE_USER_ID}"`);
  }

  const soonDays = number('SOON_DAYS', e.SOON_DAYS, 3);
  const lookaheadDays = number('LOOKAHEAD_DAYS', e.LOOKAHEAD_DAYS, 30);
  const remindersList = e.REMINDERS_LIST || 'Schulaufgaben';
  const alarmLeadHours = number('ALARM_LEAD_HOURS', e.ALARM_LEAD_HOURS, 24);
  const coursePrefix = flag(e.COURSE_PREFIX, true);
  const digest = flag(e.DIGEST, true);
  const ignoreCourses = list(e.IGNORE_COURSES);
  const ignoreTitles = list(e.IGNORE_TITLES);

  return {
    moodleUrl: normalizeUrl(url),
    token,
    userId,
    icalUrl: e.MOODLE_ICAL_URL || null,
    soonDays,
    lookaheadDays,
    remindersList,
    alarmLeadHours,
    coursePrefix,
    digest,
    ignoreCourses,
    ignoreTitles,
    envPath: envPath ?? path.join(projectRoot, '.env'),
    /** All secret values that must never be printed verbatim. */
    secrets: [token].filter(Boolean),
  };
}

export { projectRoot };
