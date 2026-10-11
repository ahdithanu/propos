import type { Policy, Templates } from "@/config/policy";
import { deliver, renderTemplate } from "./deliver";
import type { Ports } from "./ports";
import type { Store } from "./store";
import type { Contact, HarnessEvent } from "./types";

export type DegradedReason = "spend_cap" | "llm_unavailable";

export interface DegradedDeps {
  store: Store;
  ports: Ports;
  policy: Policy;
  templates: Templates;
  now: () => Date;
}

const ACK = "ack_received";

/**
 * What happens to an event when no model run is possible. The sender gets the
 * standard acknowledgement and the owner is told to handle it by hand. Nothing
 * here is decided by a model, and deliver() still applies the kill switch and
 * the daily cap. The emergency rules have already run by this point.
 */
export async function handleDegraded(
  deps: DegradedDeps,
  event: HarnessEvent,
  contact: Contact | null,
  reason: DegradedReason,
): Promise<{ ack: string; ownerAlert: string }> {
  const { store } = deps;
  const owner = await store.getOwner();
  const d = { store, ports: deps.ports, policy: deps.policy, now: deps.now };

  let ack = "skipped";
  if (contact && contact.id !== owner.contactId) {
    const template = (deps.templates[contact.preferredLanguage] ?? deps.templates.en)?.[ACK];
    if (template) {
      const body = renderTemplate(template.body, { first_name: contact.firstName ?? contact.displayName });
      ack = (await deliver(d, { contactId: contact.id, body, templateId: ACK, idempotencyKey: `degraded-ack:${event.id}` })).status;
    }
  }

  const why = reason === "spend_cap" ? "the daily model budget is used up" : "the model is unavailable";
  const who = contact ? `${contact.kind} ${contact.displayName}` : "an unknown sender";
  const alert = await deliver(d, {
    contactId: owner.contactId,
    channel: "sms",
    body: `Not handled automatically (${why}). A message from ${who} needs you. ` +
      (ack === "sent" ? "They got the standard acknowledgement." : "They were not answered."),
    idempotencyKey: `degraded-alert:${event.id}`,
  });

  await store.audit({
    at: deps.now(), actor: "system", action: "event.degraded", entity: "event", entityId: event.id,
    details: { reason, ack, ownerAlert: alert.status },
  });
  return { ack, ownerAlert: alert.status };
}
