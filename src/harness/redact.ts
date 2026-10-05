/**
 * Redaction for logs, traces and audit entries. Best effort by pattern: it
 * catches the common shapes of phone numbers, emails and US street addresses,
 * not every way a person can write one.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// +1 408 555 0111, (408) 555-0111, 408.555.0111, 4085550111, 555-0111
const PHONE = /(?<![\w$])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)|(?<![\w$-])\d{3}[\s.-]\d{4}(?![\d-])/g;
const STREET_SUFFIX =
  "st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|way|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway";
const ADDRESS = new RegExp(
  `\\b\\d{1,6}\\s+(?:[A-Za-z0-9.'-]+\\s+){0,4}(?:${STREET_SUFFIX})\\b\\.?` +
    `(?:,?\\s+(?:apt|unit|suite|ste|#)\\s*[A-Za-z0-9-]+)?` +
    `(?:,\\s*[A-Za-z .]+,\\s*[A-Z]{2}(?:\\s+\\d{5}(?:-\\d{4})?)?)?`,
  "gi",
);

export function redact(text: string): string {
  return text.replace(EMAIL, "[EMAIL]").replace(ADDRESS, "[ADDR]").replace(PHONE, "[PHONE]");
}

/** Redacts every string inside a JSON-like value, including object keys' values at any depth. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value instanceof Date) return value;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

function digits(s: string) {
  return s.replace(/\D/g, "");
}

/**
 * True when `text` contains a phone or email belonging to a contact other than
 * the recipient. Used to stop one party's contact details leaking to another.
 */
export function containsOtherPartyPii(
  text: string,
  recipientId: string,
  contacts: { id: string; phone?: string; email?: string }[],
): boolean {
  const lower = text.toLowerCase();
  const textDigits = digits(text);
  return contacts.some((c) => {
    if (c.id === recipientId) return false;
    if (c.email && lower.includes(c.email.toLowerCase())) return true;
    // Compare the last ten digits so "+1 (408) 555-0111" and "4085550111" both match.
    const national = c.phone ? digits(c.phone).slice(-10) : "";
    return national.length === 10 && textDigits.includes(national);
  });
}
