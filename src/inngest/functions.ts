import type { Pipeline, Queue } from "@/harness/pipeline";
import { EVENTS, inngest } from "./client";

/** The pipeline's queue, backed by Inngest events. Event ids make sends idempotent. */
export const inngestQueue: Queue = {
  async eventReceived(job) {
    await inngest.send({ id: `received:${job.eventId}`, name: EVENTS.received, data: job });
  },
  async reviseAction(job) {
    await inngest.send({ id: `revise:${job.actionId}`, name: EVENTS.revise, data: job });
  },
  async emergencyFallback(job) {
    await inngest.send({ id: `fallback:${job.idempotencyKey}`, name: EVENTS.emergencyFallback, data: job });
  },
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Inngest functions. Each is a thin shell: retries, concurrency and failure
 * handling live here, behaviour lives in the pipeline.
 */
export function createFunctions(getPipeline: () => Promise<Pipeline>) {
  const processEvent = inngest.createFunction(
    {
      id: "process-event",
      triggers: [{ event: EVENTS.received }],
      // One run at a time per sender, so two messages cannot produce racing replies.
      concurrency: { key: "event.data.threadKey", limit: 1 },
      // The agent run records its own failures. A retry here is for infrastructure
      // errors only, and process() refuses an event that is no longer `queued`.
      retries: 2,
      onFailure: async ({ event, error }) => {
        const original = event.data.event.data as { eventId?: string };
        await (await getPipeline()).deadLetter({
          jobName: "process-event", eventId: original.eventId, error: errorText(error), attempts: 3,
        });
      },
    },
    async ({ event, step }) => {
      const data = event.data as { eventId: string };
      return step.run("process", async () => {
        const result = await (await getPipeline()).process(data.eventId);
        return result.kind === "agent_run"
          ? { kind: result.kind, runId: result.run.id, outcome: result.run.outcome }
          : result.kind === "owner_command"
            ? { kind: result.kind, outcome: result.result.outcome }
            : result;
      });
    },
  );

  const reviseAction = inngest.createFunction(
    {
      id: "revise-action",
      triggers: [{ event: EVENTS.revise }],
      retries: 2,
      onFailure: async ({ event, error }) => {
        const original = event.data.event.data as { sourceEventId?: string };
        await (await getPipeline()).deadLetter({
          jobName: "revise-action", eventId: original.sourceEventId, error: errorText(error), attempts: 3,
        });
      },
    },
    async ({ event, step }) => {
      const data = event.data as { actionId: string; instruction: string; sourceEventId: string };
      return step.run("revise", async () => {
        const result = await (await getPipeline()).revise(data);
        return result.kind === "agent_run" ? { kind: result.kind, runId: result.run.id } : result;
      });
    },
  );

  const emergencyFallback = inngest.createFunction(
    {
      id: "emergency-fallback",
      triggers: [{ event: EVENTS.emergencyFallback }],
      // A safety message that already failed in-process: keep trying for a while.
      retries: 8,
      onFailure: async ({ error }) => {
        await (await getPipeline()).deadLetter({ jobName: "emergency-fallback", error: errorText(error), attempts: 9 });
      },
    },
    async ({ event, step }) => {
      const data = event.data as { to: string; body: string; idempotencyKey: string };
      await step.run("send", async () => (await getPipeline()).sendEmergencyFallback(data));
    },
  );

  const tick = inngest.createFunction(
    { id: "tick", triggers: [{ cron: "* * * * *" }], retries: 0 },
    async ({ step }) => step.run("tick", async () => (await getPipeline()).tick()),
  );

  return [processEvent, reviseAction, emergencyFallback, tick];
}
