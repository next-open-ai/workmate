/**
 * Workspace large-file write helpers (format-agnostic).
 * See docs/design/workspace-file-io.md.
 */
import { randomUUID } from 'node:crypto';

export const MAX_FILE_BYTES = 96_000;
/** Soft cap for a single `content` field — keep one-shot JSON small enough to survive tool encoding. */
export const MAX_WRITE_CONTENT = 12_000;
export const MAX_WRITE_CHUNK = 4_000;
export const MAX_WRITE_CHUNKS = 16;
/** Staged append pieces stay small so tool-call JSON stays reliable. */
export const MAX_STAGED_APPEND_CHARS = 3_500;
export const MAX_STAGED_SESSIONS = 8;
export const STAGED_SESSION_TTL_MS = 30 * 60_000;

/**
 * UTF-8 is the default for text files.
 * `base64` is an escape hatch only (binary-ish payloads / JSON-escape failures) — not the preferred path.
 */
export type WriteEncoding = 'utf8' | 'base64';

export type StagedWriteSession = {
  id: string;
  path: string;
  /** Disk mode used on finish. Staged assembly itself is always in-memory join → one write. */
  mode: 'replace' | 'append';
  deliverable?: boolean;
  /** Contiguous 1-based pieces in arrival order. */
  parts: string[];
  /** Next required seq (1-based). */
  nextSeq: number;
  /** Optional declared total; immutable once set unless reset. */
  totalParts?: number;
  bytes: number;
  createdAt: number;
};

const sessions = new Map<string, StagedWriteSession>();

function purgeExpiredSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > STAGED_SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size > MAX_STAGED_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

export function decodeWritePayload(raw: string, encoding: WriteEncoding = 'utf8'): string {
  if (encoding !== 'base64') return raw;
  try {
    return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch {
    throw new Error('Invalid base64 payload. Prefer encoding="utf8". Use base64 only as an escape hatch.');
  }
}

export function resolveWriteBody(input: {
  content?: string;
  chunks?: string[];
  encoding?: WriteEncoding;
}): { ok: true; body: string } | { ok: false; error: string } {
  const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
  try {
    if (typeof input.content === 'string' && input.content.length) {
      return { ok: true, body: decodeWritePayload(input.content, encoding) };
    }
    if (Array.isArray(input.chunks) && input.chunks.length) {
      const joined = input.chunks
        .filter((part): part is string => typeof part === 'string')
        .map((part) => decodeWritePayload(part, encoding))
        .join('');
      if (!joined) {
        return {
          ok: false,
          error: 'Write body is empty. Pass content (string) or chunks (string[]). Historical path-only stubs are NOT a write format.',
        };
      }
      return { ok: true, body: joined };
    }
    return {
      ok: false,
      error: 'Write body is empty. Pass content (string) or chunks (string[]). Do not omit the body — path-only entries in history mean a prior write already succeeded on disk.',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function startStagedWrite(input: {
  path: string;
  mode?: 'replace' | 'append';
  deliverable?: boolean;
  totalParts?: number;
}): StagedWriteSession {
  purgeExpiredSessions();
  const totalParts =
    typeof input.totalParts === 'number' && Number.isInteger(input.totalParts) && input.totalParts > 0
      ? input.totalParts
      : undefined;
  const session: StagedWriteSession = {
    id: randomUUID(),
    path: input.path,
    mode: input.mode === 'append' ? 'append' : 'replace',
    deliverable: input.deliverable,
    parts: [],
    nextSeq: 1,
    totalParts,
    bytes: 0,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

function assertPositiveInt(name: string, value: unknown): number | { ok: false; error: string } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${name} must be a positive integer (1-based).` };
  }
  return value;
}

export function appendStagedWrite(
  writeId: string,
  text: string,
  opts: { seq: number; total?: number; reset?: boolean },
): {
  ok: true;
  session: StagedWriteSession;
  appended: number;
  reset?: boolean;
} | { ok: false; error: string } {
  purgeExpiredSessions();
  const session = sessions.get(writeId);
  if (!session) return { ok: false, error: `Unknown writeId "${writeId}". Call start_workspace_write first.` };
  if (typeof text !== 'string' || !text.length) {
    return { ok: false, error: 'append_workspace_write requires a non-empty text string (≤3.5KB recommended).' };
  }
  if (text.length > MAX_STAGED_APPEND_CHARS) {
    return {
      ok: false,
      error: `Append piece too large (${text.length} chars). Split into ≤${MAX_STAGED_APPEND_CHARS} char pieces.`,
    };
  }

  const seqCheck = assertPositiveInt('seq', opts.seq);
  if (typeof seqCheck !== 'number') return seqCheck;

  if (opts.reset) {
    if (seqCheck !== 1) {
      return { ok: false, error: 'reset=true requires seq=1 (restart assembly from the first piece).' };
    }
    session.parts = [];
    session.nextSeq = 1;
    session.bytes = 0;
    session.totalParts = undefined;
  }

  if (seqCheck !== session.nextSeq) {
    return {
      ok: false,
      error: `Out-of-order piece: expected seq=${session.nextSeq}, got seq=${seqCheck}. Pass pieces in order, or reset=true with seq=1 to restart.`,
    };
  }

  if (typeof opts.total === 'number') {
    const totalCheck = assertPositiveInt('total', opts.total);
    if (typeof totalCheck !== 'number') return totalCheck;
    if (session.totalParts !== undefined && session.totalParts !== totalCheck) {
      return {
        ok: false,
        error: `total mismatch: session expects ${session.totalParts} parts, got total=${totalCheck}. Use reset=true to restart with a new total.`,
      };
    }
    session.totalParts = totalCheck;
  }

  if (session.totalParts !== undefined && seqCheck > session.totalParts) {
    return {
      ok: false,
      error: `seq=${seqCheck} exceeds declared total=${session.totalParts}.`,
    };
  }

  const nextBytes = session.bytes + Buffer.byteLength(text);
  if (nextBytes > MAX_FILE_BYTES) {
    return { ok: false, error: `Staged write would exceed ${MAX_FILE_BYTES} bytes. Finish earlier or reduce content.` };
  }

  session.parts.push(text);
  session.bytes = nextBytes;
  session.nextSeq = seqCheck + 1;
  return { ok: true, session, appended: Buffer.byteLength(text), ...(opts.reset ? { reset: true } : {}) };
}

export function takeStagedWrite(writeId: string): {
  ok: true;
  session: StagedWriteSession;
  body: string;
} | { ok: false; error: string } {
  purgeExpiredSessions();
  const session = sessions.get(writeId);
  if (!session) return { ok: false, error: `Unknown writeId "${writeId}". Call start_workspace_write first.` };
  if (!session.parts.length) {
    return { ok: false, error: 'Staged write has no pieces. Call append_workspace_write at least once before finish.' };
  }
  if (session.totalParts !== undefined && session.parts.length !== session.totalParts) {
    return {
      ok: false,
      error: `Incomplete staged write: have ${session.parts.length}/${session.totalParts} parts (next expected seq=${session.nextSeq}).`,
    };
  }
  const body = session.parts.join('');
  sessions.delete(writeId);
  return { ok: true, session, body };
}

export function peekStagedWrite(writeId: string): StagedWriteSession | undefined {
  purgeExpiredSessions();
  return sessions.get(writeId);
}

/** Test helper */
export function resetStagedWritesForTests() {
  sessions.clear();
}
