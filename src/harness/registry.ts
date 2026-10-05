import type { z } from "zod";
import type { Policy, Templates } from "@/config/policy";
import { sha256, stableStringify } from "@/config/hash";
import type { DeliverRequest, DeliverResult } from "./deliver";
import type { ExecuteOutcome } from "./approvals/types";
import type { ActionFacts, PolicyDecision, PolicyEvaluator, ToolCategory, ToolKind } from "./policy/types";
import type { Ports } from "./ports";
import { redactDeep } from "./redact";
import type { Store } from "./store";
import type { Contact, Tier } from "./types";

export interface ToolContext {
  store: Store;
  ports: Ports;
  policy: Policy;
  templates: Templates;
  now: () => Date;
  /** The contact whose message triggered this run. Tools may only act within its scope. */
  scopeContact?: Contact;
  runId?: string;
  eventId?: string;
  /** The only way a tool may message a contact. */
  deliver: (req: DeliverRequest) => Promise<DeliverResult>;
  /** Marks the rest of this run as needing owner review. Cannot be undone. */
  requestReview: () => void;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  kind: ToolKind;
  baseTier: Tier;
  categories?: ToolCategory[];
  /** True for tools that only ever reach the owner; these run even when paused. */
  ownerDirected?: boolean;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  timeoutMs: number;
  /** Cap on calls to this tool within one run. */
  maxCallsPerRun?: number;
  /** Facts for the policy engine. Omit for tools with nothing to assess. */
  facts?: (args: I, ctx: ToolContext) => Promise<ActionFacts>;
  /** One line for the owner's approval or undo text. */
  summarize?: (args: I, ctx: ToolContext) => Promise<string>;
  execute: (args: I, ctx: ToolContext, meta: { idempotencyKey: string; actionId?: string }) => Promise<O>;
}

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

/** Thrown by a tool when delivery was refused at send time. Not a bug; the executor records it. */
export class DeliveryBlocked extends Error {
  constructor(public readonly result: Exclude<DeliverResult, { status: "sent" }>) {
    super(`delivery blocked: ${result.status}`);
  }
}

/** Thrown by a tool when the call is outside the scope of the triggering contact. */
export class ScopeError extends Error {}

export type ToolCallResult =
  | { status: "ok"; output: unknown; tier: Tier }
  | { status: "held"; actionId: string; tier: 1; sendAt: Date; note: string }
  | { status: "pending_approval"; actionId: string; tier: 2; note: string }
  | { status: "refused"; actionId: string; tier: 3; reasons: string[]; note: string }
  | { status: "blocked_paused"; actionId: string; note: string }
  | {
      status: "error";
      error: "unknown_tool" | "invalid_args" | "call_limit" | "timeout" | "out_of_scope" | "execution_failed";
      message: string;
    };

export interface SubmitInput {
  tool: ToolDef;
  args: unknown;
  decision: PolicyDecision;
  summary: string;
  idempotencyKey: string;
  ctx: ToolContext;
}

/** Implemented by the outbox; injected so the registry can be tested alone. */
export interface ActionSink {
  submit(input: SubmitInput): Promise<ToolCallResult>;
}

const DEFAULT_MAX_CALLS_PER_RUN = 8;

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeout(ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class ToolTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
  }
}

export function reasonStrings(decision: PolicyDecision): string[] {
  return decision.reasons.map((r) => `${r.rule}:${r.tier}`);
}

/**
 * Wraps every tool call with: lookup, per-run call cap, input validation, fact
 * gathering, policy evaluation, an audit entry, and routing by tier. The model
 * supplies only a tool name and raw args; it never sees or sets a tier.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private callCounts = new Map<string, number>();
  private reviewRequested = new Set<string>();

  constructor(
    tools: ToolDef<never, unknown>[] | ToolDef[],
    private evaluate: PolicyEvaluator,
    private sink: ActionSink,
  ) {
    for (const tool of tools as ToolDef[]) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  private runKey(ctx: Pick<ToolContext, "runId" | "eventId">): string {
    return ctx.runId ?? ctx.eventId ?? "no-run";
  }

  async call(
    base: Omit<ToolContext, "requestReview">,
    name: string,
    rawArgs: unknown,
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) return { status: "error", error: "unknown_tool", message: `No tool named "${name}"` };

    const runKey = this.runKey(base);
    const ctx: ToolContext = { ...base, requestReview: () => this.reviewRequested.add(runKey) };

    const countKey = `${runKey}:${name}`;
    const count = (this.callCounts.get(countKey) ?? 0) + 1;
    this.callCounts.set(countKey, count);
    const cap = tool.maxCallsPerRun ?? DEFAULT_MAX_CALLS_PER_RUN;
    if (count > cap) {
      return { status: "error", error: "call_limit", message: `${name} may be called at most ${cap} times per run` };
    }

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { status: "error", error: "invalid_args", message: issues };
    }
    const args = parsed.data;

    let decision: PolicyDecision;
    let summary: string;
    try {
      const facts = tool.facts ? await tool.facts(args, ctx) : {};
      summary = tool.summarize ? await tool.summarize(args, ctx) : tool.name;
      decision = this.decide(tool, facts, runKey, ctx.policy);
    } catch (err) {
      if (err instanceof ScopeError) return { status: "error", error: "out_of_scope", message: err.message };
      throw err;
    }

    await ctx.store.audit({
      at: ctx.now(),
      actor: "agent",
      action: "tool.call",
      entity: "tool",
      entityId: tool.name,
      details: { args: redactDeep(args), tier: decision.tier, reasons: reasonStrings(decision) },
      runId: ctx.runId,
    });

    const idempotencyKey = `${runKey}:${tool.name}:${sha256(stableStringify(args)).slice(0, 16)}`;

    // Reads and record-keeping at Tier 0 run inline. Anything with an outside
    // effect, or anything the policy raised, goes through the outbox.
    if (decision.tier === 0 && tool.kind !== "action") {
      try {
        const output = await withTimeout(tool.execute(args, ctx, { idempotencyKey }), tool.timeoutMs);
        return { status: "ok", output: tool.output.parse(output), tier: 0 };
      } catch (err) {
        if (err instanceof ToolTimeout) return { status: "error", error: "timeout", message: err.message };
        if (err instanceof ScopeError) return { status: "error", error: "out_of_scope", message: err.message };
        return { status: "error", error: "execution_failed", message: (err as Error).message };
      }
    }
    return this.sink.submit({ tool, args, decision, summary, idempotencyKey, ctx });
  }

  /** Fail closed: if the engine throws or returns nonsense, the call is Tier 3. */
  private decide(tool: ToolDef, facts: ActionFacts, runKey: string, policy: Policy): PolicyDecision {
    try {
      const decision = this.evaluate({
        tool: { name: tool.name, kind: tool.kind, baseTier: tool.baseTier, categories: tool.categories ?? [] },
        facts,
        agentRequestedReview: this.reviewRequested.has(runKey),
        policy,
      });
      if (![0, 1, 2, 3].includes(decision?.tier) || !Array.isArray(decision.reasons)) {
        throw new Error("policy engine returned an invalid decision");
      }
      return decision;
    } catch {
      return { tier: 3, reasons: [{ rule: "invalid_input", tier: 3 }] };
    }
  }
}

export type { ExecuteOutcome };
