import { StringDecoder } from 'node:string_decoder';

// Keep this list in lockstep with EpisodeError codes and the two generic codes
// emitted by episode.py.  Values from stderr are never copied into an error
// message or log without passing through this allow-list.
export const INFERENCE_DIAGNOSTIC_CODES = Object.freeze([
  'MODEL_MANIFEST_INVALID',
  'MODEL_CHECKSUM_MISMATCH',
  'ALIGNMENT_INVALID',
  'TEXT_ALIGNMENT_MISMATCH',
  'CUDA_UNAVAILABLE',
  'TRANSCRIPT_TRUNCATED',
  'LANGUAGE_UNAVAILABLE',
  'DECODE_TIMEOUT',
  'DECODE_FAILED',
  'AUDIO_LIMIT',
  'RESUME_INVALID',
  'AUDIO_DURATION_MISMATCH',
  'AUDIO_DECODE_INVALID',
  'ACK_REQUIRED',
  'GPU_OUT_OF_MEMORY',
  'TRANSCRIPTION_FAILED',
]);

const CODE_SET = new Set(INFERENCE_DIAGNOSTIC_CODES);
const REMOTE_CODES = new Set(['ASR_ABORTED', 'ASR_TIMEOUT', 'ASR_NETWORK', 'ASR_UNAUTHORIZED',
  'ASR_LEASE_LOST', 'ASR_HTTP_STATUS', 'ASR_REDIRECT_REJECTED', 'ASR_RESPONSE_INVALID',
  'ASR_RESPONSE_TOO_LARGE', 'ASR_TASK_INVALID', 'ASR_MEDIA_STORAGE', 'ASR_MEDIA_LENGTH', 'ASR_MEDIA_HASH']);
const ERROR_TYPES = new Set([
  'AssertionError',
  'EOFError',
  'FileNotFoundError',
  'ImportError',
  'IndexError',
  'JSONDecodeError',
  'KeyError',
  'ModuleNotFoundError',
  'OSError',
  'OutOfMemoryError',
  'PermissionError',
  'RuntimeError',
  'TimeoutExpired',
  'TypeError',
  'UnicodeError',
  'ValueError',
]);

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_LINE_BYTES = 4 * 1024;

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse one complete stderr line.  A null result is deliberately
 * indistinguishable for malformed, unknown, and non-diagnostic lines.
 */
export function parseInferenceDiagnosticLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) return null;
  let value;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return null;
  }
  if (!validObject(value) || typeof value.code !== 'string' || !CODE_SET.has(value.code)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'code' && key !== 'errorType')) return null;
  if (value.errorType !== undefined) {
    // episode.py only attaches errorType to a generic exception diagnostic.
    if ((value.code !== 'TRANSCRIPTION_FAILED' && value.code !== 'GPU_OUT_OF_MEMORY') ||
        typeof value.errorType !== 'string' || !ERROR_TYPES.has(value.errorType)) return null;
    return Object.freeze({ code: value.code, errorType: value.errorType });
  }
  return Object.freeze({ code: value.code });
}

/**
 * Collect stderr in bounded memory while preserving UTF-8 line boundaries.
 * The collector never throws and never exposes rejected input.  Any invalid
 * or over-limit input fails closed, so a valid diagnostic surrounded by
 * untrusted noise is not promoted to a structured log.
 */
export function createInferenceDiagnosticCollector() {
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let pending = '';
  let diagnostic = null;
  let invalid = false;
  let finished = false;

  const inspectLine = line => {
    if (Buffer.byteLength(line, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
      invalid = true;
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseInferenceDiagnosticLine(trimmed);
    // Only JSON-looking lines are treated as diagnostics.  This allows a
    // harmless interpreter warning while refusing a mixed diagnostic stream.
    if (trimmed.startsWith('{')) {
      if (!parsed) invalid = true;
      else diagnostic = parsed;
    }
  };

  const consume = text => {
    pending += text;
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      inspectLine(line);
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
      invalid = true;
      // Keep only a bounded suffix so a hostile stream cannot grow memory.
      pending = pending.slice(-MAX_DIAGNOSTIC_LINE_BYTES);
    }
  };

  return Object.freeze({
    push(chunk) {
      if (finished || invalid) return;
      let input;
      if (typeof chunk === 'string') input = Buffer.from(chunk, 'utf8');
      else if (Buffer.isBuffer(chunk)) input = chunk;
      else if (chunk instanceof Uint8Array) input = Buffer.from(chunk);
      else { invalid = true; return; }
      bytes += input.byteLength;
      if (bytes > MAX_STDERR_BYTES) {
        invalid = true;
        return;
      }
      consume(decoder.write(input));
    },
    finish() {
      if (finished) return invalid ? null : diagnostic;
      finished = true;
      if (!invalid) consume(decoder.end());
      if (!invalid && pending) inspectLine(pending);
      pending = '';
      return invalid ? null : diagnostic;
    },
  });
}

export function safeInferenceFailure(diagnostic = null) {
  const error = new Error('Local inference failed');
  if (diagnostic && CODE_SET.has(diagnostic.code)) {
    Object.defineProperty(error, 'diagnosticCode', { value: diagnostic.code });
    if (diagnostic.errorType && ERROR_TYPES.has(diagnostic.errorType)) {
      Object.defineProperty(error, 'diagnosticType', { value: diagnostic.errorType });
    }
  }
  return error;
}

export function safeDiagnosticForError(error, { aborted = false } = {}) {
  if (aborted) return Object.freeze({ code: 'ABORTED' });
  if (error?.name === 'RemoteTranscriptionError' && REMOTE_CODES.has(error.code)) return Object.freeze({ code: error.code });
  if (error && CODE_SET.has(error.diagnosticCode)) {
    const result = { code: error.diagnosticCode };
    if (error.diagnosticType && ERROR_TYPES.has(error.diagnosticType)) result.errorType = error.diagnosticType;
    return Object.freeze(result);
  }
  return Object.freeze({ code: 'TRANSCRIPTION_FAILED' });
}

export const INFERENCE_DIAGNOSTIC_LIMITS = Object.freeze({
  maxStderrBytes: MAX_STDERR_BYTES,
  maxLineBytes: MAX_DIAGNOSTIC_LINE_BYTES,
});
