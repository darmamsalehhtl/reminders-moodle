import readline from 'node:readline';
import { MoodleError, MoodleNetworkError, MoodleProtocolError } from './client.js';

const TOKEN_PATH = '/login/token.php';
const SERVICE = 'moodle_mobile_app';

/**
 * Prompts for a password on stdin without echoing it back to the terminal.
 * Falls back to a visible prompt when stdin isn't a TTY (e.g. piped input
 * in tests), rather than hanging forever waiting for raw-mode input.
 */
export function promptHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY) {
      const rl = readline.createInterface({ input, output, terminal: false });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '': // Ctrl-D
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          resolve(value);
          break;
        case '': // Ctrl-C
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          process.exit(130);
          break;
        case '': // Backspace
        case '\b':
          value = value.slice(0, -1);
          break;
        default:
          value += char;
      }
    };
    input.on('data', onData);
  });
}

/**
 * Exchanges a username/password for a persistent web service token via
 * Moodle's /login/token.php. This is a one-time bootstrap step - the
 * resulting token is what every other call in this project uses, so the
 * password itself is never stored.
 */
export async function mintToken({ moodleUrl, username, password, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const url = `${moodleUrl}${TOKEN_PATH}`;
  const body = new URLSearchParams({ username, password, service: SERVICE });

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new MoodleNetworkError(
      timedOut ? `Login request timed out after ${timeoutMs}ms.` : `Could not reach Moodle server: ${err.message}`,
      { cause: err },
    );
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MoodleProtocolError(
      `Expected JSON from login/token.php but got something else. First 200 chars: ${text.slice(0, 200)}`,
    );
  }

  if (json.error) {
    const hint =
      json.errorcode === 'invalidlogin'
        ? 'Username or password was rejected.'
        : json.errorcode === 'missingparam'
          ? 'Server rejected the request as malformed - this is a bug, please report it.'
          : '';
    throw new MoodleError([json.error, hint].filter(Boolean).join(' '), { code: json.errorcode });
  }

  if (!json.token) {
    throw new MoodleProtocolError('Login succeeded but no token was returned.');
  }

  return json.token;
}
