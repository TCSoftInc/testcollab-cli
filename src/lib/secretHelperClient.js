import net from 'net';
import os from 'os';

export const SECRET_HELPER_PROTOCOL_VERSION = 2;
export const DEFAULT_SECRET_HELPER_SOCKET = '/agent/.testcollab-secret-helper.sock';
export const DEFAULT_APPROVED_ARTIFACT_ROOT = '/agent/approved-artifacts';
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const KNOWN_SIGNALS = new Set(Object.keys(os.constants.signals || {}));

function helperError(message, code = 'SECRET_HELPER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function validateSocketPath(value) {
  const socketPath = String(value || '');
  if (!socketPath || !socketPath.startsWith('/') || /[\u0000-\u001f\u007f]/.test(socketPath)) {
    throw helperError('The Agent secret helper socket path is invalid', 'SECRET_HELPER_CONFIG');
  }
  return socketPath;
}

function validateOutputFrame(frame) {
  const keys = Object.keys(frame).sort();
  const expected = ['data', 'event', 'protocol_version', 'stream'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    frame.protocol_version !== SECRET_HELPER_PROTOCOL_VERSION ||
    frame.event !== 'output' ||
    (frame.stream !== 'stdout' && frame.stream !== 'stderr') ||
    typeof frame.data !== 'string'
  ) {
    throw helperError('The Agent secret helper returned an invalid output frame');
  }
  return frame;
}

function validateFinalFrame(frame) {
  if (
    frame.protocol_version !== SECRET_HELPER_PROTOCOL_VERSION ||
    typeof frame.ok !== 'boolean'
  ) {
    throw helperError('The Agent secret helper returned an invalid final frame');
  }

  if (!frame.ok) {
    const failureKeys = ['error', 'error_code', 'ok', 'protocol_version'];
    const actual = Object.keys(frame).sort();
    if (
      actual.length !== failureKeys.length ||
      actual.some((key, index) => key !== failureKeys[index])
    ) {
      throw helperError('The Agent secret helper returned an invalid final frame');
    }
    // Both helper-supplied error fields are deliberately ignored. Even a
    // syntactically valid error code is outside the CLI's redaction boundary
    // and could accidentally contain materialized data.
    throw helperError(
      'The Agent secret helper rejected the request',
      'SECRET_HELPER_REJECTED'
    );
  }

  const successKeys = ['artifacts', 'exit_code', 'ok', 'protocol_version', 'signal'];
  const actual = Object.keys(frame).sort();
  if (
    actual.length !== successKeys.length ||
    actual.some((key, index) => key !== successKeys[index]) ||
    !Array.isArray(frame.artifacts) ||
    frame.artifacts.length > 10 ||
    frame.artifacts.some(
      (artifact, index) =>
        typeof artifact !== 'string' ||
        !/^\/agent\/approved-artifacts\/request-[1-9][0-9]*-[a-f0-9]{32}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
          artifact
        ) ||
        frame.artifacts.indexOf(artifact) !== index
    )
  ) {
    throw helperError('The Agent secret helper returned an invalid final frame');
  }

  const exitCode = frame.exit_code;
  const signal = frame.signal;
  if (
    !(
      (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 && signal == null) ||
      (exitCode == null && typeof signal === 'string' && KNOWN_SIGNALS.has(signal))
    )
  ) {
    throw helperError('The Agent secret helper returned an invalid process result');
  }
  return {
    exitCode: exitCode ?? null,
    signal: signal || null,
    artifacts: frame.artifacts.slice()
  };
}

function safeWrite(stream, data) {
  if (stream && typeof stream.write === 'function') stream.write(data);
}

/**
 * Narrow client for the trusted, container-local secret helper.
 *
 * The helper owns backend authentication, materialization, the credentialed
 * child process, and output redaction. This client never receives an environment
 * map or a secret value. Communication is newline-delimited JSON so output and
 * signals can be forwarded without putting command data in an OS argument list.
 */
export function createLocalSecretHelperClient(options = {}) {
  const socketPath = validateSocketPath(
    options.socketPath || process.env.TC_AGENT_SECRET_SOCKET || DEFAULT_SECRET_HELPER_SOCKET
  );
  const connect = options.connect || ((path) => net.createConnection({ path }));
  // This is deliberately a connection deadline, not a child-runtime deadline.
  // The trusted helper/runtime supervisor owns the authoritative run ceiling.
  const connectTimeoutMs = positiveInteger(
    options.connectTimeoutMs || options.timeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS
  );

  return {
    async run(request, runtime = {}) {
      const stdout = runtime.stdout || process.stdout;
      const stderr = runtime.stderr || process.stderr;
      const signalSource = runtime.signalSource || process;

      return await new Promise((resolve, reject) => {
        let socket;
        let settled = false;
        let buffer = '';
        let connectTimer = null;
        let finalSeen = false;
        const signalHandlers = new Map();

        const clearConnectTimer = () => {
          if (!connectTimer) return;
          clearTimeout(connectTimer);
          connectTimer = null;
        };

        const cleanup = () => {
          clearConnectTimer();
          for (const [signal, handler] of signalHandlers) {
            if (signalSource && typeof signalSource.off === 'function') {
              signalSource.off(signal, handler);
            } else if (signalSource && typeof signalSource.removeListener === 'function') {
              signalSource.removeListener(signal, handler);
            }
          }
          signalHandlers.clear();
        };

        const fail = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (socket && !socket.destroyed) socket.destroy();
          reject(
            error && error.code && String(error.code).startsWith('SECRET_HELPER')
              ? error
              : helperError('The Agent secret helper is unavailable', 'SECRET_HELPER_UNAVAILABLE')
          );
        };

        const succeed = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (socket && !socket.destroyed) socket.end();
          resolve(result);
        };

        const sendFrame = (frame) => {
          if (!socket || socket.destroyed || settled) return;
          socket.write(`${JSON.stringify(frame)}\n`);
        };

        const onFrame = (line) => {
          // Never write trailing output after a final result, including another
          // frame delivered in the same socket chunk.
          if (settled) return;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            throw helperError('The Agent secret helper returned an invalid response');
          }
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
            throw helperError('The Agent secret helper returned an invalid response');
          }
          if (frame.event === 'output') {
            const output = validateOutputFrame(frame);
            safeWrite(output.stream === 'stdout' ? stdout : stderr, output.data);
            return;
          }
          if (finalSeen) {
            throw helperError('The Agent secret helper returned more than one final result');
          }
          finalSeen = true;
          succeed(validateFinalFrame(frame));
        };

        try {
          socket = connect(socketPath);
        } catch {
          fail(helperError('The Agent secret helper is unavailable', 'SECRET_HELPER_UNAVAILABLE'));
          return;
        }

        connectTimer = setTimeout(() => {
          fail(helperError('The Agent secret helper timed out', 'SECRET_HELPER_TIMEOUT'));
        }, connectTimeoutMs);

        socket.setEncoding('utf8');
        socket.on('connect', () => {
          // Once connected, a credentialed command may run until the helper or
          // run-level supervisor ends it. Silent long-running tests must not be
          // disconnected by a model-facing CLI timer.
          clearConnectTimer();
          sendFrame(request);
        });
        socket.on('data', (chunk) => {
          if (settled) return;
          buffer += chunk;
          if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
            fail(helperError('The Agent secret helper response was too large'));
            return;
          }
          const lines = buffer.split('\n');
          buffer = lines.pop();
          try {
            lines.filter((line) => line.length).forEach(onFrame);
          } catch (error) {
            fail(error);
          }
        });
        socket.on('error', () => {
          fail(helperError('The Agent secret helper is unavailable', 'SECRET_HELPER_UNAVAILABLE'));
        });
        socket.on('close', () => {
          if (settled) return;
          if (buffer.trim()) {
            try {
              onFrame(buffer);
            } catch (error) {
              fail(error);
              return;
            }
          }
          if (!settled) {
            fail(helperError('The Agent secret helper closed without a process result'));
          }
        });

        FORWARDED_SIGNALS.forEach((signal) => {
          if (!signalSource || typeof signalSource.on !== 'function') return;
          const handler = () => {
            sendFrame({
              protocol_version: SECRET_HELPER_PROTOCOL_VERSION,
              operation: 'signal',
              signal
            });
          };
          signalHandlers.set(signal, handler);
          signalSource.on(signal, handler);
        });
      });
    }
  };
}
