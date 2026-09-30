/**
 * Summarizes the sync state file for `--status`: how many tasks are
 * tracked, how many were ticked off after submission, how many the user
 * deleted on purpose, and when things last happened.
 */
export function summarizeState(state) {
  const entries = Object.values(state.tasks ?? {});
  const latest = (field) => entries.map((e) => e[field]).filter(Boolean).sort().at(-1) ?? null;
  return {
    tracked: entries.length,
    completed: entries.filter((e) => e.completedAt).length,
    deletedByUser: entries.filter((e) => e.deletedByUser).length,
    active: entries.filter((e) => !e.completedAt && !e.deletedByUser).length,
    lastSyncedAt: latest('syncedAt'),
    lastCompletedAt: latest('completedAt'),
  };
}
