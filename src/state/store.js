import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.moodle-task-fetcher');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const VERSION = 1;

function emptyState() {
  return { version: VERSION, tasks: {} };
}

/** Loads the sync state, returning an empty state if none exists yet. */
export async function loadState(filePath = STATE_FILE) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.tasks) return emptyState();
    return { version: parsed.version ?? VERSION, tasks: parsed.tasks };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    // Corrupt state file: don't crash the whole run over sync bookkeeping,
    // just start fresh (worst case is a few duplicate reminders once).
    console.error(`Warning: could not read state file (${err.message}), starting fresh.`);
    return emptyState();
  }
}

/**
 * Writes state atomically (write to a temp file, then rename) so a crash or
 * concurrent run can never leave state.json half-written/corrupt.
 */
export async function saveState(state, filePath = STATE_FILE) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

export { STATE_FILE };
