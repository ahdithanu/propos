/**
 * LEARNING MODE — yours to implement. See docs/learning/emergency-path.md and
 * tests/learning/emergency-detect.test.ts. The rules themselves go in
 * policy/emergency-rules.yaml.
 */
import type { EmergencyMatch, EmergencyRuleSet } from "./types";

/**
 * Lowercases, strips accents and zero-width characters, and collapses whitespace,
 * so rules can be written once in plain ASCII.
 */
export function normalizeForRules(text: string): string {
  void text;
  throw new Error("Not implemented: normalizeForRules");
}

/** Rules only, no model. Returns the first matching rule, or null. Must never throw. */
export function detectEmergency(text: string, rules: EmergencyRuleSet): EmergencyMatch | null {
  void text; void rules;
  throw new Error("Not implemented: detectEmergency");
}
