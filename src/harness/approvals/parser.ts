/**
 * LEARNING MODE — yours to implement. See docs/learning/approval-flow.md and
 * tests/learning/approval-parser.test.ts.
 */
import type { OwnerCommand } from "./types";

/** Deterministic, pure, total. Runs before any model sees the owner's text. */
export function parseOwnerSms(text: string): OwnerCommand {
  void text;
  throw new Error("Not implemented: parseOwnerSms");
}
