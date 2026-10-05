import { describe, expect, it } from "vitest";
import { containsOtherPartyPii, redact, redactDeep } from "@/harness/redact";

describe("redact", () => {
  it.each([
    ["call me at +1 408 555 0111 please", "call me at [PHONE] please"],
    ["(408) 555-0111", "[PHONE]"],
    ["408.555.0111 or 4085550111", "[PHONE] or [PHONE]"],
    ["my cell is 555-0111", "my cell is [PHONE]"],
    ["write to Maria.Alvarez+rent@example.com today", "write to [EMAIL] today"],
    ["I live at 100 Example Maple Ct, San Jose, CA 95100", "I live at [ADDR]"],
    ["send it to 42 Oak Street Apt 3B", "send it to [ADDR]"],
  ])("%s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each([
    "the quote is $4821 for the furnace",
    "approval code 4821",
    "it happened in 2026 around 10:30",
    "3 outlets and 2 windows on the 1st floor",
    "order 123456 shipped",
  ])("leaves non-PII alone: %s", (input) => {
    expect(redact(input)).toBe(input);
  });

  it("redacts strings at any depth and leaves other values intact", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(redactDeep({ a: ["x@example.com", 5], b: { c: "408-555-0111", d: null, at } })).toEqual({
      a: ["[EMAIL]", 5], b: { c: "[PHONE]", d: null, at },
    });
  });
});

describe("containsOtherPartyPii", () => {
  const contacts = [
    { id: "tenant", phone: "+14085550111", email: "maria@example.com" },
    { id: "plumber", phone: "+14085550121", email: "dispatch@bayline.example.com" },
  ];

  it("flags another contact's phone in any common format, and their email in any case", () => {
    expect(containsOtherPartyPii("Call Maria at (408) 555-0111", "plumber", contacts)).toBe(true);
    expect(containsOtherPartyPii("Call 408.555.0111", "plumber", contacts)).toBe(true);
    expect(containsOtherPartyPii("email MARIA@example.com", "plumber", contacts)).toBe(true);
  });

  it("allows the recipient's own details and unrelated numbers", () => {
    expect(containsOtherPartyPii("We have you at 408-555-0111", "tenant", contacts)).toBe(false);
    expect(containsOtherPartyPii("Quote is $185.00, visit at 10", "tenant", contacts)).toBe(false);
  });
});
