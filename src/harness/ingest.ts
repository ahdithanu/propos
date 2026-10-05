import type { Policy } from "@/config/policy";
import type { EmergencyInput, EmergencyOutcome } from "./emergency/types";
import { checkLoop, isAutoReply, type LoopVerdict } from "./loops";
import { redact } from "./redact";
import type { Store } from "./store";
import type { Channel, EventSource, HarnessEvent } from "./types";

export interface InboundMessage {
  source: Extract<EventSource, "twilio" | "gmail">;
  /** Provider message id (Twilio MessageSid, Gmail messageId). The idempotency key. */
  externalId: string;
  channel: Channel;
  from: string;
  body: string;
  headers?: Record<string, string>;
}

export interface IngestDeps {
  store: Store;
  getPolicy: () => Policy;
  now: () => Date;
  /** Bound emergency handler. Injected: it is the owner's learning-mode code. */
  handleEmergency: (input: EmergencyInput) => Promise<EmergencyOutcome>;
  /** Hands the event to the queue (Inngest in Phase 1b). */
  enqueue: (eventId: string) => Promise<void>;
}

export type IngestResult =
  | { status: "duplicate"; event: HarnessEvent }
  | { status: "suppressed"; event: HarnessEvent; reason: Extract<LoopVerdict, { suppress: true }>["reason"]; emergency: EmergencyOutcome | null }
  | { status: "queued"; event: HarnessEvent; emergency: EmergencyOutcome | null };

/**
 * The webhook pipeline for one inbound message, in the order that matters:
 *   1. insert the event (a provider retry stops here),
 *   2. emergency rules, before any model and before the queue,
 *   3. loop and auto-reply detection,
 *   4. record the message and enqueue.
 * Signature verification happens in the route handler before this is called.
 */
export async function ingestInbound(deps: IngestDeps, msg: InboundMessage): Promise<IngestResult> {
  const { store } = deps;
  const now = deps.now();
  const contact =
    msg.channel === "sms" ? await store.findContactByPhone(msg.from) : await store.findContactByEmail(msg.from);

  const { event, inserted } = await store.insertEvent({
    type: `${msg.channel}.inbound`,
    source: msg.source,
    externalId: msg.externalId,
    contactId: contact?.id,
    payload: { from: msg.from, body: msg.body, headers: msg.headers ?? {} },
    receivedAt: now,
  });
  if (!inserted) return { status: "duplicate", event };

  const autoReply = isAutoReply({ headers: msg.headers, from: msg.from, body: msg.body });

  // The handler promises not to throw, but the webhook must survive if it does:
  // losing the event would be worse than losing the fast path.
  let emergency: EmergencyOutcome | null = null;
  try {
    emergency = await deps.handleEmergency({
      eventId: event.id, contact, fromAddress: msg.from, body: msg.body, isAutoReply: autoReply,
    });
  } catch (err) {
    await store.audit({
      at: now, actor: "system", action: "emergency.handler_error", entity: "event", entityId: event.id,
      details: { error: redact((err as Error).message) },
    });
  }

  // Unknown senders have no thread; they go to the agent, which can only alert the owner.
  let verdict: LoopVerdict = autoReply ? { suppress: true, reason: "auto_reply" } : { suppress: false };
  if (contact) {
    const threadId = await store.getOrCreateThread(msg.channel, contact.id);
    const history = await store.listThreadMessages(threadId);
    verdict = checkLoop(
      { body: msg.body, isAutoReply: autoReply }, history, deps.getPolicy().rate_limits.thread_velocity, now,
    );
    await store.insertMessage({
      threadId, eventId: event.id, direction: "inbound", channel: msg.channel, contactId: contact.id,
      body: msg.body, redactedBody: redact(msg.body), providerId: msg.externalId, isAutoReply: autoReply,
      createdAt: now,
    });
  }

  if (verdict.suppress) {
    await store.setEventStatus(event.id, "suppressed");
    await store.audit({
      at: now, actor: "system", action: "event.suppressed", entity: "event", entityId: event.id,
      details: { reason: verdict.reason },
    });
    return { status: "suppressed", event, reason: verdict.reason, emergency };
  }

  await deps.enqueue(event.id);
  await store.setEventStatus(event.id, "queued");
  return { status: "queued", event, emergency };
}
