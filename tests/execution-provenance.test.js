/**
 * TCV-6814 — provenance the CLI attaches to each reported result.
 *
 * The server re-derives execution_source from the credential used, so what the CLI
 * sends can only refine it. What matters here is that the CLI is honest about where
 * it is running: on a CI provider it says `ci`, on a developer's laptop it says `api`,
 * because a hand-run upload is not evidence of a maintained automated test.
 */
import { describe, expect, test } from '@jest/globals';

import { buildExecutionProvenance } from '../src/utils/executionProvenance.js';

const AZURE = {
  TF_BUILD: 'True',
  BUILD_BUILDNUMBER: '1.0.20260812.2',
  BUILD_BUILDID: '55',
  BUILD_SOURCEVERSION: '752393478cea8d0b88c624bd88509a100bd25849',
  BUILD_REPOSITORY_URI: 'https://abhi0498@dev.azure.com/abhi0498/abhi-personal/_git/abhi-personal',
  SYSTEM_COLLECTIONURI: 'https://dev.azure.com/abhi0498/',
  SYSTEM_TEAMPROJECT: 'abhi-personal'
};

describe('buildExecutionProvenance', () => {
  test('reports ci with the provider and run URL when on a CI provider', () => {
    const p = buildExecutionProvenance({ env: AZURE, buildId: 16 });
    expect(p.execution_source).toBe('ci');
    expect(p.execution_context.provider).toBe('Azure DevOps');
    expect(p.execution_context.run_url).toBe(
      'https://dev.azure.com/abhi0498/abhi-personal/_build/results?buildId=55'
    );
    expect(p.execution_context.build).toBe(16);
  });

  test('reports api, not ci, when run off a CI provider', () => {
    // A laptop run must not be able to inflate automation coverage.
    const p = buildExecutionProvenance({ env: { HOME: '/Users/abhi' } });
    expect(p.execution_source).toBe('api');
    expect(p.execution_context).not.toHaveProperty('provider');
    expect(p.execution_context).not.toHaveProperty('run_url');
  });

  test('always identifies the tool and its version', () => {
    const p = buildExecutionProvenance({ env: AZURE });
    expect(p.execution_context.tool).toBe('tc-cli');
    expect(typeof p.execution_context.tool_version).toBe('string');
    expect(p.execution_context.tool_version.length).toBeGreaterThan(0);
  });

  test('omits build rather than sending a null or unparseable one', () => {
    expect(buildExecutionProvenance({ env: AZURE })).not.toHaveProperty(
      'execution_context.build'
    );
    const p = buildExecutionProvenance({ env: AZURE, buildId: 'not-a-number' });
    expect(p.execution_context).not.toHaveProperty('build');
  });

  test('survives an empty environment', () => {
    const p = buildExecutionProvenance({ env: {} });
    expect(p.execution_source).toBe('api');
    expect(p.execution_context.tool).toBe('tc-cli');
  });
});
