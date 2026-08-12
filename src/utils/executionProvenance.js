/**
 * executionProvenance.js
 *
 * TCV-6814 — tell TestCollab how a result was produced.
 *
 * Without this, a result uploaded by a pipeline and one typed in by a tester are the
 * same row, so nobody can say how much of a release was verified automatically. The
 * CLI already detects the CI provider for `tc createBuild`, so the same detection
 * supplies the provenance here at no extra cost.
 *
 * The server does not take the claim on trust — it derives the source from the
 * credential the request authenticated with and only lets a token-authenticated
 * caller refine it. Declaring `ci` from a laptop therefore records `api`, which is
 * the honest answer.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { detectCiEnvironment } from './ciEnvironment.js';

const TOOL_NAME = 'tc-cli';

let cachedVersion;

/** Read our own version from package.json, once. Never throws — provenance is a nicety. */
function toolVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '../../package.json');
    cachedVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch (e) {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * Build the provenance to send with each result.
 *
 * @param {object} options
 *   - buildId {number}  build the results are being reported against, when known
 *   - env {object}      process.env, or a stand-in for tests
 * @returns {{execution_source: string, execution_context: object}}
 */
export function buildExecutionProvenance({ buildId, env } = {}) {
  const detected = detectCiEnvironment(env || process.env);

  const context = { tool: TOOL_NAME };
  const version = toolVersion();
  if (version) context.tool_version = version;

  if (detected) {
    if (detected.provider) context.provider = detected.provider;
    if (detected.values && detected.values.deploymentUrl) {
      context.run_url = detected.values.deploymentUrl;
    }
  }
  if (buildId !== undefined && buildId !== null && String(buildId).trim()) {
    const numeric = Number(buildId);
    if (Number.isFinite(numeric)) context.build = numeric;
  }

  return {
    // Off a CI provider this is a person running the CLI by hand, which is `api`
    // rather than `ci`: a laptop run is not evidence of a maintained automated test.
    execution_source: detected ? 'ci' : 'api',
    execution_context: context
  };
}
