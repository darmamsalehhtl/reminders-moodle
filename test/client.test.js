import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoodleClient, MoodleApiError, MoodleNetworkError, MoodleProtocolError } from '../src/moodle/client.js';

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';

test('call() returns the parsed JSON body on success', async () => {
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: 'abc',
    fetchImpl: async () => new Response(JSON.stringify({ events: [] }), { status: 200 }),
  });
  assert.deepEqual(await client.call('foo'), { events: [] });
});

test('call() maps a Moodle exception body to a MoodleApiError with a friendly message', async () => {
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ exception: 'x', errorcode: 'invalidtoken', message: 'bad' }), { status: 200 }),
  });
  await assert.rejects(client.call('foo'), (err) => {
    assert.ok(err instanceof MoodleApiError);
    assert.equal(err.errorcode, 'invalidtoken');
    assert.match(err.message, /--login/);
    return true;
  });
});

test('call() retries network errors with backoff before giving up', async () => {
  let attempts = 0;
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: TOKEN,
    fetchImpl: async () => {
      attempts++;
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(client.call('foo'), MoodleNetworkError);
  assert.equal(attempts, 3); // initial attempt + 2 retries
});

test('call() retries a 503 the same as a network error', async () => {
  let attempts = 0;
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: TOKEN,
    fetchImpl: async () => {
      attempts++;
      return new Response('unavailable', { status: 503 });
    },
  });
  await assert.rejects(client.call('foo'), MoodleNetworkError);
  assert.equal(attempts, 3);
});

test('call() does not retry a plain 4xx (not 429)', async () => {
  let attempts = 0;
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: TOKEN,
    fetchImpl: async () => {
      attempts++;
      return new Response('forbidden', { status: 403 });
    },
  });
  await assert.rejects(client.call('foo'), MoodleProtocolError);
  assert.equal(attempts, 1);
});

test('call() raises MoodleProtocolError when the body is not JSON (e.g. an HTML login page)', async () => {
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: 'abc',
    fetchImpl: async () => new Response('<html>login</html>', { status: 200 }),
  });
  await assert.rejects(client.call('foo'), MoodleProtocolError);
});

test('call() redacts the token out of error messages', async () => {
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error(`network died near token ${TOKEN}`);
    },
  });
  await assert.rejects(client.call('foo'), (err) => {
    assert.ok(!err.message.includes(TOKEN));
    assert.match(err.message, /7358…6802/);
    return true;
  });
});

test('call() refuses to run without a token, without making a network call', async () => {
  let called = false;
  const client = new MoodleClient({
    moodleUrl: 'https://x',
    token: null,
    fetchImpl: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  await assert.rejects(client.call('foo'), MoodleApiError);
  assert.equal(called, false);
});
