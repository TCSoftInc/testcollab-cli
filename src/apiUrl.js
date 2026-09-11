/**
 * apiUrl.js
 *
 * Resolves the commander default for --api-url for every CLI command:
 * the explicit --api-url flag wins, then TESTCOLLAB_API_URL from the
 * environment (Agent containers always set it to the API that owns the
 * run), then the US production default. Mirrors how TESTCOLLAB_TOKEN
 * already works for --api-key.
 */

const DEFAULT_API_URL = 'https://api.testcollab.io';

export function defaultApiUrl() {
  return process.env.TESTCOLLAB_API_URL || DEFAULT_API_URL;
}
