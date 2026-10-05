import type { Policy, Templates } from "@/config/policy";
import type { ExecuteOutcome } from "./approvals/types";
import { deliver, type DeliverRequest } from "./deliver";
import type { Ports } from "./ports";
import { redactDeep } from "./redact";
import {
  DeliveryBlocked, ToolTimeout, reasonStrings, withTimeout,
  type ActionSink, type SubmitInput, type ToolCallResult, type ToolContext, type ToolDef,
} from "./registry";
import type { Store } from "./store";
import type { Action } from "./types";

export interface OutboxDeps {
  store: Store;
  ports: Ports;
  getPolicy: () => Policy;
  templates: Templates;
  now: () => Date;
  getTool: (name: string) => ToolDef | undefined;
  /** Returns a float in [0, 1). Injected so tests are deterministic. */
  random?: () => number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A random 4-digit code that no open action is using. */
export function generateApprovalCode(openCodes: Set<string>, random: () => number): string {
  if (openCodes.size >= 9000) throw new Error("no approval codes left");
  for (;;) {
    // 1000-9999: no leading zero, so a phone keyboard or autocorrect cannot shorten it.
    const code = String(1000 + Math.floor(random() * 9000));
    if (!openCodes.has(code)) return code;
  }
}

/**
 * The outbox turns a tier decision into a stored action and, when the time
 * comes, runs it. Tier 0 runs now, Tier 1 after the undo window, Tier 2 after
 * owner approval, Tier 3 never.
 */
export class Outbox implements ActionSink {
  constructor(private deps: OutboxDeps) {}

  private async notifyOwner(text: string, key: string) {
    const { store, ports, now } = this.deps;
    const owner = await store.getOwner();
    await deliver(
      { store, ports, policy: this.deps.getPolicy(), now },
      { contactId: owner.contactId, channel: "sms", body: text, idempotencyKey: key },
    );
  }

  async submit(input: SubmitInput): Promise<ToolCallResult> {
    const { store, now } = this.deps;
    const policy = this.deps.getPolicy();
    const { tool, args, decision, summary, idempotencyKey, ctx } = input;
    const at = now();
    const base = {
      runId: ctx.runId,
      scopeContactId: ctx.scopeContact?.id,
      toolName: tool.name,
      args,
      summary,
      effectiveTier: decision.tier,
      tierReasons: reasonStrings(decision),
      idempotencyKey,
      createdAt: at,
    } satisfies Partial<Action>;

    const needsCode = decision.tier === 1 || decision.tier === 2;
    const openCodes = new Set(
      (await store.listActions({ status: ["held", "pending_approval"] })).flatMap((a) => a.approvalCode ?? []),
    );
    const code = needsCode ? generateApprovalCode(openCodes, this.deps.random ?? Math.random) : undefined;

    const status = (["approved", "held", "pending_approval", "refused"] as const)[decision.tier];
    const { action, inserted } = await store.insertAction({
      ...base,
      status,
      approvalCode: code,
      sendAt: decision.tier === 1 ? new Date(at.getTime() + policy.undo_window_minutes * MINUTE_MS) : undefined,
      codeExpiresAt: decision.tier === 2 ? new Date(at.getTime() + policy.approvals.code_ttl_hours * HOUR_MS) : undefined,
    });

    // The same call repeated within a run: report the existing action, send nothing new.
    if (!inserted) return this.describe(action, "This exact action was already submitted in this run.");

    await store.audit({
      at, actor: "agent", action: `action.${status}`, entity: "action", entityId: action.id,
      details: { tool: tool.name, tier: decision.tier, reasons: action.tierReasons, args: redactDeep(args) },
      runId: ctx.runId,
    });

    switch (decision.tier) {
      case 0: {
        const outcome = await this.execute(action.id);
        if (outcome.status === "executed") return { status: "ok", output: outcome.result, tier: 0 };
        if (outcome.status === "blocked_paused") {
          return { status: "blocked_paused", actionId: action.id, note: "The system is paused. Nothing was sent." };
        }
        return {
          status: "error", error: "execution_failed",
          message: outcome.status === "failed" ? outcome.error : outcome.reason,
        };
      }
      case 1:
        await this.notifyOwner(
          `Sending in ${policy.undo_window_minutes} min: ${summary}. Reply U-${code} to undo.`,
          `notify:${action.id}`,
        );
        return this.describe(action);
      case 2:
        await this.notifyOwner(`Approve? ${summary}. Reply Y-${code} or N-${code}.`, `notify:${action.id}`);
        return this.describe(action);
      default:
        await this.notifyOwner(
          `Refused (not allowed): ${summary}. Reasons: ${action.tierReasons.join(", ")}.`,
          `notify:${action.id}`,
        );
        return this.describe(action);
    }
  }

  /** What the model is told. It learns the state, never the approval code. */
  private describe(action: Action, prefix = ""): ToolCallResult {
    const note = (text: string) => [prefix, text].filter(Boolean).join(" ");
    switch (action.status) {
      case "held":
        return {
          status: "held", actionId: action.id, tier: 1, sendAt: action.sendAt!,
          note: note("Scheduled to send after the owner's undo window."),
        };
      case "pending_approval":
        return {
          status: "pending_approval", actionId: action.id, tier: 2,
          note: note("Queued for owner approval. It has not been sent. You may acknowledge the sender."),
        };
      case "refused":
        return {
          status: "refused", actionId: action.id, tier: 3, reasons: action.tierReasons,
          note: note("Not allowed. The owner has been told. Do not retry."),
        };
      case "blocked_paused":
        return { status: "blocked_paused", actionId: action.id, note: note("The system is paused. Nothing was sent.") };
      case "executed":
        return { status: "ok", output: action.executedResult, tier: 0 };
      default:
        return { status: "error", error: "execution_failed", message: note(`Action is ${action.status}.`) };
    }
  }

  private contextFor(action: Action, scopeContact: ToolContext["scopeContact"]): ToolContext {
    const { store, ports, templates, now } = this.deps;
    const policy = this.deps.getPolicy();
    return {
      store, ports, policy, templates, now, scopeContact, runId: action.runId,
      deliver: (req: DeliverRequest) => deliver({ store, ports, policy, now }, { ...req, actionId: action.id }),
      requestReview: () => {},
    };
  }

  /**
   * Runs an approved action from its stored args. Safe to call twice: the
   * status change is compare-and-set, so only one caller executes.
   */
  async execute(actionId: string): Promise<ExecuteOutcome> {
    const { store, now } = this.deps;
    const claimed = await store.transitionAction(actionId, ["approved", "blocked_paused"], "executing");
    if (!claimed) {
      const current = await store.getAction(actionId);
      return { status: "skipped", reason: current ? `action is ${current.status}` : "action not found" };
    }

    const finish = async (to: "executed" | "failed" | "blocked_paused", result: unknown, outcome: ExecuteOutcome) => {
      await store.transitionAction(actionId, ["executing"], to, { executedResult: result });
      await store.audit({
        at: now(), actor: "system", action: `action.${to}`, entity: "action", entityId: actionId,
        details: { tool: claimed.toolName, result: redactDeep(result) }, runId: claimed.runId,
      });
      return outcome;
    };

    const tool = this.deps.getTool(claimed.toolName);
    if (!tool) return finish("failed", { error: "unknown_tool" }, { status: "failed", error: "unknown_tool" });

    // Checked here, at execution time, so an action approved or held before a
    // pause still stops. deliver() checks again per message.
    if (!tool.ownerDirected && (await store.getSystemState()).paused) {
      return finish("blocked_paused", { blocked: "paused" }, { status: "blocked_paused" });
    }

    // Stored args were validated when proposed; validate again in case the tool changed since.
    const parsed = tool.input.safeParse(claimed.args);
    if (!parsed.success) {
      return finish("failed", { error: "stored_args_invalid" }, { status: "failed", error: "stored_args_invalid" });
    }

    const scopeContact = claimed.scopeContactId
      ? ((await store.getContact(claimed.scopeContactId)) ?? undefined)
      : undefined;
    try {
      const result = await withTimeout(
        tool.execute(parsed.data, this.contextFor(claimed, scopeContact), {
          idempotencyKey: claimed.idempotencyKey,
          actionId,
        }),
        tool.timeoutMs,
      );
      return finish("executed", result, { status: "executed", result });
    } catch (err) {
      if (err instanceof DeliveryBlocked && err.result.status === "blocked_paused") {
        return finish("blocked_paused", { blocked: "paused" }, { status: "blocked_paused" });
      }
      const error =
        err instanceof DeliveryBlocked ? err.result.status
        : err instanceof ToolTimeout ? "timeout"
        : (err as Error).message;
      return finish("failed", { error }, { status: "failed", error });
    }
  }

  /** Sends Tier 1 actions whose undo window has passed. Called by a scheduled tick. */
  async releaseDue(): Promise<ExecuteOutcome[]> {
    const { store, now } = this.deps;
    const at = now();
    const outcomes: ExecuteOutcome[] = [];
    for (const action of await store.listActions({ status: ["held"] })) {
      if (!action.sendAt || action.sendAt > at) continue;
      // If the owner's undo won the race, this returns null and nothing is sent.
      if (await store.transitionAction(action.id, ["held"], "approved")) {
        outcomes.push(await this.execute(action.id));
      }
    }
    return outcomes;
  }

  /** Expires approvals nobody answered. Called by a scheduled tick. */
  async expireStale(): Promise<string[]> {
    const { store, now } = this.deps;
    const at = now();
    const expired: string[] = [];
    for (const action of await store.listActions({ status: ["pending_approval"] })) {
      if (!action.codeExpiresAt || action.codeExpiresAt > at) continue;
      if (await store.transitionAction(action.id, ["pending_approval"], "expired")) {
        expired.push(action.id);
        await store.audit({
          at, actor: "system", action: "action.expired", entity: "action", entityId: action.id,
          details: { tool: action.toolName },
        });
      }
    }
    return expired;
  }
}
