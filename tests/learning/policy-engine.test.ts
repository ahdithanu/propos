/**
 * LEARNING MODE: policy engine. Read docs/learning/policy-engine.md first.
 * Implement src/harness/policy/engine.ts until this file is green.
 */
import { describe, expect, it } from "vitest";
import { policySchema, type Policy } from "@/config/policy";
import { applyOverrides, evaluatePolicy } from "@/harness/policy/engine";
import {
  HARD_DENY_CATEGORIES,
  type ActionFacts, type PolicyInput, type PolicyToolInfo, type TierRule,
} from "@/harness/policy/types";
import { testPolicy } from "@/harness/testing";
import type { Tier } from "@/harness/types";

function policyWith(tools: Record<string, number> = {}, patch: (p: Policy) => void = () => {}): Policy {
  const policy = testPolicy().policy;
  policy.tiers.tools = tools as Policy["tiers"]["tools"];
  patch(policy);
  return policy;
}

const tool = (over: Partial<PolicyToolInfo> = {}): PolicyToolInfo => ({
  name: "t", kind: "action", baseTier: 0, categories: [], ...over,
});

/** An action tool configured at Tier 0 with a harmless templated message to the sender. */
const SAFE_FACTS: ActionFacts = {
  recipient: { known: true, kind: "tenant", isOwner: false, isEventContact: true },
  templateId: "ack_received",
};

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tool: tool(), facts: SAFE_FACTS, agentRequestedReview: false, policy: policyWith({ t: 0 }), ...over,
  };
}

const rules = (i: PolicyInput) => evaluatePolicy(i).reasons.map((r) => r.rule).sort();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("tool and config floors", () => {
  it("lets a safe, explicitly configured action through at Tier 0 with no reasons", () => {
    expect(evaluatePolicy(input())).toEqual({ tier: 0, reasons: [] });
  });

  it("puts an action tool that config does not mention at the default tier", () => {
    const decision = evaluatePolicy(input({ policy: policyWith({}) }));
    expect(decision.tier).toBe(2);
    expect(decision.reasons).toContainEqual({ rule: "config_floor", tier: 2 });
  });

  it("does not apply the default tier to read or draft tools", () => {
    for (const kind of ["read", "draft"] as const) {
      expect(evaluatePolicy(input({ tool: tool({ kind }), facts: {}, policy: policyWith({}) })))
        .toEqual({ tier: 0, reasons: [] });
    }
  });

  it("does apply an explicit config entry to a read tool", () => {
    const decision = evaluatePolicy(input({ tool: tool({ kind: "read" }), facts: {}, policy: policyWith({ t: 2 }) }));
    expect(decision.tier).toBe(2);
  });

  it("never lets config go below the floor declared in the tool's code", () => {
    const decision = evaluatePolicy(input({ tool: tool({ baseTier: 2 }), policy: policyWith({ t: 0 }) }));
    expect(decision.tier).toBe(2);
    expect(decision.reasons).toContainEqual({ rule: "tool_floor", tier: 2 });
  });

  it("lets config raise a tool above its code floor", () => {
    expect(evaluatePolicy(input({ tool: tool({ baseTier: 0 }), policy: policyWith({ t: 1 }) })).tier).toBe(1);
  });
});

describe("rules, one at a time (tool configured at Tier 0)", () => {
  const cases: [string, Partial<PolicyInput>, Tier, TierRule][] = [
    ["recipient not in contacts", { facts: { ...SAFE_FACTS, recipient: { known: false, isOwner: false, isEventContact: false } } }, 3, "unknown_recipient"],
    ["message contains another party's contact details", { facts: { ...SAFE_FACTS, containsOtherPartyPii: true } }, 3, "other_party_pii"],
    ["vendor with no prior job", { facts: { ...SAFE_FACTS, recipient: { known: true, kind: "vendor", isOwner: false, isEventContact: false, vendorHasPriorJob: false } } }, 2, "vendor_no_prior_job"],
    ["vendor whose job history is unknown", { facts: { ...SAFE_FACTS, recipient: { known: true, kind: "vendor", isOwner: false, isEventContact: false } } }, 2, "vendor_no_prior_job"],
    ["amount above the auto-approve limit", { facts: { ...SAFE_FACTS, amountCents: 1 } }, 2, "amount_over_auto_approve"],
    ["rent, lease or legal content", { facts: { ...SAFE_FACTS, sensitive: true } }, 2, "sensitive_content"],
    ["free text instead of a template", { facts: { ...SAFE_FACTS, templateId: null } }, 2, "free_text"],
    ["agent asked for review", { agentRequestedReview: true }, 2, "agent_requested_review"],
  ];

  it.each(cases)("%s", (_name, over, tier, rule) => {
    const decision = evaluatePolicy(input(over));
    expect(decision.tier).toBe(tier);
    expect(decision.reasons).toEqual([{ rule, tier }]);
  });

  it.each(HARD_DENY_CATEGORIES)("tool category %s is always Tier 3", (category) => {
    const decision = evaluatePolicy(input({ tool: tool({ categories: [category] }) }));
    expect(decision.tier).toBe(3);
    expect(decision.reasons).toContainEqual({ rule: "hard_deny_category", tier: 3 });
  });

  it("does not fire when the risky condition is absent", () => {
    const vendorWithHistory: ActionFacts = {
      recipient: { known: true, kind: "vendor", isOwner: false, isEventContact: false, vendorHasPriorJob: true },
      templateId: "ack_received", amountCents: 5000, sensitive: false, containsOtherPartyPii: false,
    };
    const policy = policyWith({ t: 0 }, (p) => { p.spend.auto_approve_max_cents = 5000; });
    expect(evaluatePolicy(input({ facts: vendorWithHistory, policy }))).toEqual({ tier: 0, reasons: [] });
  });

  it("treats the auto-approve limit as inclusive", () => {
    const policy = policyWith({ t: 0 }, (p) => { p.spend.auto_approve_max_cents = 5000; });
    expect(evaluatePolicy(input({ facts: { ...SAFE_FACTS, amountCents: 5000 }, policy })).tier).toBe(0);
    expect(evaluatePolicy(input({ facts: { ...SAFE_FACTS, amountCents: 5001 }, policy })).tier).toBe(2);
  });

  it("does not treat a tool that sends no message as free text", () => {
    expect(rules(input({ facts: { templateId: undefined } }))).toEqual([]);
  });

  it("applies the agent's review request to actions only, so the agent can still read", () => {
    for (const kind of ["read", "draft"] as const) {
      expect(evaluatePolicy(input({ tool: tool({ kind }), facts: {}, agentRequestedReview: true })).tier).toBe(0);
    }
  });
});

describe("combining rules", () => {
  it("reports every rule that applied, not only the one that decided the tier", () => {
    const i = input({
      tool: tool({ baseTier: 1 }),
      facts: { recipient: { known: false, isOwner: false, isEventContact: false }, templateId: null, sensitive: true, amountCents: 99999 },
      agentRequestedReview: true,
    });
    expect(evaluatePolicy(i).tier).toBe(3);
    expect(rules(i)).toEqual([
      "agent_requested_review", "amount_over_auto_approve", "free_text", "sensitive_content", "tool_floor", "unknown_recipient",
    ]);
  });

  it("cannot be talked down: a review request never lowers a Tier 3", () => {
    const i = input({ facts: { ...SAFE_FACTS, containsOtherPartyPii: true }, agentRequestedReview: true });
    expect(evaluatePolicy(i).tier).toBe(3);
  });

  it("gives the owner no special lowering: a message to the owner still respects the floors", () => {
    const facts: ActionFacts = { recipient: { known: true, kind: "owner", isOwner: true, isEventContact: false }, templateId: null };
    expect(evaluatePolicy(input({ tool: tool({ baseTier: 2 }), facts })).tier).toBe(2);
  });
});

describe("invariants over many inputs", () => {
  const recipients: ActionFacts["recipient"][] = [
    undefined,
    { known: true, kind: "tenant", isOwner: false, isEventContact: true },
    { known: true, kind: "vendor", isOwner: false, isEventContact: false, vendorHasPriorJob: true },
    { known: true, kind: "vendor", isOwner: false, isEventContact: false, vendorHasPriorJob: false },
    { known: true, kind: "owner", isOwner: true, isEventContact: false },
    { known: false, isOwner: false, isEventContact: false },
  ];
  const all: PolicyInput[] = [];
  for (const kind of ["read", "draft", "action"] as const)
    for (const baseTier of [0, 1, 2, 3] as const)
      for (const configured of [undefined, 0, 1, 2])
        for (const recipient of recipients)
          for (const templateId of [undefined, null, "ack_received"])
            for (const amountCents of [undefined, 0, 50000])
              for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
                all.push({
                  tool: tool({ kind, baseTier, categories: flags === 7 ? ["payment"] : [] }),
                  facts: { recipient, templateId, amountCents, sensitive: !!(flags & 1), containsOtherPartyPii: !!(flags & 2) },
                  agentRequestedReview: !!(flags & 4),
                  policy: policyWith(configured === undefined ? {} : { t: configured }),
                });
              }

  it("generated a meaningful number of cases", () => {
    expect(all.length).toBeGreaterThan(5000);
  });

  it("tier is never below the tool's code floor", () => {
    expect(all.filter((i) => evaluatePolicy(i).tier < i.tool.baseTier)).toEqual([]);
  });

  it("tier always equals the highest reason, and a non-zero tier always has a reason", () => {
    for (const i of all) {
      const d = evaluatePolicy(i);
      expect(d.tier).toBe(Math.max(0, ...d.reasons.map((r) => r.tier)));
    }
  });

  it("hard-deny conditions are Tier 3 whatever the config says", () => {
    const denied = all.filter(
      (i) => i.tool.categories.length || i.facts.containsOtherPartyPii || i.facts.recipient?.known === false,
    );
    expect(denied.length).toBeGreaterThan(1000);
    expect(denied.filter((i) => evaluatePolicy(i).tier !== 3)).toEqual([]);
  });

  it("is monotonic: adding a risk never lowers the tier", () => {
    const riskier: ((i: PolicyInput) => PolicyInput)[] = [
      (i) => ({ ...i, agentRequestedReview: true }),
      (i) => ({ ...i, facts: { ...i.facts, sensitive: true } }),
      (i) => ({ ...i, facts: { ...i.facts, containsOtherPartyPii: true } }),
      (i) => ({ ...i, facts: { ...i.facts, templateId: null } }),
      (i) => ({ ...i, facts: { ...i.facts, amountCents: (i.facts.amountCents ?? 0) + 1_000_000 } }),
      (i) => ({ ...i, facts: { ...i.facts, recipient: { known: false, isOwner: false, isEventContact: false } } }),
      (i) => ({ ...i, tool: { ...i.tool, baseTier: Math.min(3, i.tool.baseTier + 1) as Tier } }),
      (i) => ({ ...i, tool: { ...i.tool, categories: ["delete"] } }),
    ];
    for (const i of all) {
      const before = evaluatePolicy(i).tier;
      for (const bump of riskier) expect(evaluatePolicy(bump(i)).tier).toBeGreaterThanOrEqual(before);
    }
  });

  it("is pure: same input, same output, and the input is not modified", () => {
    for (const i of all.filter((_, n) => n % 97 === 0)) {
      const frozen = deepFreeze(structuredClone(i));
      expect(evaluatePolicy(frozen)).toEqual(evaluatePolicy(frozen));
    }
  });
});

describe("fails closed", () => {
  const bad = (over: unknown) => ({ ...input(), ...(over as object) }) as PolicyInput;
  const cases: [string, PolicyInput][] = [
    ["base tier out of range", bad({ tool: { ...tool(), baseTier: 5 } })],
    ["negative base tier", bad({ tool: { ...tool(), baseTier: -1 } })],
    ["unknown tool kind", bad({ tool: { ...tool(), kind: "superuser" } })],
    ["amount is NaN", bad({ facts: { ...SAFE_FACTS, amountCents: NaN } })],
    ["amount is negative", bad({ facts: { ...SAFE_FACTS, amountCents: -500 } })],
    ["amount is fractional", bad({ facts: { ...SAFE_FACTS, amountCents: 10.5 } })],
    ["amount is infinite", bad({ facts: { ...SAFE_FACTS, amountCents: Infinity } })],
    ["amount is a string", bad({ facts: { ...SAFE_FACTS, amountCents: "0" } })],
    ["configured tier is a string", bad({ policy: policyWith({ t: "0" as unknown as number }) })],
    ["configured tier is negative", bad({ policy: policyWith({ t: -1 }) })],
    ["configured tier is fractional", bad({ policy: policyWith({ t: 0.5 }) })],
    ["facts missing", bad({ facts: null })],
    ["tool missing", bad({ tool: undefined })],
    ["policy missing", bad({ policy: undefined })],
    ["categories missing", bad({ tool: { ...tool(), categories: undefined } })],
  ];

  it.each(cases)("%s -> Tier 3, no exception", (_name, i) => {
    const decision = evaluatePolicy(i);
    expect(decision.tier).toBe(3);
    expect(decision.reasons).toContainEqual({ rule: "invalid_input", tier: 3 });
  });

  it("survives null and undefined input", () => {
    expect(evaluatePolicy(null as unknown as PolicyInput).tier).toBe(3);
    expect(evaluatePolicy(undefined as unknown as PolicyInput).tier).toBe(3);
  });
});

describe("applyOverrides", () => {
  const TOOLS = ["send_ack", "send_template_message", "send_free_text_message", "wire_money"];
  const base = () => testPolicy().policy;

  it("returns an equal but separate policy when there are no overrides", () => {
    const policy = base();
    const result = applyOverrides(policy, [], TOOLS);
    expect(result).toEqual({ policy, applied: [], rejected: [] });
    expect(result.policy).not.toBe(policy);
    expect(result.policy.tiers).not.toBe(policy.tiers);
  });

  it("applies a tool tier and a numeric setting", () => {
    const result = applyOverrides(
      base(),
      [{ path: "tiers.tools.send_template_message", value: 1 }, { path: "spend.auto_approve_max_cents", value: 15000 }],
      TOOLS,
    );
    expect(result.policy.tiers.tools.send_template_message).toBe(1);
    expect(result.policy.spend.auto_approve_max_cents).toBe(15000);
    expect(result.applied).toEqual(["tiers.tools.send_template_message", "spend.auto_approve_max_cents"]);
    expect(result.rejected).toEqual([]);
  });

  it("never modifies the policy it was given", () => {
    const policy = deepFreeze(base());
    const result = applyOverrides(policy, [{ path: "undo_window_minutes", value: 3 }], TOOLS);
    expect(result.policy.undo_window_minutes).toBe(3);
    expect(policy.undo_window_minutes).toBe(10);
  });

  it.each([
    ["tier 3 via config", { path: "tiers.tools.send_ack", value: 3 }],
    ["negative tier", { path: "tiers.tools.send_ack", value: -1 }],
    ["tier as a string", { path: "tiers.tools.send_ack", value: "0" }],
    ["fractional tier", { path: "tiers.tools.send_ack", value: 0.5 }],
    ["null value", { path: "tiers.tools.send_ack", value: null }],
    ["a tool that does not exist", { path: "tiers.tools.send_sms_to_anyone", value: 0 }],
    ["default tier of 3", { path: "tiers.default_tool_tier", value: 3 }],
    ["zero undo window", { path: "undo_window_minutes", value: 0 }],
    ["negative spend limit", { path: "spend.auto_approve_max_cents", value: -1 }],
    ["agent caps", { path: "caps.max_steps", value: 500 }],
    ["model choice", { path: "models.agent", value: "some-other-model" }],
    ["memory review gate", { path: "memory.require_review", value: false }],
    ["emergency cooldown", { path: "emergency.cooldown_minutes", value: 100000 }],
    ["LLM spend cap", { path: "spend.llm_daily_cap_usd", value: 100000 }],
    ["a whole subtree", { path: "tiers", value: { default_tool_tier: 0, tools: {} } }],
    ["a whole tools map", { path: "tiers.tools", value: { send_free_text_message: 0 } }],
    ["an unknown path", { path: "nonsense.path", value: 1 }],
    ["an empty path", { path: "", value: 1 }],
    ["__proto__ as a tool name", { path: "tiers.tools.__proto__", value: 0 }],
    ["constructor as a tool name", { path: "tiers.tools.constructor", value: 0 }],
    ["__proto__ at the root", { path: "__proto__.polluted", value: true }],
    ["a nested path under a tool", { path: "tiers.tools.send_ack.extra", value: 0 }],
  ])("rejects %s and leaves the policy unchanged", (_name, override) => {
    const result = applyOverrides(base(), [override], [...TOOLS, "send_ack"]);
    expect(result.policy).toEqual(base());
    expect(result.applied).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.path).toBe(override.path);
    expect(result.rejected[0]!.reason.length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("applies the good overrides even when others are bad, and the last write wins", () => {
    const result = applyOverrides(
      base(),
      [
        { path: "undo_window_minutes", value: 5 },
        { path: "caps.max_steps", value: 999 },
        { path: "undo_window_minutes", value: 7 },
      ],
      TOOLS,
    );
    expect(result.policy.undo_window_minutes).toBe(7);
    expect(result.policy.caps.max_steps).toBe(12);
    expect(result.rejected.map((r) => r.path)).toEqual(["caps.max_steps"]);
  });

  it("always returns a policy that passes the schema", () => {
    const hostile = [
      { path: "tiers.tools.send_ack", value: 3 }, { path: "tiers.tools.wire_money", value: 0 },
      { path: "rate_limits.sms_per_recipient_per_day", value: "lots" }, { path: "approvals.code_ttl_hours", value: 24 },
    ];
    const result = applyOverrides(base(), hostile, [...TOOLS, "send_ack"]);
    expect(() => policySchema.parse(result.policy)).not.toThrow();
  });

  it("cannot be used to get below a code floor or around a hard deny", () => {
    const { policy } = applyOverrides(
      base(),
      [{ path: "tiers.tools.send_free_text_message", value: 0 }, { path: "tiers.tools.wire_money", value: 0 }, { path: "tiers.default_tool_tier", value: 0 }],
      TOOLS,
    );
    const freeText = evaluatePolicy({
      tool: { name: "send_free_text_message", kind: "action", baseTier: 2, categories: [] },
      facts: SAFE_FACTS, agentRequestedReview: false, policy,
    });
    const payment = evaluatePolicy({
      tool: { name: "wire_money", kind: "action", baseTier: 0, categories: ["payment"] },
      facts: SAFE_FACTS, agentRequestedReview: false, policy,
    });
    expect(freeText.tier).toBe(2);
    expect(payment.tier).toBe(3);
  });
});
