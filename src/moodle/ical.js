import { stableId } from '../model/task.js';
import { MoodleNetworkError, MoodleProtocolError } from './client.js';

/**
 * Minimal iCalendar (RFC 5545) VEVENT parser, purpose-built for Moodle's
 * calendar export. This is not a general-purpose iCal parser: it handles
 * exactly what Moodle emits (folded lines, CRLF, DTSTART with or without
 * TZID, all-day DATE values, UID/SUMMARY/URL/CATEGORIES/DESCRIPTION) and
 * nothing more - no RRULE expansion, no VALARM, no VTIMEZONE resolution.
 * A ~60-line parser tailored to that shape is more predictable here than
 * pulling in a general dependency and fighting its timezone handling.
 */

/** Unfolds CRLF/LF + leading-whitespace continuation lines per RFC 5545 3.1. */
function unfoldLines(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .reduce((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length > 0) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
      return lines;
    }, []);
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Parses a DTSTART/DTEND value (with optional ;VALUE=DATE or ;TZID=... params) to a Date. */
function parseIcalDate(params, value) {
  const isDateOnly = /VALUE=DATE(?!-TIME)/.test(params) || /^\d{8}$/.test(value);
  if (isDateOnly) {
    const y = Number(value.slice(0, 4));
    const mo = Number(value.slice(4, 6));
    const d = Number(value.slice(6, 8));
    return new Date(Date.UTC(y, mo - 1, d));
  }
  // YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  // No explicit UTC marker and (for Moodle's export) no VTIMEZONE resolution
  // implemented - treat as local time, which matches what most calendar
  // apps do as a fallback and is close enough for a "due in N days" view.
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

/** Best-effort course-name extraction from Moodle's SUMMARY/DESCRIPTION text. */
function guessCourse(summary, description) {
  // Moodle often formats calendar summaries as "Fällig: <Coursename> - <Task title>"
  // or includes the course name in parentheses; neither is guaranteed, so
  // this is explicitly a guess (courseGuessed: true), not a parsed field.
  const parenMatch = summary.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) return parenMatch[1];
  const dashMatch = summary.match(/^([^:]{2,60}):\s*/);
  if (dashMatch) return dashMatch[1];
  return null;
}

function parseVEvents(text) {
  const lines = unfoldLines(text);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const rawKey = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const [name, ...paramParts] = rawKey.split(';');
    const params = paramParts.join(';');

    switch (name) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.summary = unescapeText(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value);
        break;
      case 'URL':
        current.url = value;
        break;
      case 'DTSTART':
        current.dtstart = parseIcalDate(params, value);
        break;
      case 'CATEGORIES':
        current.categories = unescapeText(value);
        break;
      default:
        break;
    }
  }

  return events;
}

/** Maps a parsed VEVENT to the shared Task shape. */
function eventToTask(event) {
  const summary = event.summary ?? '(ohne Titel)';
  const description = event.description ?? '';
  const course = event.categories || guessCourse(summary, description);
  const due = event.dtstart ?? null;

  return {
    id: event.uid ? `ical:${event.uid}` : stableId('ical', { title: summary, course, due }),
    kind: 'task',
    source: 'ical',
    title: summary,
    course,
    courseGuessed: !event.categories && Boolean(course),
    description,
    url: event.url ?? null,
    due,
    raw: event,
  };
}

/**
 * Fetches and parses a Moodle calendar export URL
 * (Kalender -> Kalender exportieren -> "Interne Kalender-URL"). Used as a
 * fallback when the web service token/route is unavailable.
 */
export async function fetchIcalTasks(icalUrl, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(icalUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new MoodleNetworkError(
      timedOut ? `iCal export request timed out after ${timeoutMs}ms.` : `Could not reach Moodle calendar export: ${err.message}`,
      { cause: err },
    );
  }

  const text = await response.text();
  if (!response.ok || !text.includes('BEGIN:VCALENDAR')) {
    throw new MoodleProtocolError(
      `Calendar export URL did not return valid iCal data (HTTP ${response.status}). ` +
        'Check that MOODLE_ICAL_URL is the "Interne Kalender-URL" from Moodle > Kalender > Kalender exportieren.',
    );
  }

  return parseVEvents(text).map(eventToTask);
}

export { parseVEvents as _parseVEvents, eventToTask as _eventToTask, guessCourse as _guessCourse };
