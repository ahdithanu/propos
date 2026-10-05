/**
 * LEARNING MODE — yours to implement. See docs/learning/policy-engine.md and
 * tests/learning/policy-engine.test.ts. Types are in ./types.ts.
 */
import type { Policy } from "@/config/policy";
import type { OverrideResult, PolicyDecision, PolicyInput, PolicyOverride } from "./types";

/** Computes the effective tier for one tool call. Pure, total, and fail-closed. */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  void input;
  throw new Error("Not implemented: evaluatePolicy");
}

/** Applies dashboard overrides on top of the file policy. Invalid overrides are rejected, not applied. */
export function applyOverrides(
  policy: Policy,
  overrides: PolicyOverride[],
  knownToolNames: string[],
): OverrideResult {
  void policy; void overrides; void knownToolNames;
  throw new Error("Not implemented: applyOverrides");
}
