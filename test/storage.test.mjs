import assert from 'node:assert/strict';
import test from 'node:test';
import { emailFromEntry } from '../dist/accounts/storage.js';

function jwt(payload) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const UUID_KEY = 'openai/f82dd384-bb79-4757-9cce-59ddffa9bd63';

test('backfills email from access token claims when the key holds a bare id', () => {
  const access = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'f82dd384' },
    'https://api.openai.com/profile': { email: 'user@example.com' },
  });
  assert.equal(
    emailFromEntry(UUID_KEY, { access, refresh: 'refresh' }),
    'user@example.com',
  );
});

test('prefers the email already present in the key', () => {
  assert.equal(
    emailFromEntry('openai/user@example.com', {
      access: 'not-a-jwt',
      refresh: 'refresh',
    }),
    'user@example.com',
  );
});

test('returns undefined when neither the key nor the token has an email', () => {
  const access = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'f82dd384' },
  });
  assert.equal(
    emailFromEntry(UUID_KEY, { access, refresh: 'refresh' }),
    undefined,
  );
});

test('returns undefined instead of throwing on non-JWT access tokens', () => {
  assert.equal(
    emailFromEntry(UUID_KEY, { access: 'opaque-token', refresh: 'refresh' }),
    undefined,
  );
});
