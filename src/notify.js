import { execFile } from 'node:child_process';

/**
 * Shows a macOS notification banner via osascript's `display notification`.
 * Deliberately does NOT use Reminders' own `activate` (the brief's original
 * snippet did) - that steals window focus on every single run, which is
 * exactly the kind of thing that makes people disable a cron job.
 * No-ops silently on non-macOS or if osascript is unavailable for any
 * reason - a failed notification must never fail the underlying task fetch.
 */
export function notify(message, { title = 'Moodle Task Fetcher' } = {}) {
  if (process.platform !== 'darwin') return Promise.resolve();

  return new Promise((resolve) => {
    // Passed as separate argv entries (never interpolated into an -e
    // string) so message text with quotes can't break the script.
    execFile(
      'osascript',
      ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message],
      { timeout: 5000 },
      () => resolve(), // best-effort: ignore errors entirely
    );
  });
}
