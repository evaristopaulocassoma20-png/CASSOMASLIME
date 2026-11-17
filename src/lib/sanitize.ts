/**
 * Input sanitization, URL validation, safe numeric parsing, and Kwanza (Kz) formatting utilities.
 */

const CONTROL_AND_BIDI_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const DANGEROUS_TAG_BLOCKS_REGEX = /<(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_TAG_REGEX = /<\/?[a-z][^>]*>/gi;

/**
 * Strips control chars, Unicode BiDi override/zero-width chars, and HTML/script tags,
 * preserving safe plain text bounded to `maxLen`.
 */
export function sanitizePlainText(value: unknown, maxLen = 1000): string {
  if (value === null || value === undefined) return '';
  const raw = String(value)
    .replace(CONTROL_AND_BIDI_REGEX, '')
    .replace(DANGEROUS_TAG_BLOCKS_REGEX, '')
    .replace(HTML_TAG_REGEX, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen).trim();
}

/**
 * Validates external URLs strictly allowing http: and https: protocols only.
 * Returns normalized URL string or null if invalid/unsafe (blocks javascript:, data:, vbscript:).
 */
export function sanitizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_AND_BIDI_REGEX, '').trim();
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Parses a positive finite number safely, clamping within [0, max].
 */
export function parsePositiveFinite(value: unknown, max = 1_000_000_000): number {
  const num = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(num, max);
}

/**
 * Formats a numeric value in Angolan Kwanza (Kz) with `pt-AO` locale formatting.
 */
export function formatKz(value: unknown, decimals = 2): string {
  const num = Number(value);
  const safe = Number.isFinite(num) ? num : 0;
  const formatted = safe.toLocaleString('pt-AO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${formatted} Kz`;
}
