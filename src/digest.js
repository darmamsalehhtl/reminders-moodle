import { taskStatus, sortTasks } from './model/task.js';

const HOUR_MS = 60 * 60 * 1000;

/** "in 3 Std." / "in 2 Tagen" / "heute überfällig" style German phrase for a due date. */
function whenPhrase(due, now) {
  const diffMs = due.getTime() - now.getTime();
  const hours = Math.round(Math.abs(diffMs) / HOUR_MS);
  if (diffMs < 0) return hours < 24 ? `seit ${hours} Std. überfällig` : `seit ${Math.round(hours / 24)} Tg. überfällig`;
  if (hours < 24) return `in ${Math.max(hours, 1)} Std.`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'morgen' : `in ${days} Tagen`;
}

/**
 * One-line summary for the daily notification banner, or null when there is
 * nothing open (no banner is better than "0 offene Aufgaben" every morning).
 * e.g. "3 offen, 1 überfällig · Nächste: HÜ 5 (in 2 Tagen)".
 */
export function buildDigest(tasks, { now = new Date(), soonDays = 3 } = {}) {
  if (tasks.length === 0) return null;
  const overdue = tasks.filter((t) => taskStatus(t, { now, soonDays }) === 'overdue').length;
  const next = sortTasks(tasks, { now, soonDays }).find((t) => t.due);

  let text = `${tasks.length} offen`;
  if (overdue > 0) text += `, ${overdue} überfällig`;
  if (next) text += ` · Nächste: ${next.title} (${whenPhrase(next.due, now)})`;
  return text;
}
