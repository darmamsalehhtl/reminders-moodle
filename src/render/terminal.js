import { Chalk } from 'chalk';
import { taskStatus, sortTasks } from '../model/task.js';

const days = (n) => `${n} ${n === 1 ? 'Tag' : 'Tage'}`;

// The soon/later labels are built from the configured soonDays, so a header
// can never claim a different cutoff than the one tasks were bucketed by.
const BUCKET_META = {
  overdue: { icon: '\u{1F534}', label: () => 'ÜBERFÄLLIG', color: 'red' },
  soon: { icon: '\u{1F7E1}', label: (d) => `BALD FÄLLIG (< ${days(d)})`, color: 'yellow' },
  later: { icon: '\u{1F7E2}', label: (d) => `NOCH ZEIT (> ${days(d)})`, color: 'green' },
  // The variation selector forces emoji presentation, so the icon's string
  // length matches the two columns the terminal actually draws (the other
  // icons are surrogate pairs and already measure as 2).
  undated: { icon: '⚪️', label: () => 'OHNE FÄLLIGKEITSDATUM', color: 'gray' },
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDate(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function formatDateTime(date) {
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function relativeDays(task, now) {
  if (!task.due) return '';
  const diffMs = task.due.getTime() - now.getTime();
  const days = Math.round(Math.abs(diffMs) / (24 * 60 * 60 * 1000));
  if (diffMs < 0) {
    return days === 0 ? '(heute fällig)' : `(${days} ${days === 1 ? 'Tag' : 'Tage'} überfällig)`;
  }
  if (days === 0) return '(heute fällig)';
  return `(in ${days} ${days === 1 ? 'Tag' : 'Tagen'})`;
}

/**
 * Renders the boxed terminal view described in the project brief. Colors
 * are applied per-bucket (red/yellow/green/gray) and automatically disabled
 * by chalk when stdout isn't a TTY or NO_COLOR is set; `noColor: true`
 * forces that off explicitly for --no-color.
 */
export function renderTerminal(tasks, { now = new Date(), soonDays = 3, noColor = false } = {}) {
  const c = new Chalk({ level: noColor ? 0 : undefined });
  const sorted = sortTasks(tasks, { now, soonDays });
  const width = 66;
  const lines = [];

  const top = `╔${'═'.repeat(width)}╗`;
  const bottom = `╚${'═'.repeat(width)}╝`;
  const sep = `╠${'═'.repeat(width)}╣`;

  const title = '\u{1F4DA} DEINE OFFENEN AUFGABEN';
  lines.push(c.bold(top));
  lines.push(`║${centerLine(title, width)}║`);
  lines.push(sep);

  if (sorted.length === 0) {
    lines.push(`║${' '.repeat(width)}║`);
    lines.push(`║${padLine('  Keine offenen Aufgaben – alles erledigt! ✅', width)}║`);
    lines.push(`║${' '.repeat(width)}║`);
  } else {
    let currentBucket = null;
    for (const task of sorted) {
      const bucket = taskStatus(task, { now, soonDays });
      if (bucket !== currentBucket) {
        if (currentBucket !== null) lines.push(`║${' '.repeat(width)}║`);
        currentBucket = bucket;
        const meta = BUCKET_META[bucket];
        const header = c[meta.color].bold(` ${meta.icon} ${meta.label(soonDays)}`);
        lines.push(`║${padLine(header, width)}║`);
        lines.push(`║${' '.repeat(width)}║`);
      }
      lines.push(`║${padLine(`  ${task.title}`, width)}║`);
      if (task.course) lines.push(`║${padLine(`  Kurs: ${task.course}`, width)}║`);
      if (task.due) {
        lines.push(`║${padLine(`  Fällig: ${formatDate(task.due)} ${relativeDays(task, now)}`, width)}║`);
      }
      if (task.url) lines.push(`║${padLine('  Link: [Aufgabe anzeigen]', width)}║`);
    }
    lines.push(`║${' '.repeat(width)}║`);
  }

  lines.push(c.bold(bottom));
  lines.push('');
  lines.push(`Insgesamt: ${sorted.length} offene Aufgabe${sorted.length === 1 ? '' : 'n'} | Zuletzt aktualisiert: ${formatDateTime(now)}`);

  return lines.join('\n');
}

// Pads a (possibly ANSI-colored) line to `width` visible columns. Strips
// ANSI escapes before measuring so color codes don't throw off alignment.
function visibleLength(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\[[0-9;]*m/g, '').length;
}

function padLine(str, width) {
  const pad = Math.max(0, width - visibleLength(str));
  return str + ' '.repeat(pad);
}

function centerLine(str, width) {
  const len = visibleLength(str);
  const totalPad = Math.max(0, width - len);
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}
