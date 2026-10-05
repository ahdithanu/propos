import type { Policy } from "@/config/policy";
import type { Ports } from "./ports";
import { redact } from "./redact";
import type { Store } from "./store";
import type { Channel } from "./types";

export interface DeliverRequest {
  contactId: string;
  /** Defaults to the contact's preferred channel. */
  channel?: Channel;
  subject?: string;
  body: string;
  templateId?: string;
  idempotencyKey: string;
  actionId?: string;
}

export type DeliverResult =
  | { status: "sent"; providerId: string; channel: Channel }
  | { status: "blocked_paused" }
  | { status: "rate_limited"; limit: number }
  | { status: "unknown_contact" }
  | { status: "no_address"; channel: Channel };

export interface DeliverDeps {
  store: Store;
  ports: Ports;
  policy: Policy;
  now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The single place a message to a contact leaves the system. Checks happen
 * here, at send time, so a message approved or held earlier still stops if the
 * kill switch was flipped or the daily cap was reached in between.
 * Messages to the owner bypass the kill switch and the daily cap: they are how
 * the system reports and asks for approval.
 */
export async function deliver(deps: DeliverDeps, req: DeliverRequest): Promise<DeliverResult> {
  const { store, ports, policy } = deps;
  const contact = await store.getContact(req.contactId);
  if (!contact) return { status: "unknown_contact" };

  const owner = await store.getOwner();
  const toOwner = contact.id === owner.contactId;
  const channel = req.channel ?? contact.preferredChannel;
  const address = channel === "sms" ? contact.phone : contact.email;
  if (!address) return { status: "no_address", channel };

  const now = deps.now();
  if (!toOwner) {
    if ((await store.getSystemState()).paused) return { status: "blocked_paused" };
    const limit =
      channel === "sms"
        ? policy.rate_limits.sms_per_recipient_per_day
        : policy.rate_limits.email_per_recipient_per_day;
    const sentToday = await store.countOutbound(contact.id, channel, new Date(now.getTime() - DAY_MS));
    if (sentToday >= limit) return { status: "rate_limited", limit };
  }

  const { providerId } =
    channel === "sms"
      ? await ports.sms.send({ to: address, body: req.body, idempotencyKey: req.idempotencyKey })
      : await ports.email.send({
          to: address,
          subject: req.subject ?? "Message from your property manager",
          body: req.body,
          idempotencyKey: req.idempotencyKey,
        });

  await store.insertMessage({
    threadId: await store.getOrCreateThread(channel, contact.id),
    direction: "outbound",
    channel,
    contactId: contact.id,
    body: req.body,
    redactedBody: redact(req.body),
    providerId,
    templateId: req.templateId,
    isAutoReply: false,
    createdAt: now,
  });
  await store.audit({
    at: now,
    actor: "system",
    action: "message.sent",
    entity: "contact",
    entityId: contact.id,
    details: { channel, templateId: req.templateId ?? null, actionId: req.actionId ?? null, body: redact(req.body) },
  });
  return { status: "sent", providerId, channel };
}

/** Fills `{{var}}` placeholders. Throws on a missing variable rather than sending a broken message. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Template variable missing: ${name}`);
    return value;
  });
}
