/**
 * Models (esp. openai-compatible) often emit tool-call JSON with:
 * - literal newlines/tabs inside string values
 * - truncated output (hit max_tokens) → Unterminated string
 * - raw `"` inside HTML/CSS (unescaped attribute quotes)
 *
 * Strict JSON.parse then throws. These helpers recover when possible so the
 * tool can still execute instead of failing the whole run.
 */
export function repairControlCharsInJsonStrings(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Close open strings / braces / brackets after truncation (e.g. max_tokens cut mid-tool-args). */
export function closeTruncatedJson(raw: string): string {
  let inString = false;
  let escaped = false;
  const stack: Array<'}' | ']'> = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  let out = raw;
  if (inString) {
    if (out.endsWith('\\')) out += '\\';
    out += '"';
  }
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

function decodeJsonStringFragment(raw: string): string {
  let out = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      if (ch === 'n') out += '\n';
      else if (ch === 'r') out += '\r';
      else if (ch === 't') out += '\t';
      else if (ch === '"') out += '"';
      else if (ch === '\\') out += '\\';
      else if (ch === '/' ) out += '/';
      else if (ch === 'u' && i + 4 < raw.length) {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += ch;
        }
      } else {
        out += ch;
      }
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Extract a JSON string field even when the value contains raw quotes/newlines
 * or the object was truncated. Heuristic: a `"` ends the value only when followed
 * by `,` / `}` or `, "nextKey":`.
 */
export function extractLooseJsonStringField(raw: string, key: string): string | undefined {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`);
  const match = re.exec(raw);
  if (!match || match.index === undefined) return undefined;
  let i = match.index + match[0].length;
  let out = '';
  let escaped = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (escaped) {
      out += `\\${ch}`;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      const rest = raw.slice(i + 1);
      if (/^\s*[,}]/.test(rest) || /^\s*,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:/.test(rest)) {
        break;
      }
      // Unescaped quote inside value (typical HTML attribute) — keep as literal.
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return decodeJsonStringFragment(out);
}

/**
 * Last-resort salvage for write / staged-append tool arguments when JSON.parse fails.
 * Format-agnostic: only pulls known scalar fields.
 */
export function salvageToolCallArguments(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  const path = extractLooseJsonStringField(raw, 'path');
  const content = extractLooseJsonStringField(raw, 'content');
  const text = extractLooseJsonStringField(raw, 'text');
  const writeId = extractLooseJsonStringField(raw, 'writeId');
  if (path === undefined && content === undefined && text === undefined && writeId === undefined) {
    return null;
  }
  const out: Record<string, unknown> = {};
  if (path !== undefined) out.path = path;
  if (content !== undefined) out.content = content;
  if (text !== undefined) out.text = text;
  if (writeId !== undefined) out.writeId = writeId;
  const mode = raw.match(/"mode"\s*:\s*"(replace|append)"/);
  if (mode) out.mode = mode[1];
  const encoding = raw.match(/"encoding"\s*:\s*"(utf8|base64)"/);
  if (encoding) out.encoding = encoding[1];
  const deliverable = raw.match(/"deliverable"\s*:\s*(true|false)/);
  if (deliverable) out.deliverable = deliverable[1] === 'true';
  const reset = raw.match(/"reset"\s*:\s*(true|false)/);
  if (reset) out.reset = reset[1] === 'true';
  const seq = raw.match(/"seq"\s*:\s*(\d+)/);
  if (seq) out.seq = Number(seq[1]);
  const total = raw.match(/"total"\s*:\s*(\d+)/);
  if (total) out.total = Number(total[1]);
  const totalParts = raw.match(/"totalParts"\s*:\s*(\d+)/);
  if (totalParts) out.totalParts = Number(totalParts[1]);
  return out;
}

function tryParse(text: string): unknown {
  return JSON.parse(text);
}

export function parseJsonLenient(raw: string): unknown {
  const text = raw || '{}';
  try {
    return tryParse(text);
  } catch (first) {
    const repaired = repairControlCharsInJsonStrings(text);
    try {
      return tryParse(repaired);
    } catch {
      // continue
    }
    try {
      return tryParse(closeTruncatedJson(repaired));
    } catch {
      // continue
    }
    const salvaged = salvageToolCallArguments(text);
    if (salvaged) return salvaged;
    throw first;
  }
}

/** Install a scoped JSON.parse patch for the duration of `run`. */
export async function withLenientJsonParse<T>(run: () => Promise<T>): Promise<T> {
  const original = JSON.parse;
  JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    try {
      return original.call(JSON, text, reviver);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        typeof text === 'string'
        && /control character|Unterminated string|Bad escaped character|Expected ',' or '}'|Expected ',' or '\]'|JSON at position|Unexpected token|Unexpected non-whitespace/i.test(message)
      ) {
        try {
          const repaired = repairControlCharsInJsonStrings(text);
          try {
            return original.call(JSON, repaired, reviver);
          } catch {
            // continue
          }
          try {
            return original.call(JSON, closeTruncatedJson(repaired), reviver);
          } catch {
            // continue
          }
          const salvaged = salvageToolCallArguments(text);
          if (salvaged) return salvaged;
        } catch {
          // fall through
        }
      }
      throw error;
    }
  }) as typeof JSON.parse;
  try {
    return await run();
  } finally {
    JSON.parse = original;
  }
}
