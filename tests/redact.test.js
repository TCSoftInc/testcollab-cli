/**
 * Tests for redactToken(), which hides the API token in a message that repeats
 * a request URL.
 */

import { describe, expect, test } from '@jest/globals';

import { redactToken } from '../src/lib/redact.js';

describe('redactToken', () => {
  test('hides the token as it was put in the URL', () => {
    expect(
      redactToken('Failed to parse URL from api.test/bdd/sync?project=1&token=abc123', 'abc123')
    ).toBe('Failed to parse URL from api.test/bdd/sync?project=1&token=***');
  });

  test('hides the URI-encoded token', () => {
    const token = 'a+b/c=';
    expect(redactToken(`api.test/testplans/7?token=${encodeURIComponent(token)}`, token)).toBe(
      'api.test/testplans/7?token=***'
    );
  });

  test('leaves the message as it is when the token is not in it, or there is no token', () => {
    expect(redactToken('fetch failed', 'abc123')).toBe('fetch failed');
    expect(redactToken('fetch failed', '')).toBe('fetch failed');
  });
});
