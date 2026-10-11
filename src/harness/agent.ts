import { z } from "zod";
import type { LoadedPolicy } from "@/config/policy";
import type { LoadedPrompt } from "@/config/prompts";
import { buildContext, type RevisionContext } from "./context";
import { handleDegraded, type DegradedReason } from "./degraded";
import { deliver } from "./deliver";
import type { Harness } from "./index";
import { LlmUnavailable, costUsd, type LlmMessage, type LlmPort, type LlmTool, type LlmToolResult } from "./llm";
import type { Ports } from "./ports";
import { redact, redactDeep } from "./redact";
import type { Store } from "./store";
import type { AgentRun, AgentStep, RunOutcomeKind } from "./types";

export interface AgentDeps {
  store: Store;
  ports: Ports;
  llm: LlmPort;
  harness: Harness;
  loaded: LoadedPolicy;
  prompt: LoadedPrompt;
  now: () => Date;
}

/** What the model hands back when it is done. Validated; never trusted as-is. */
export const runOutcomeSchema = z.strictObject({
  outcome: z.enum(["completed", "escalated"]),
  summary: z.string().min(1).max(600),
  escalation_reason: z.string().max(300).optional(),
});
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

const FINISH_TOOL: LlmTool = {
  name: "finish",
  description:
    "End this run. Call it once the event is handled or handed to the owner. " +
    'Use outcome "escalated" when the owner has to take it from here.',
  inputSchema: z.toJSONSchema(runOutcomeSchema) as Record<string, unknown>,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_TOKENS_PER_TURN = 8000;
const THOUGHT_MAX_CHARS = 500;

function toolList(harness: Harness): LlmTool[] {
  const tools = harness.registry.names().map((name) => {
    const tool = harness.registry.get(name)!;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>,
    };
  });
  return [...tools, FINISH_TOOL];
}

/**
 * Runs the agent on one event, to completion or to a cap. Every step is
 * persisted as it happens. This function does not throw for anything the model
 * or a tool does: a run always ends with a recorded outcome.
 */
export async function runAgent(
  deps: AgentDeps,
  eventId: string,
  opts: { revision?: RevisionContext } = {},
): Promise<AgentRun> {
  const { store, harness } = deps;
  const policy = harness.getPolicy();
  const event = await store.getEvent(eventId);
  if (!event) throw new Error(`event not found: ${eventId}`);

  // A revision acts for the contact the original action was about, not for the owner who sent the edit.
  const scopeId = opts.revision ? opts.revision.action.scopeContactId : event.contactId;
  const contact = scopeId ? await store.getContact(scopeId) : null;

  const startedAt = deps.now();
  const run = await store.createRun({
    eventId, promptName: deps.prompt.name, promptVersion: deps.prompt.version,
    policyHash: deps.loaded.hash, model: policy.models.agent, startedAt,
  });
  await store.setEventStatus(eventId, "processing");

  const totals = { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let stepIdx = 0;
  const step = (s: Omit<AgentStep, "runId" | "idx" | "createdAt">) =>
    store.appendStep({ ...s, runId: run.id, idx: stepIdx++, createdAt: deps.now() });

  const finish = async (outcome: RunOutcomeKind, summary: string, escalationReason?: string): Promise<AgentRun> => {
    const finishedAt = deps.now();
    await step({ type: "final", output: { outcome, summary: redact(summary), escalationReason } });
    await store.finishRun(run.id, {
      outcome, summary: redact(summary), escalationReason, ...totals,
      latencyMs: finishedAt.getTime() - startedAt.getTime(), finishedAt,
    });
    await store.setEventStatus(eventId, outcome === "failed" ? "failed" : "done");
    return (await store.getRun(run.id))!;
  };

  /** The harness, not the model, tells the owner when a run stops short. */
  const stopShort = async (outcome: RunOutcomeKind, reason: string): Promise<AgentRun> => {
    const who = contact ? `${contact.kind} ${contact.displayName}` : "an unknown sender";
    await deliver(
      { store, ports: deps.ports, policy, now: deps.now },
      {
        contactId: (await store.getOwner()).contactId, channel: "sms",
        body: `Stopped early (${reason}) while handling a message from ${who}. Please check it.`,
        idempotencyKey: `run-stop:${run.id}`,
      },
    ).catch(() => undefined);
    return finish(outcome, `Stopped early: ${reason}.`, reason);
  };

  const degrade = async (reason: DegradedReason): Promise<AgentRun> => {
    await handleDegraded(
      { store, ports: deps.ports, policy, templates: deps.loaded.templates, now: deps.now },
      event, contact, reason,
    );
    return finish("escalated", `Degraded mode: ${reason}.`, `degraded:${reason}`);
  };

  try {
    const spentToday = await store.sumRunCostSince(new Date(startedAt.getTime() - DAY_MS));
    if (spentToday >= policy.spend.llm_daily_cap_usd) return await degrade("spend_cap");

    const ctx = harness.contextFor({
      contact: contact ?? undefined, runId: run.id, eventId, parentActionId: opts.revision?.action.id,
    });
    const tools = toolList(harness);
    const messages: LlmMessage[] = [
      { role: "user", text: await buildContext({ store, policy, now: deps.now }, event, contact, opts.revision) },
    ];
    let consecutiveFailures = 0;
    let actedOutside = false;

    for (;;) {
      if (deps.now().getTime() - startedAt.getTime() > policy.caps.max_wall_ms) return await stopShort("capped", "time limit");

      let turn;
      try {
        turn = await deps.llm.complete({
          model: policy.models.agent, system: deps.prompt.body, messages, tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS_PER_TURN,
        });
      } catch (err) {
        if (!(err instanceof LlmUnavailable)) throw err;
        // Before anything has gone out, fall back cleanly. Mid-run, an extra
        // acknowledgement could contradict what was already sent, so just stop.
        return actedOutside ? await stopShort("escalated", "model became unavailable mid-run") : await degrade("llm_unavailable");
      }

      totals.inputTokens += turn.usage.inputTokens + turn.usage.cacheReadTokens + turn.usage.cacheWriteTokens;
      totals.outputTokens += turn.usage.outputTokens;
      totals.costUsd += costUsd(policy.models.agent, turn.usage);

      const text = turn.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (text) {
        await step({
          type: "thought", output: redact(text).slice(0, THOUGHT_MAX_CHARS),
          inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens,
        });
      }

      if (totals.inputTokens + totals.outputTokens > policy.caps.max_tokens) return await stopShort("capped", "token limit");
      if (turn.stopReason === "refusal") return await stopShort("escalated", "model declined");
      if (turn.stopReason === "max_tokens") return await stopShort("escalated", "model output was cut off");

      const calls = turn.blocks.flatMap((b) => (b.type === "tool_use" ? [b] : []));
      if (calls.length === 0) return await finish("completed", text || "Finished without a summary.");

      const results: LlmToolResult[] = [];
      let done: RunOutcome | undefined;
      for (const c of calls) {
        if (c.name === FINISH_TOOL.name) {
          const parsed = runOutcomeSchema.safeParse(c.input);
          if (parsed.success) done = parsed.data;
          results.push({
            toolUseId: c.id, isError: !parsed.success,
            content: parsed.success ? "ok" : "finish arguments were invalid; call finish again with outcome and summary.",
          });
          continue;
        }

        totals.steps++;
        if (totals.steps > policy.caps.max_steps) return await stopShort("capped", "step limit");

        await step({ type: "tool_call", toolName: c.name, input: redactDeep(c.input) });
        const began = deps.now();
        const result = await harness.registry.call(ctx, c.name, c.input);
        await step({
          type: "tool_result", toolName: c.name, output: redactDeep(result),
          effectiveTier: "tier" in result ? result.tier : undefined,
          tierReasons: result.status === "refused" ? result.reasons : undefined,
          durationMs: deps.now().getTime() - began.getTime(),
        });

        if (result.status === "error") consecutiveFailures++;
        else consecutiveFailures = 0;
        if (result.status === "ok" && harness.registry.get(c.name)?.kind === "action") actedOutside = true;

        results.push({ toolUseId: c.id, content: JSON.stringify(result), isError: result.status === "error" });
        if (consecutiveFailures >= policy.caps.max_consecutive_tool_failures) {
          return await stopShort("escalated", "repeated tool failures");
        }
      }

      if (done) return await finish(done.outcome, done.summary, done.escalation_reason);
      messages.push({ role: "assistant", raw: turn.raw }, { role: "user", toolResults: results });
    }
  } catch (err) {
    await store.audit({
      at: deps.now(), actor: "system", action: "run.error", entity: "run", entityId: run.id,
      details: { error: redact((err as Error).message) }, runId: run.id,
    }).catch(() => undefined);
    return stopShort("failed", "internal error").catch(() => finish("failed", "internal error", "internal error"));
  }
}
