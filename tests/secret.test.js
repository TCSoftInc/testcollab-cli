import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  applySecretRunResult,
  describeSecret,
  listSecrets,
  runWithSecrets,
  safeSecretCommandError,
  secretsFromManifest
} from '../src/commands/secret.js';
import {
  DEFAULT_SECRET_HELPER_SOCKET,
  SECRET_HELPER_PROTOCOL_VERSION,
  createLocalSecretHelperClient
} from '../src/lib/secretHelperClient.js';

const SECRET_VALUE = 'never-print-this-password-7f31';
const SECRET_NAME_SHAPED_VALUE = 'NEVERPRINTTHISPASSWORD';
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

const openFixtures = new Set();

function lineReader(socket, onLine) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.filter(Boolean).forEach(onLine);
  });
}

async function createSocketFixture(onConnection) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secret-'));
  const socketPath = path.join(directory, 'helper.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const fixture = {
    directory,
    socketPath,
    async close() {
      sockets.forEach((socket) => socket.destroy());
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      fs.rmSync(directory, { recursive: true, force: true });
      openFixtures.delete(fixture);
    }
  };
  openFixtures.add(fixture);
  return fixture;
}

function streamCapture() {
  let value = '';
  return {
    write(chunk) {
      value += String(chunk);
    },
    value() {
      return value;
    }
  };
}

function fakeProtocolSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.setEncoding = jest.fn();
  socket.write = jest.fn(() => true);
  socket.end = jest.fn(() => {
    socket.destroyed = true;
  });
  socket.destroy = jest.fn(() => {
    socket.destroyed = true;
  });
  return socket;
}

function manifestDependencies(overrides = {}) {
  return {
    environment: {
      TC_AGENT_RUN_ID: '481',
      TC_AGENT_RUN_MANIFEST: '/agent/run.json'
    },
    readFile: jest.fn(() => MANIFEST),
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(Array.from(openFixtures, (fixture) => fixture.close()));
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

describe('runWithSecrets', () => {
  test('sends only the agreed execution request to an injectable local helper', async () => {
    const helperClient = {
      run: jest.fn(async () => ({
        exitCode: 7,
        signal: null,
        artifacts: [
          '/agent/approved-artifacts/request-481-0123456789abcdef0123456789abcdef/evidence.txt'
        ],
        environment: { APP_PASSWORD: SECRET_VALUE }
      }))
    };
    const stdout = streamCapture();
    const stderr = streamCapture();
    const signalSource = new EventEmitter();

    const result = await runWithSecrets(
      {
        secret: ['APP_LOGIN', 'API_LOGIN', 'APP_LOGIN'],
        artifact: ['evidence.txt'],
        command: ['node', 'tests/login.js', '--headed']
      },
      manifestDependencies({
        helperClient,
        cwd: '/workspace/project',
        stdout,
        stderr,
        signalSource
      })
    );

    expect(result).toEqual({
      exitCode: 7,
      signal: null,
      artifacts: [
        '/agent/approved-artifacts/request-481-0123456789abcdef0123456789abcdef/evidence.txt'
      ]
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(helperClient.run).toHaveBeenCalledTimes(1);
    expect(helperClient.run.mock.calls[0][0]).toEqual({
      protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
      operation: 'run_with_secrets',
      agent_run: '481',
      secrets: ['APP_LOGIN', 'API_LOGIN'],
      command: 'node',
      argv: ['tests/login.js', '--headed'],
      cwd: '/workspace/project',
      artifacts: ['evidence.txt']
    });
    expect(helperClient.run.mock.calls[0][1]).toEqual({ stdout, stderr, signalSource });
    expect(JSON.stringify(helperClient.run.mock.calls)).not.toContain(SECRET_VALUE);
    expect(helperClient.run.mock.calls[0][0]).not.toHaveProperty('environment');
    expect(helperClient.run.mock.calls[0][0]).not.toHaveProperty('token');
    expect(helperClient.run.mock.calls[0][0]).not.toHaveProperty('api_url');
  });

  test('rejects an ungranted name without reflecting it or contacting the helper', async () => {
    const helperClient = { run: jest.fn() };
    let thrown;

    try {
      await runWithSecrets(
        { secret: [SECRET_NAME_SHAPED_VALUE], command: ['node', 'test.js'] },
        manifestDependencies({ helperClient, cwd: '/workspace/project' })
      );
    } catch (error) {
      thrown = error;
    }

    expect(helperClient.run).not.toHaveBeenCalled();
    expect(safeSecretCommandError(thrown)).toBe('Secret metadata was not found');
    expect(safeSecretCommandError(thrown)).not.toContain(SECRET_NAME_SHAPED_VALUE);
  });

  test('requires the run identity before contacting the helper', async () => {
    const helperClient = { run: jest.fn() };
    await expect(
      runWithSecrets(
        { secret: ['APP_LOGIN'], command: ['node', 'test.js'] },
        manifestDependencies({
          environment: { TC_AGENT_RUN_MANIFEST: '/agent/run.json' },
          helperClient,
          cwd: '/workspace/project'
        })
      )
    ).rejects.toThrow('TC_AGENT_RUN_ID is required');
    expect(helperClient.run).not.toHaveBeenCalled();
  });

  test('rejects unsafe, duplicate, or excessive artifact basenames before contacting the helper', async () => {
    const invalid = [
      ['../evidence.txt'],
      ['/tmp/evidence.txt'],
      ['folder/evidence.txt'],
      ['evidence.txt', 'evidence.txt'],
      Array.from({ length: 11 }, (_, index) => `evidence-${index}.txt`)
    ];
    for (const artifact of invalid) {
      const helperClient = { run: jest.fn() };
      await expect(
        runWithSecrets(
          { secret: ['APP_LOGIN'], artifact, command: ['node', 'test.js'] },
          manifestDependencies({ helperClient, cwd: '/workspace/project' })
        )
      ).rejects.toThrow(/Artifact name is invalid|Too many artifacts were requested/);
      expect(helperClient.run).not.toHaveBeenCalled();
    }
  });

  test('brokers an artifact for an Agent with zero selected or granted Secrets', async () => {
    const approved =
      '/agent/approved-artifacts/request-481-11111111111111111111111111111111/evidence.txt';
    const helperClient = {
      run: jest.fn(async () => ({ exitCode: 0, signal: null, artifacts: [approved] }))
    };
    const dependencies = manifestDependencies({
      helperClient,
      cwd: '/workspace/project',
      readFile: () => JSON.stringify({ agent_run: 481, secrets: [] })
    });

    const result = await runWithSecrets(
      { secret: [], artifact: ['evidence.txt'], command: ['node', 'capture.js'] },
      dependencies
    );

    expect(result).toEqual({ exitCode: 0, signal: null, artifacts: [approved] });
    expect(helperClient.run.mock.calls[0][0]).toEqual({
      protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
      operation: 'run_with_secrets',
      agent_run: '481',
      secrets: [],
      command: 'node',
      argv: ['capture.js'],
      cwd: '/workspace/project',
      artifacts: ['evidence.txt']
    });
  });

  test('requires at least one Secret or artifact before contacting the helper', async () => {
    const helperClient = { run: jest.fn() };
    await expect(
      runWithSecrets(
        { secret: [], artifact: [], command: ['node', 'test.js'] },
        manifestDependencies({ helperClient, cwd: '/workspace/project' })
      )
    ).rejects.toThrow('At least one --secret or --artifact is required');
    expect(helperClient.run).not.toHaveBeenCalled();
  });

  test('collapses arbitrary helper errors even when they spoof a helper code', () => {
    const error = Object.assign(new Error(SECRET_VALUE), {
      code: 'SECRET_HELPER_UNAVAILABLE'
    });

    expect(safeSecretCommandError(error)).toBe('Secret command failed');
    expect(safeSecretCommandError(error)).not.toContain(SECRET_VALUE);
  });

  test('forwards normal exit status and signal termination semantics', () => {
    const normalProcess = { exitCode: null };
    applySecretRunResult({ exitCode: 23, signal: null }, normalProcess);
    expect(normalProcess.exitCode).toBe(23);

    const kill = jest.fn();
    applySecretRunResult(
      { exitCode: null, signal: 'SIGTERM' },
      { pid: 999, exitCode: null, kill }
    );
    expect(kill).toHaveBeenCalledWith(999, 'SIGTERM');

    const fallbackProcess = { exitCode: null };
    applySecretRunResult({ exitCode: null, signal: 'SIGINT' }, fallbackProcess);
    expect(fallbackProcess.exitCode).toBe(130);
  });
});

describe('local secret helper protocol', () => {
  test('uses the fixed root-owned production socket path by default', () => {
    expect(DEFAULT_SECRET_HELPER_SOCKET).toBe('/agent/.testcollab-secret-helper.sock');
  });

  test('clears the handshake timeout after connect so a silent command may run longer', async () => {
    const socket = fakeProtocolSocket();
    const connectTimeoutMs = 5;
    const responseDelayMs = 30;
    const client = createLocalSecretHelperClient({
      socketPath: '/tmp/testcollab-secret-helper.sock',
      connectTimeoutMs,
      connect: () => {
        queueMicrotask(() => {
          socket.emit('connect');
          setTimeout(() => {
            socket.emit(
              'data',
              `${JSON.stringify({
                protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
                ok: true,
                exit_code: 0,
                signal: null,
                artifacts: []
              })}\n`
            );
          }, responseDelayMs);
        });
        return socket;
      }
    });

    const result = await client.run(
      {
        protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
        operation: 'run_with_secrets',
        agent_run: '481',
        secrets: ['APP_LOGIN'],
        command: 'node',
        argv: ['long-running-test.js'],
        cwd: '/workspace/project',
        artifacts: []
      },
      { stdout: streamCapture(), stderr: streamCapture(), signalSource: new EventEmitter() }
    );

    expect(responseDelayMs).toBeGreaterThan(connectTimeoutMs);
    expect(result).toEqual({ exitCode: 0, signal: null, artifacts: [] });
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  test('retains a bounded timeout while the helper socket is still connecting', async () => {
    const socket = fakeProtocolSocket();
    const client = createLocalSecretHelperClient({
      socketPath: '/tmp/testcollab-secret-helper.sock',
      connectTimeoutMs: 5,
      connect: () => socket
    });

    await expect(
      client.run(
        {
          protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
          operation: 'run_with_secrets',
          agent_run: '481',
          secrets: ['APP_LOGIN'],
          command: 'node',
          argv: ['test.js'],
          cwd: '/workspace/project',
          artifacts: []
        },
        { stdout: streamCapture(), stderr: streamCapture(), signalSource: new EventEmitter() }
      )
    ).rejects.toThrow('The Agent secret helper timed out');
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  test('streams helper-redacted output and returns process status without environment data', async () => {
    let request;
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, (line) => {
        request = JSON.parse(line);
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            event: 'output',
            stream: 'stdout',
            data: 'login test passed\n'
          })}\n`
        );
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            event: 'output',
            stream: 'stderr',
            data: 'safe diagnostic\n'
          })}\n`
        );
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            ok: true,
            exit_code: 4,
            signal: null,
            artifacts: []
          })}\n`
        );
      });
    });
    const stdout = streamCapture();
    const stderr = streamCapture();
    const signalSource = new EventEmitter();
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });
    const execution = {
      protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
      operation: 'run_with_secrets',
      agent_run: '481',
      secrets: ['APP_LOGIN'],
      command: 'node',
      argv: ['test.js'],
      cwd: '/workspace/project',
      artifacts: []
    };

    const result = await client.run(execution, { stdout, stderr, signalSource });

    expect(request).toEqual(execution);
    expect(result).toEqual({ exitCode: 4, signal: null, artifacts: [] });
    expect(result).not.toHaveProperty('environment');
    expect(stdout.value()).toBe('login test passed\n');
    expect(stderr.value()).toBe('safe diagnostic\n');
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(signalSource.listenerCount('SIGHUP')).toBe(0);
  });

  test('forwards signals as protocol frames and accepts signal termination', async () => {
    const frames = [];
    const signalSource = new EventEmitter();
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, (line) => {
        frames.push(JSON.parse(line));
        if (frames.length === 1) {
          signalSource.emit('SIGTERM');
        } else {
          socket.write(
            `${JSON.stringify({
              protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
              ok: true,
              exit_code: null,
              signal: 'SIGTERM',
              artifacts: []
            })}\n`
          );
        }
      });
    });
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });

    const result = await client.run(
      {
        protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
        operation: 'run_with_secrets',
        agent_run: '481',
        secrets: ['APP_LOGIN'],
        command: 'node',
        argv: ['test.js'],
        cwd: '/workspace/project',
        artifacts: []
      },
      { stdout: streamCapture(), stderr: streamCapture(), signalSource }
    );

    expect(frames[1]).toEqual({
      protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
      operation: 'signal',
      signal: 'SIGTERM'
    });
    expect(result).toEqual({ exitCode: null, signal: 'SIGTERM', artifacts: [] });
  });

  test('rejects an environment-bearing final frame without exposing its value', async () => {
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, () => {
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            ok: true,
            exit_code: 0,
            signal: null,
            artifacts: [],
            environment: { APP_PASSWORD: SECRET_VALUE }
          })}\n`
        );
      });
    });
    const stdout = streamCapture();
    const stderr = streamCapture();
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });
    let thrown;

    try {
      await client.run(
        {
          protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
          operation: 'run_with_secrets',
          agent_run: '481',
          secrets: ['APP_LOGIN'],
          command: 'node',
          argv: [],
          cwd: '/workspace/project',
          artifacts: []
        },
        { stdout, stderr, signalSource: new EventEmitter() }
      );
    } catch (error) {
      thrown = error;
    }

    const publicError = safeSecretCommandError(thrown);
    expect(publicError).toBe('The Agent secret helper returned an invalid final frame');
    expect(JSON.stringify({ message: thrown.message, code: thrown.code })).not.toContain(
      SECRET_VALUE
    );
    expect(stdout.value()).not.toContain(SECRET_VALUE);
    expect(stderr.value()).not.toContain(SECRET_VALUE);
  });

  test('rejects a forged approved-artifact path in the final frame', async () => {
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, () => {
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            ok: true,
            exit_code: 0,
            signal: null,
            artifacts: ['/agent/out/forged-evidence.txt']
          })}\n`
        );
      });
    });
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });

    await expect(
      client.run(
        {
          protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
          operation: 'run_with_secrets',
          agent_run: '481',
          secrets: ['APP_LOGIN'],
          command: 'node',
          argv: [],
          cwd: '/workspace/project',
          artifacts: []
        },
        { stdout: streamCapture(), stderr: streamCapture(), signalSource: new EventEmitter() }
      )
    ).rejects.toThrow('The Agent secret helper returned an invalid final frame');
  });

  test('discards helper error text and error codes instead of reflecting them', async () => {
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, () => {
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            ok: false,
            error: SECRET_VALUE,
            error_code: SECRET_VALUE
          })}\n`
        );
      });
    });
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });
    let thrown;

    try {
      await client.run(
        {
          protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
          operation: 'run_with_secrets',
          agent_run: '481',
          secrets: ['APP_LOGIN'],
          command: 'node',
          argv: [],
          cwd: '/workspace/project',
          artifacts: []
        },
        { stdout: streamCapture(), stderr: streamCapture(), signalSource: new EventEmitter() }
      );
    } catch (error) {
      thrown = error;
    }

    expect(safeSecretCommandError(thrown)).toBe(
      'The Agent secret helper rejected the request'
    );
    expect(JSON.stringify({ message: thrown.message, code: thrown.code })).not.toContain(
      SECRET_VALUE
    );
  });

  test('rejects a non-OS signal instead of passing it to the CLI process', async () => {
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, () => {
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            ok: true,
            exit_code: null,
            signal: 'SIG_NOT_REAL',
            artifacts: []
          })}\n`
        );
      });
    });
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });

    await expect(
      client.run(
        {
          protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
          operation: 'run_with_secrets',
          agent_run: '481',
          secrets: ['APP_LOGIN'],
          command: 'node',
          argv: [],
          cwd: '/workspace/project',
          artifacts: []
        },
        { stdout: streamCapture(), stderr: streamCapture(), signalSource: new EventEmitter() }
      )
    ).rejects.toThrow('The Agent secret helper returned an invalid process result');
  });

  test('does not write a malformed output frame containing secret material', async () => {
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, () => {
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            event: 'output',
            stream: 'stdout',
            data: SECRET_VALUE,
            environment: { APP_PASSWORD: SECRET_VALUE }
          })}\n`
        );
      });
    });
    const stdout = streamCapture();
    const client = createLocalSecretHelperClient({ socketPath: fixture.socketPath });
    let thrown;

    try {
      await client.run(
        {
          protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
          operation: 'run_with_secrets',
          agent_run: '481',
          secrets: ['APP_LOGIN'],
          command: 'node',
          argv: [],
          cwd: '/workspace/project',
          artifacts: []
        },
        { stdout, stderr: streamCapture(), signalSource: new EventEmitter() }
      );
    } catch (error) {
      thrown = error;
    }

    expect(safeSecretCommandError(thrown)).toBe(
      'The Agent secret helper returned an invalid output frame'
    );
    expect(stdout.value()).toBe('');
    expect(safeSecretCommandError(thrown)).not.toContain(SECRET_VALUE);
  });
});

describe('tc secret CLI wiring', () => {
  test('parses repeated secret/artifact flags and prints only approved copy paths', async () => {
    let request;
    const fixture = await createSocketFixture((socket) => {
      lineReader(socket, (line) => {
        const frame = JSON.parse(line);
        if (frame.operation !== 'run_with_secrets') return;
        request = frame;
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            event: 'output',
            stream: 'stdout',
            data: 'helper ran command\n'
          })}\n`
        );
        socket.write(
          `${JSON.stringify({
            protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
            ok: true,
            exit_code: 0,
            signal: null,
            artifacts: [
              '/agent/approved-artifacts/request-481-abcdef0123456789abcdef0123456789/evidence.txt'
            ]
          })}\n`
        );
      });
    });
    const manifestPath = path.join(fixture.directory, 'run.json');
    fs.writeFileSync(manifestPath, MANIFEST, { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        'src/index.js',
        'secret',
        'run',
        '--secret',
        'APP_LOGIN',
        '--secret',
        'API_LOGIN',
        '--artifact',
        'evidence.txt',
        '--',
        'node',
        '--flag',
        'value'
      ],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          TC_AGENT_RUN_ID: '481',
          TC_AGENT_RUN_MANIFEST: manifestPath,
          TC_AGENT_SECRET_SOCKET: fixture.socketPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    const stdout = streamCapture();
    const stderr = streamCapture();
    child.stdout.on('data', (chunk) => stdout.write(chunk));
    child.stderr.on('data', (chunk) => stderr.write(chunk));
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });

    expect(outcome).toEqual({ exitCode: 0, signal: null });
    expect(stdout.value()).toBe(
      'helper ran command\n' +
        'Approved artifact: /agent/approved-artifacts/request-481-abcdef0123456789abcdef0123456789/evidence.txt\n'
    );
    expect(stderr.value()).toBe('');
    expect(request).toEqual({
      protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
      operation: 'run_with_secrets',
      agent_run: '481',
      secrets: ['APP_LOGIN', 'API_LOGIN'],
      command: 'node',
      argv: ['--flag', 'value'],
      cwd: path.resolve('.'),
      artifacts: ['evidence.txt']
    });
    expect(JSON.stringify(request)).not.toContain(SECRET_VALUE);
    expect(request).not.toHaveProperty('environment');
  });
});
