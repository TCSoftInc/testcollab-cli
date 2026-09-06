import fs from 'fs';
import os from 'os';

import {
  SECRET_HELPER_PROTOCOL_VERSION,
  createLocalSecretHelperClient
} from '../lib/secretHelperClient.js';

const DEFAULT_RUN_MANIFEST = '/agent/run.json';
const SECRET_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/;
const ENVIRONMENT_NAME_PATTERN = /^TC_SECRET_[A-Z0-9_]+$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPROVED_ARTIFACT_PATH_PATTERN =
  /^\/agent\/approved-artifacts\/request-[1-9][0-9]*-[a-f0-9]{32}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ARTIFACTS = 10;
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143
};
const KNOWN_SIGNALS = new Set(Object.keys(os.constants.signals || {}));

export function collectSecret(value, previous = []) {
  return previous.concat([value]);
}

export function collectArtifact(value, previous = []) {
  return previous.concat([value]);
}

function manifestPath(environment) {
  return environment.TC_AGENT_RUN_MANIFEST || DEFAULT_RUN_MANIFEST;
}

function rawManifest(environment, readFile) {
  let contents;
  try {
    contents = readFile(manifestPath(environment), 'utf8');
  } catch {
    throw new Error('The Agent run manifest is unavailable');
  }
  try {
    const manifest = JSON.parse(contents);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
    return manifest;
  } catch {
    // Never include parser context: the manifest may contain customer data.
    throw new Error('The Agent run manifest is invalid');
  }
}

function patternText(value, pattern) {
  if (typeof value !== 'string') return null;
  return pattern.test(value) ? value : null;
}

function normalizeSecret(entry, fallbackName) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const name = patternText(entry.name || fallbackName, SECRET_NAME_PATTERN);
  const environment = patternText(entry.environment, ENVIRONMENT_NAME_PATTERN);
  if (!name || !name.trim() || !environment) return null;
  return { name, environment };
}

/** Return only allowlisted secret metadata; values and unknown keys are dropped. */
export function secretsFromManifest(manifest) {
  const entries = manifest && manifest.secrets;
  const normalized = Array.isArray(entries)
    ? entries.map((entry) => normalizeSecret(entry))
    : entries && typeof entries === 'object'
      ? Object.keys(entries).map((name) => normalizeSecret(entries[name], name))
      : [];
  const byName = new Map();
  normalized.filter(Boolean).forEach((secret) => {
    if (!byName.has(secret.name)) byName.set(secret.name, secret);
  });
  return Array.from(byName.values());
}

export function listSecrets(options = {}, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const readFile = dependencies.readFile || fs.readFileSync;
  const write = dependencies.write || ((message) => console.log(message));
  const secrets = secretsFromManifest(rawManifest(environment, readFile));
  secrets.forEach((secret) => write(secret.name));
  return secrets;
}

export function describeSecret(name, options = {}, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const readFile = dependencies.readFile || fs.readFileSync;
  const write = dependencies.write || ((message) => console.log(message));
  const secret = secretsFromManifest(rawManifest(environment, readFile)).find(
    (entry) => entry.name === name
  );
  // Do not reflect the argument. An accidental value supplied in place of a
  // name must not be copied into terminal output or logs.
  if (!secret) throw new Error('Secret metadata was not found');
  write(JSON.stringify(secret, null, 2));
  return secret;
}

function normalizeRequestedSecrets(values) {
  const requested = [];
  (values || []).forEach((value) => {
    const name = String(value || '');
    if (!name.trim() || !SECRET_NAME_PATTERN.test(name)) throw new Error('Secret name is invalid');
    if (!requested.includes(name)) requested.push(name);
  });
  return requested;
}

function normalizeRequestedArtifacts(values) {
  const artifacts = [];
  (values || []).forEach((value) => {
    const name = String(value || '');
    if (
      !ARTIFACT_NAME_PATTERN.test(name) ||
      name === '.' ||
      name === '..' ||
      artifacts.includes(name)
    ) {
      throw new Error('Artifact name is invalid');
    }
    artifacts.push(name);
  });
  if (artifacts.length > MAX_ARTIFACTS) {
    throw new Error('Too many artifacts were requested');
  }
  return artifacts;
}

function normalizeApprovedArtifactPaths(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARTIFACTS ||
    value.some(
      (artifact, index) =>
        typeof artifact !== 'string' ||
        !APPROVED_ARTIFACT_PATH_PATTERN.test(artifact) ||
        value.indexOf(artifact) !== index
    )
  ) {
    throw new Error('The Agent secret helper returned an invalid process result');
  }
  return value.slice();
}

function validateCommand(command) {
  if (!Array.isArray(command) || !command.length || !String(command[0])) {
    throw new Error('A command is required after --');
  }
  return command.map((part) => {
    const value = String(part);
    if (value.includes('\u0000')) throw new Error('Command contains an invalid null byte');
    return value;
  });
}

function resolveCwd(value) {
  const cwd = String(value || '');
  if (!cwd || !cwd.startsWith('/') || /[\u0000-\u001f\u007f]/.test(cwd)) {
    throw new Error('The working directory is invalid');
  }
  return cwd;
}

function normalizeHelperResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('The Agent secret helper returned an invalid process result');
  }
  const exitCode = result.exitCode;
  const signal = result.signal;
  const artifacts = normalizeApprovedArtifactPaths(result.artifacts);
  const valid =
    (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 && signal == null) ||
    (exitCode == null && typeof signal === 'string' && KNOWN_SIGNALS.has(signal));
  if (!valid) throw new Error('The Agent secret helper returned an invalid process result');
  // Explicit projection prevents an injected client from returning an
  // environment or other helper-side data through this command boundary.
  return { exitCode: exitCode ?? null, signal: signal || null, artifacts };
}

/**
 * Ask the trusted local helper to run a command. No secret value or materialized
 * environment crosses this model-facing process.
 */
export async function runWithSecrets(options, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const command = validateCommand(options.command);
  const secrets = normalizeRequestedSecrets(options.secret);
  const artifacts = normalizeRequestedArtifacts(options.artifact);
  if (!secrets.length && !artifacts.length) {
    throw new Error('At least one --secret or --artifact is required');
  }
  const agentRun = String(environment.TC_AGENT_RUN_ID || '');
  if (!/^[1-9]\d*$/.test(agentRun)) throw new Error('TC_AGENT_RUN_ID is required');

  // Fail before contacting the helper if the model requests a name not present
  // in the metadata snapshot. The helper remains the authoritative grant check.
  const readFile = dependencies.readFile || fs.readFileSync;
  const available = new Set(
    secretsFromManifest(rawManifest(environment, readFile)).map((secret) => secret.name)
  );
  const missing = secrets.filter((name) => !available.has(name));
  // Do not reflect requested names for the same reason as describeSecret().
  if (missing.length) throw new Error('Secret metadata was not found');

  const helperClient =
    dependencies.helperClient ||
    createLocalSecretHelperClient({
      socketPath: environment.TC_AGENT_SECRET_SOCKET
    });
  const result = await helperClient.run(
    {
      protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
      operation: 'run_with_secrets',
      agent_run: agentRun,
      secrets,
      command: command[0],
      argv: command.slice(1),
      cwd: resolveCwd(dependencies.cwd || process.cwd()),
      artifacts
    },
    {
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
      signalSource: dependencies.signalSource
    }
  );
  return normalizeHelperResult(result);
}

export function applySecretRunResult(result, processRef = process) {
  (result.artifacts || []).forEach((artifact) => {
    if (processRef.stdout && typeof processRef.stdout.write === 'function') {
      processRef.stdout.write(`Approved artifact: ${artifact}\n`);
    }
  });
  if (result.signal) {
    if (typeof processRef.kill === 'function' && processRef.pid) {
      processRef.kill(processRef.pid, result.signal);
      return;
    }
    processRef.exitCode = SIGNAL_EXIT_CODES[result.signal] || 1;
    return;
  }
  processRef.exitCode = result.exitCode;
}

export function safeSecretCommandError(error) {
  // Only fixed, locally-authored messages may cross the CLI boundary. Never
  // trust an Error merely because it carries a helper-looking code: an injected
  // client or compromised peer could attach secret material to its message.
  const known = [
    'The Agent run manifest is unavailable',
    'The Agent run manifest is invalid',
    'Secret name is invalid',
    'Artifact name is invalid',
    'Too many artifacts were requested',
    'At least one --secret or --artifact is required',
    'A command is required after --',
    'Command contains an invalid null byte',
    'The working directory is invalid',
    'TC_AGENT_RUN_ID is required',
    'Secret metadata was not found',
    'The Agent secret helper socket path is invalid',
    'The Agent secret helper returned an invalid output frame',
    'The Agent secret helper returned an invalid final frame',
    'The Agent secret helper rejected the request',
    'The Agent secret helper returned an invalid process result',
    'The Agent secret helper is unavailable',
    'The Agent secret helper timed out',
    'The Agent secret helper returned an invalid response',
    'The Agent secret helper returned more than one final result',
    'The Agent secret helper response was too large',
    'The Agent secret helper closed without a process result'
  ];
  if (known.includes(error && error.message)) return error.message;
  return 'Secret command failed';
}
