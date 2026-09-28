import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Portable fallback scheduler for non-macOS systems (or anyone who'd rather
// not touch launchd). Only reachable via `npm run schedule`; the
// recommended path documented in the README is `launchd/install.sh`
// because this only runs while the node process itself stays alive - see
// launchd/install.sh's header comment for why that matters for a daily job.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(__dirname, '..', '..', 'bin', 'moodle-tasks.js');

const schedule = process.env.MOODLE_TASKS_CRON || '0 8 * * *'; // daily at 08:00

function runOnce() {
  const child = spawn(process.execPath, [binPath], { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`moodle-tasks exited with code ${code}`);
    }
  });
}

console.log(`Scheduling moodle-tasks with cron expression "${schedule}" (override via MOODLE_TASKS_CRON).`);
console.log('This process must keep running for the schedule to fire - see launchd/install.sh for a persistent alternative.');

cron.schedule(schedule, runOnce);

// Also run once immediately so the first daily fetch doesn't wait up to 24h.
runOnce();
