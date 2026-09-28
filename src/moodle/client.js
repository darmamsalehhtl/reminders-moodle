import { scrub } from '../config.js';

const REST_PATH = '/webservice/rest/server.php';
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [500, 2000];

/** Base class for everything that can go wrong talking to Moodle. */
export class MoodleError extends Error {
  constructor(message, { cause, code } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MoodleError';
    this.code = code ?? 'unknown';
  }
}

/** The server was unreachable, timed out, or returned a 5xx/429. */
export class MoodleNetworkError extends MoodleError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'MoodleNetworkError';
  }
}

/** Moodle answered with a well-formed { exception, errorcode, message }. */
export class MoodleApiError extends MoodleError {
  constructor(message, { errorcode, ...opts } = {}) {
    super(message, { ...opts, code: errorcode });
    this.name = 'MoodleApiError';
    this.errorcode = errorcode;
  }
}

/** The response wasn't JSON at all (login redirect, maintenance page, ...). */
export class MoodleProtocolError extends MoodleError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'MoodleProtocolError';
  }
}

const FRIENDLY_ERRORCODES = {
  invalidtoken:
    'The web service token is invalid or has been revoked. Run `moodle-tasks --login` to mint a new one.',
  accessexception:
    'The token does not have permission to call this function. Ask an admin to enable it for the "Moodle mobile web service", or use --source ical.',
  servicenotavailable:
    'The mobile web service is disabled on this Moodle install. Use --source ical instead.',
  invalidlogin: 'Username or password was rejected by the server.',
};

function friendlyMessage(errorcode, fallback) {
  return FRIENDLY_ERRORCODES[errorcode] ?? fallback;
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin transport for Moodle's Web Services REST protocol. Every call is a
 * POST with wstoken/wsfunction/moodlewsrestformat=json; Moodle signals
 * errors with HTTP 200 + a JSON body containing "exception", so callers
 * must inspect the body, not just the status code.
 */
export class MoodleClient {
  constructor({ moodleUrl, token, secrets = [], timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
    if (!moodleUrl) throw new Error('MoodleClient requires moodleUrl');
    this.moodleUrl = moodleUrl;
    this.token = token;
    this.secrets = secrets.length ? secrets : [token].filter(Boolean);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  _redactError(err) {
    if (err instanceof MoodleError) {
      err.message = scrub(err.message, this.secrets);
    }
    return err;
  }

  /**
   * Calls a Moodle web service function and returns the parsed JSON result.
   * @param {string} wsfunction
   * @param {Record<string, string|number|boolean>} params flat params; Moodle's
   *   array/object encoding (params[foo][0]=x) is the caller's job to build
   *   if a function ever needs it - none of ours currently do.
   */
  async call(wsfunction, params = {}) {
    if (!this.token) {
      throw new MoodleApiError(friendlyMessage('invalidtoken', 'No Moodle token configured.'), {
        errorcode: 'invalidtoken',
      });
    }

    const body = new URLSearchParams({
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: 'json',
    });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }

    const url = `${this.moodleUrl}${REST_PATH}`;
    let lastErr;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this._attempt(url, body, wsfunction);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof MoodleNetworkError;
        if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw this._redactError(lastErr);
  }

  async _attempt(url, body, wsfunction) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new MoodleNetworkError(
        timedOut
          ? `Request to Moodle timed out after ${this.timeoutMs}ms calling ${wsfunction}.`
          : `Could not reach Moodle server: ${err.message}`,
        { cause: err },
      );
    }

    if (isRetryableStatus(response.status)) {
      throw new MoodleNetworkError(
        `Moodle server returned HTTP ${response.status} calling ${wsfunction}.`,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw new MoodleProtocolError(
        `Moodle server returned HTTP ${response.status} calling ${wsfunction}.`,
      );
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MoodleProtocolError(
        `Expected JSON from ${wsfunction} but got something else ` +
          `(often means the login session/token is invalid and Moodle sent an HTML page instead). ` +
          `First 200 chars: ${text.slice(0, 200)}`,
      );
    }

    if (json && typeof json === 'object' && 'exception' in json) {
      throw new MoodleApiError(
        friendlyMessage(json.errorcode, json.message || `Moodle rejected the call to ${wsfunction}.`),
        { errorcode: json.errorcode },
      );
    }

    return json;
  }
}
