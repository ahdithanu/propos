import type { LoadedPolicy } from "@/config/policy";
import type { LoadedPrompt } from "@/config/prompts";
import { runAgent } from "./agent";
import type { ApprovalDeps, OwnerSmsInput, OwnerSmsResult } from "./approvals/types";
import { deliver } from "./deliver";
import type { EmergencyDeps, EmergencyInput, EmergencyOutcome, EmergencyRuleSet } from "./emergency/types";
import type { Harness } from "./index";
import { ingestInbound, type InboundMessage, type IngestResult } from "./ingest";
import type { LlmPort } from "./llm";
import type { Ports } from "./ports";
import { redact } from "./redact";
import type { Store } from "./store";
import type { AgentRun } from "./types";

/** Jobs the pipeline hands to the queue. Inngest in production, an in-process queue in tests. */
export interface Queue {
  eventReceived(job: { eventId: string; threadKey: string }): Promise<void>;
  reviseAction(job: { actionId: string; instruction: string; sourceEventId: string }): Promise<void>;
  emergencyFallback(job: { to: string; body: string; idempotencyKey: string }): Promise<void>;
}

export interface PipelineDeps {
  store: Store;
  /** From portsForMode(), so staging cannot be bypassed. */
  ports: Ports;
  llm: LlmPort;
  harness: Harness;
  loaded: LoadedPolicy;
  prompt: LoadedPrompt;
  queue: Queue;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The owner's learning-mode implementations, injected so the pipeline does not care how they work. */
  emergency: {
    rules: EmergencyRuleSet;
    handle: (deps: EmergencyDeps, input: EmergencyInput) => Promise<EmergencyOutcome>;
  };
  handleOwnerSms: (deps: ApprovalDeps, input: OwnerSmsInput) => Promise<OwnerSmsResult>;
}

export type ProcessResult =
  | { kind: "owner_command"; result: Extract<OwnerSmsResult, { handled: true }> }
  | { kind: "agent_run"; run: AgentRun }
  | { kind: "skipped"; reason: string };

/** Events older than this that are still `received` were inserted but never queued. */
const STUCK_AFTER_MS = 2 * 60_000;

/**
 * The whole flow in one place, free of any web or queue framework:
 *   receive   webhook -> insert -> emergency rules -> loop check -> queue
 *   process   queue -> owner command (deterministic) or agent run
 *   revise    queue -> agent redraft of an action the owner edited
 *   tick      release held actions, expire approvals, re-queue stuck events
 */
export function createPipeline(deps: PipelineDeps) {
  const { store, ports, harness, queue } = deps;
  const policy = () => harness.getPolicy();
  const agentDeps = () => ({
    store, ports, llm: deps.llm, harness, loaded: deps.loaded, prompt: deps.prompt, now: deps.now,
  });

  const notifyOwner = async (text: string, key: string) => {
    const owner = await store.getOwner();
    await deliver(
      { store, ports, policy: policy(), now: deps.now },
      { contactId: owner.contactId, channel: "sms", body: text, idempotencyKey: key },
    );
  };

  async function receive(msg: InboundMessage): Promise<IngestResult> {
    return ingestInbound(
      {
        store,
        getPolicy: policy,
        now: deps.now,
        handleEmergency: (input) =>
          deps.emergency.handle(
            {
              sms: ports.sms, store, rules: deps.emergency.rules, templates: deps.loaded.templates,
              config: { cooldownMinutes: policy().emergency.cooldown_minutes, sendAttempts: policy().emergency.send_attempts },
              now: deps.now,
              sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
              enqueueFallback: (job) => queue.emergencyFallback(job),
            },
            input,
          ),
        enqueue: async (eventId) => {
          const event = await store.getEvent(eventId);
          // One run at a time per sender, so replies cannot race each other.
          await queue.eventReceived({ eventId, threadKey: event?.contactId ?? `unknown:${msg.from}` });
        },
      },
      msg,
    );
  }

  async function process(eventId: string): Promise<ProcessResult> {
    const event = await store.getEvent(eventId);
    if (!event) return { kind: "skipped", reason: "event not found" };
    // Only `queued` events are picked up, so a job delivered twice does not start a second run.
    if (event.status !== "queued") return { kind: "skipped", reason: `event is ${event.status}` };

    const owner = await store.getOwner();
    if (event.type === "sms.inbound" && event.contactId === owner.contactId) {
      let n = 0;
      const result = await deps.handleOwnerSms(
        {
          store,
          execute: (actionId) => harness.outbox.execute(actionId),
          notifyOwner: (text) => notifyOwner(text, `owner-reply:${eventId}:${n++}`),
          enqueueRevision: (job) => queue.reviseAction(job),
          now: deps.now,
        },
        {
          eventId,
          from: String(event.payload.from ?? ""),
          body: String(event.payload.body ?? ""),
          signatureValid: event.payload.signatureValid === true,
        },
      );
      if (result.handled) {
        await store.setEventStatus(eventId, "done");
        return { kind: "owner_command", result };
      }
      // Not a command: an ordinary message from the owner, which the agent may read as an instruction.
    }
    return { kind: "agent_run", run: await runAgent(agentDeps(), eventId) };
  }

  async function revise(job: { actionId: string; instruction: string; sourceEventId: string }): Promise<ProcessResult> {
    const action = await store.getAction(job.actionId);
    if (!action) return { kind: "skipped", reason: "action not found" };
    if (action.status !== "revising") return { kind: "skipped", reason: `action is ${action.status}` };
    const run = await runAgent(agentDeps(), job.sourceEventId, { revision: { action, instruction: job.instruction } });
    return { kind: "agent_run", run };
  }

  async function tick(): Promise<{ released: number; expired: number; requeued: number }> {
    const released = (await harness.outbox.releaseDue()).length;
    const expired = await harness.outbox.expireStale();
    for (const actionId of expired) {
      const action = await store.getAction(actionId);
      await notifyOwner(`Expired without an answer, nothing was sent: ${action?.summary ?? actionId}.`, `expired:${actionId}`);
    }
    // An event inserted but never queued (a crash between the two) would
    // otherwise be lost. process() ignores anything not `queued`, so mark first.
    const stuck = await store.listEventsByStatus("received", new Date(deps.now().getTime() - STUCK_AFTER_MS));
    for (const event of stuck) {
      await store.setEventStatus(event.id, "queued");
      await queue.eventReceived({ eventId: event.id, threadKey: event.contactId ?? `unknown:${String(event.payload.from ?? "")}` });
    }
    return { released, expired: expired.length, requeued: stuck.length };
  }

  /** Called when the queue gives up on a job for good. */
  async function deadLetter(job: { jobName: string; eventId?: string; error: string; attempts: number }) {
    await store.insertDeadLetter({ ...job, error: redact(job.error) });
    if (job.eventId) await store.setEventStatus(job.eventId, "failed").catch(() => undefined);
    await notifyOwner(`A background job failed for good (${job.jobName}). Check the dashboard.`, `dead:${job.jobName}:${job.eventId ?? "none"}`)
      .catch(() => undefined);
  }

  /** Last-resort send for an emergency message whose in-process retries all failed. */
  async function sendEmergencyFallback(job: { to: string; body: string; idempotencyKey: string }) {
    await ports.sms.send(job);
  }

  return { receive, process, revise, tick, deadLetter, sendEmergencyFallback };
}

export type Pipeline = ReturnType<typeof createPipeline>;
