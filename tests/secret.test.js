import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  describeSecret,
  exportSecrets,
  listSecrets,
  safeSecretCommandError,
  secretsFromManifest
} from '../src/commands/secret.js';

const SECRET_VALUE = 'never-print-this-password-7f31';
const API_VALUE = 'never-print-this-api-key-9c02';
const RUN_TOKEN = 'one-run-api-token';
const MANIFEST = JSON.stringify({
  id: 481,
  secrets: [
    {
      name: 'APP_LOGIN',
      environment: 'TC_SECRET_APP_LOGIN',
      fields: [{ value: SECRET_VALUE }],
      value: SECRET_VALUE,
      encrypted_value: SECRET_VALUE,
      arbitrary: { nested: SECRET_VALUE }
    },
    {
      name: 'API_LOGIN',
      environment: 'TC_SECRET_API_LOGIN'
    },
    {
      name: 'CORRUPT_SECRET',
      type: SECRET_VALUE,
      fields: []
    }
  ]
});
const GRANTED = {
  TC_SECRET_APP_LOGIN: SECRET_VALUE,
  TC_SECRET_API_LOGIN: API_VALUE
};

function manifestDependencies(overrides = {}) {
  return {
    environment: {
      TC_AGENT_RUN_ID: '481',
      TC_AGENT_RUN_MANIFEST: '/agent/run.json',
      TESTCOLLAB_TOKEN: RUN_TOKEN,
      TESTCOLLAB_API_URL: 'http://api.test'
    },
    readFile: jest.fn(() => MANIFEST),
    ...overrides
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function captureWrites() {
  const chunks = [];
  return {
    write: (chunk) => chunks.push(String(chunk)),
    value: () => chunks.join('')
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('secret metadata commands', () => {
  test('allowlists metadata and drops every value-bearing or unknown property', () => {
    const result = secretsFromManifest(JSON.parse(MANIFEST));

    expect(result).toEqual([
      {
        name: 'APP_LOGIN',
        environment: 'TC_SECRET_APP_LOGIN'
      },
      { name: 'API_LOGIN', environment: 'TC_SECRET_API_LOGIN' }
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(result)).not.toContain('encrypted_value');
    expect(JSON.stringify(result)).not.toContain('arbitrary');
  });

  test('preserves legacy name spelling and its supplied environment mapping', () => {
    const name = 'Mixed-case Login';
    const environment = 'TC_SECRET_ENCODED_' + Buffer.from(name, 'utf8').toString('hex').toUpperCase();
    expect(secretsFromManifest({ secrets: [{ name, environment, value: SECRET_VALUE }] }))
      .toEqual([{ name, environment }]);
  });

  test('list prints exact names only', () => {
    const output = [];

    listSecrets({}, manifestDependencies({ write: (line) => output.push(line) }));

    expect(output).toEqual([
      'APP_LOGIN',
      'API_LOGIN'
    ]);
    expect(output.join('\n')).not.toContain(SECRET_VALUE);
  });

  test('describe prints only normalized allowlisted metadata', () => {
    const output = [];

    describeSecret(
      'APP_LOGIN',
      {},
      manifestDependencies({ write: (line) => output.push(line) })
    );

    expect(JSON.parse(output.join(''))).toEqual({
      name: 'APP_LOGIN',
      environment: 'TC_SECRET_APP_LOGIN'
    });
    expect(output.join('')).not.toContain(SECRET_VALUE);
  });

  test('does not reflect a mistaken value supplied as a secret name', () => {
    let thrown;
    try {
      describeSecret(SECRET_VALUE, {}, manifestDependencies());
    } catch (error) {
      thrown = error;
    }

    expect(safeSecretCommandError(thrown)).toBe('Secret metadata was not found');
    expect(safeSecretCommandError(thrown)).not.toContain(SECRET_VALUE);
  });

  test('uses a fixed parse error which cannot include manifest contents', () => {
    const error = (() => {
      try {
        listSecrets(
          {},
          manifestDependencies({ readFile: () => `{ "password": "${SECRET_VALUE}"` })
        );
      } catch (caught) {
        return caught;
      }
      return null;
    })();

    expect(safeSecretCommandError(error)).toBe('The Agent run manifest is invalid');
    expect(safeSecretCommandError(error)).not.toContain(SECRET_VALUE);
  });
});

/**
 * `tc secret export` is run once by the Agent runtime, before the model
 * starts. It fetches every granted Secret with the run token and prints one
 * JSON object of environment variables to stdout. The runtime starts the model
 * with those variables, so no script ever needs a wrapper command.
 */
describe('exportSecrets', () => {
  test('fetches every granted Secret with the run token and prints one JSON object', async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(GRANTED);
    });
    const stdout = captureWrites();

    const result = await exportSecrets(
      {},
      manifestDependencies({ fetch: fetchImpl, write: stdout.write })
    );

    expect(result).toEqual(GRANTED);
    expect(JSON.parse(stdout.value())).toEqual(GRANTED);
    expect(stdout.value().endsWith('\n')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/agentruns/481/secrets/environment');
    expect(calls[0].url).not.toContain('token=');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers['x-tc-token']).toBe(RUN_TOKEN);
    expect(JSON.parse(calls[0].options.body)).toEqual({
      secret_names: ['APP_LOGIN', 'API_LOGIN']
    });
  });

  test('prefers an explicit --api-url over the environment', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(GRANTED));

    await exportSecrets(
      { apiUrl: 'https://explicit.test/' },
      manifestDependencies({ fetch: fetchImpl, write: () => {} })
    );

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://explicit.test/agentruns/481/secrets/environment'
    );
  });

  test('prints an empty object and makes no call when nothing is granted', async () => {
    const fetchImpl = jest.fn();
    const stdout = captureWrites();

    const result = await exportSecrets(
      {},
      manifestDependencies({
        fetch: fetchImpl,
        write: stdout.write,
        readFile: () => JSON.stringify({ agent_run: 481, secrets: [] })
      })
    );

    expect(result).toEqual({});
    expect(stdout.value()).toBe('{}\n');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('requires the run identity and the run token before calling', async () => {
    const fetchImpl = jest.fn();

    await expect(
      exportSecrets(
        {},
        manifestDependencies({
          fetch: fetchImpl,
          environment: {
            TC_AGENT_RUN_MANIFEST: '/agent/run.json',
            TESTCOLLAB_TOKEN: RUN_TOKEN,
            TESTCOLLAB_API_URL: 'http://api.test'
          }
        })
      )
    ).rejects.toThrow('TC_AGENT_RUN_ID is required');

    await expect(
      exportSecrets(
        {},
        manifestDependencies({
          fetch: fetchImpl,
          environment: {
            TC_AGENT_RUN_ID: '481',
            TC_AGENT_RUN_MANIFEST: '/agent/run.json',
            TESTCOLLAB_API_URL: 'http://api.test'
          }
        })
      )
    ).rejects.toThrow('TESTCOLLAB_TOKEN is required');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects an environment that does not match the manifest and prints nothing', async () => {
    const invalid = [
      { ...GRANTED, TC_SECRET_NOT_GRANTED: 'extra-value-must-not-print' },
      { TC_SECRET_APP_LOGIN: SECRET_VALUE },
      { ...GRANTED, TC_SECRET_API_LOGIN: '' },
      { ...GRANTED, TC_SECRET_API_LOGIN: 42 },
      [SECRET_VALUE],
      null
    ];
    for (const body of invalid) {
      const stdout = captureWrites();
      let thrown;
      try {
        await exportSecrets(
          {},
          manifestDependencies({
            fetch: jest.fn(async () => jsonResponse(body)),
            write: stdout.write
          })
        );
      } catch (error) {
        thrown = error;
      }

      expect(safeSecretCommandError(thrown)).toBe(
        'Secret export returned an invalid environment'
      );
      expect(stdout.value()).toBe('');
      expect(JSON.stringify({ message: thrown.message })).not.toContain(SECRET_VALUE);
      expect(JSON.stringify({ message: thrown.message })).not.toContain('extra-value');
    }
  });

  test('uses fixed messages when TestCollab refuses or cannot be reached', async () => {
    const stdout = captureWrites();
    let refused;
    try {
      await exportSecrets(
        {},
        manifestDependencies({
          fetch: jest.fn(async () =>
            jsonResponse({ message: `revoked ${SECRET_VALUE}` }, 403)
          ),
          write: stdout.write
        })
      );
    } catch (error) {
      refused = error;
    }
    expect(safeSecretCommandError(refused)).toBe('Secret export was refused');
    expect(refused.message).not.toContain(SECRET_VALUE);

    let unreachable;
    try {
      await exportSecrets(
        {},
        manifestDependencies({
          fetch: jest.fn(async () => {
            throw new Error(`ECONNREFUSED ${SECRET_VALUE}`);
          }),
          write: stdout.write
        })
      );
    } catch (error) {
      unreachable = error;
    }
    expect(safeSecretCommandError(unreachable)).toBe('Secret export could not reach TestCollab');
    expect(unreachable.message).not.toContain(SECRET_VALUE);
    expect(stdout.value()).toBe('');
  });

  test('collapses arbitrary errors to a fixed message', () => {
    const error = new Error(SECRET_VALUE);

    expect(safeSecretCommandError(error)).toBe('Secret command failed');
    expect(safeSecretCommandError(error)).not.toContain(SECRET_VALUE);
  });
});

describe('tc secret CLI wiring', () => {
  test('export prints only the JSON environment the runtime consumes', async () => {
    let observed = null;
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        observed = {
          method: request.method,
          url: request.url,
          token: request.headers['x-tc-token'],
          body: JSON.parse(body)
        };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(GRANTED));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secret-export-'));
    const manifestPath = path.join(directory, 'run.json');
    fs.writeFileSync(manifestPath, MANIFEST, { mode: 0o600 });

    try {
      const child = spawn(
        process.execPath,
        [
          'src/index.js',
          'secret',
          'export',
          '--api-url',
          `http://127.0.0.1:${server.address().port}`
        ],
        {
          cwd: path.resolve('.'),
          env: {
            ...process.env,
            TC_AGENT_RUN_ID: '481',
            TC_AGENT_RUN_MANIFEST: manifestPath,
            TESTCOLLAB_TOKEN: RUN_TOKEN
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      const stdout = captureWrites();
      const stderr = captureWrites();
      child.stdout.on('data', (chunk) => stdout.write(chunk));
      child.stderr.on('data', (chunk) => stderr.write(chunk));
      const outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });

      expect(outcome).toEqual({ exitCode: 0, signal: null });
      expect(stdout.value()).toBe(`${JSON.stringify(GRANTED)}\n`);
      expect(stderr.value()).toBe('');
      expect(observed).toEqual({
        method: 'POST',
        url: '/agentruns/481/secrets/environment',
        token: RUN_TOKEN,
        body: { secret_names: ['APP_LOGIN', 'API_LOGIN'] }
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the wrapper command no longer exists', async () => {
    const child = spawn(process.execPath, ['src/index.js', 'secret', 'run', '--', 'node', '-e', '0'], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stderr = captureWrites();
    child.stderr.on('data', (chunk) => stderr.write(chunk));
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });

    expect(outcome).not.toBe(0);
    expect(stderr.value()).toContain('run');
  });
});
