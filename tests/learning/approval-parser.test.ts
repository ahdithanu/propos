/**
 * LEARNING MODE: owner SMS parser. Read docs/learning/approval-flow.md first.
 * Implement src/harness/approvals/parser.ts until this file is green.
 */
import { describe, expect, it } from "vitest";
import { parseOwnerSms } from "@/harness/approvals/parser";

describe("approve, reject, undo", () => {
  it.each([
    "Y-4821", "y-4821", "  Y-4821  ", "Y 4821", "Y4821", "y - 4821", "Y-4821.", "Y-4821!", "Y-4821\n",
    "Yes 4821", "YES-4821", "yes4821",
    "Y–4821", // en dash: phones turn "--" into this
    "Y—4821", // em dash
    "Y‑4821", // non-breaking hyphen
    "Y−4821", // minus sign
    "Ｙ-４８２１", // full-width, from a CJK keyboard
    "Y​-4821", // zero-width space from copy and paste
  ])("approve: %j", (text) => {
    expect(parseOwnerSms(text)).toEqual({ kind: "approve", code: "4821" });
  });

  it.each(["N-4821", "n 4821", "No 4821", "NO-4821", "N4821", "n–4821."])("reject: %j", (text) => {
    expect(parseOwnerSms(text)).toEqual({ kind: "reject", code: "4821" });
  });

  it.each(["U-4821", "u 4821", "Undo 4821", "UNDO-4821", "U4821"])("undo: %j", (text) => {
    expect(parseOwnerSms(text)).toEqual({ kind: "undo", code: "4821" });
  });

  it("keeps the code as text, leading zero included", () => {
    expect(parseOwnerSms("Y-0421")).toEqual({ kind: "approve", code: "0421" });
  });
});

describe("things that must never count as approval", () => {
  it.each([
    "Y-482", // too short
    "Y-48211", // too long: must not approve 4821
    "Y-4821-2",
    "Y-4821 but cap it at $300", // a condition is a revision, not an approval
    "Y-4821 and tell him Thursday",
    "Y-4821?", // a question is not a decision
    "don't Y-4821",
    "not Y-4821",
    "N Y-4821",
    "Y-4821 N-4821",
    "Y-4821 Y-1234",
    "Y-4821\nN-4821",
    "Y- 48 21",
    "Y-O821", // letter O
    "Y-48Z1",
    "YY-4821",
    "MY-4821",
    "okY-4821",
    "Y", "yes", "y-", "yes please",
    "4821",
    "Y-4821 Y-4821",
    "approve 4821 if under $200",
  ])("%j", (text) => {
    expect(parseOwnerSms(text).kind).not.toBe("approve");
  });

  it.each(["N-482", "N-48211", "U-482", "N-4821 N-1234"])("no partial reject or undo either: %j", (text) => {
    expect(["reject", "undo"]).not.toContain(parseOwnerSms(text).kind);
  });
});

describe("pause, resume, status", () => {
  it.each([
    ["PAUSE", "pause"], ["pause", "pause"], ["  Pause.  ", "pause"], ["PAUSE!", "pause"],
    ["RESUME", "resume"], ["resume", "resume"], ["Resume.", "resume"],
    ["STATUS", "status"], ["status", "status"], ["Status.", "status"],
  ])("%j -> %s", (text, kind) => {
    expect(parseOwnerSms(text)).toEqual({ kind });
  });

  it.each([
    "pause the sprinklers", "please pause", "pause?", "unpause", "PAUSED", "pause resume",
    "resume the plumber job", "what's the status of the leak", "STOP", "pausa",
  ])("is not a control command: %j", (text) => {
    expect(["pause", "resume", "status"]).not.toContain(parseOwnerSms(text).kind);
  });
});

describe("revisions", () => {
  it.each([
    ["4821 make it $300 max", ["4821"]],
    ["make it $300 max for 4821", ["4821"]],
    ["#4821 ask for Thursday instead", ["4821"]],
    ["4821: too expensive", ["4821"]],
    ["Y-4821 but cap it at $300", ["4821"]],
    ["N-4821 too expensive, ask for $200", ["4821"]],
    ["4821 make it 2500 max", ["4821", "2500"]],
    ["4821 4821 redo it", ["4821"]],
    ["see you in 2026", ["2026"]], // the parser cannot know this is a year; the flow checks open codes
  ])("%j -> candidates %j", (text, candidateCodes) => {
    expect(parseOwnerSms(text)).toEqual({ kind: "revise", candidateCodes, instruction: text });
  });

  it("trims the instruction but otherwise keeps the owner's words", () => {
    expect(parseOwnerSms("  4821   make it Thursday  ")).toMatchObject({ kind: "revise", instruction: "4821   make it Thursday" });
  });

  it.each([
    "the invoice was $4821", // money
    "it cost 4821.50",
    "about 4,821 dollars",
    "$ 4821 is too much",
    "call me at 408-555-4821", // phone number
    "call 555.4821",
    "12345 is my zip", // five digits
    "order 48211234",
    "4821", // a bare code says nothing to do
    "what's going on with the plumber?",
    "thanks",
  ])("is not a revision: %j", (text) => {
    expect(parseOwnerSms(text)).toEqual({ kind: "unrecognized" });
  });
});

describe("robustness", () => {
  it.each(["", "   ", "\n\n", "👍", "🙏🙏"])("unrecognized: %j", (text) => {
    expect(parseOwnerSms(text)).toEqual({ kind: "unrecognized" });
  });

  it("never throws on non-string input", () => {
    for (const bad of [undefined, null, 4821, {}, ["Y-4821"]]) {
      expect(parseOwnerSms(bad as unknown as string)).toEqual({ kind: "unrecognized" });
    }
  });

  it("handles a very long message quickly", () => {
    const start = performance.now();
    parseOwnerSms(`${"Y-4821 ".repeat(20000)}`);
    parseOwnerSms("-".repeat(100000));
    parseOwnerSms(`Y${" ".repeat(100000)}4821x`);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("is pure", () => {
    for (const text of ["Y-4821", "4821 make it Thursday", "PAUSE", "hello"]) {
      expect(parseOwnerSms(text)).toEqual(parseOwnerSms(text));
    }
  });
});
