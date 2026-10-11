import type { Policy } from "@/config/policy";
import { redact } from "./redact";
import type { Store } from "./store";
import type { Action, Contact, HarnessEvent } from "./types";

/**
 * Wraps text from outside the system so the model can tell data from
 * instructions. Any attempt to close or open the wrapper from inside is defused.
 * The real defence is in code (policy, scoping, recipients); this is hygiene.
 */
export function wrapUntrusted(source: string, id: string, text: string): string {
  const safe = text
    .replace(/<(\s*\/?\s*)untrusted_data/gi, "&lt;$1untrusted_data")
    // Every line is quoted, so outside text can never begin a line with one of
    // our own section headings (for example a forged "## Owner instruction").
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const attr = (v: string) => v.replace(/[^\w.:-]/g, "_");
  return `<untrusted_data source="${attr(source)}" id="${attr(id)}">\n${safe}\n</untrusted_data>`;
}

export interface RevisionContext {
  action: Action;
  /** The owner's own words. Trusted. */
  instruction: string;
}

/**
 * Builds the per-event context message. PII-minimized: first names and
 * contact ids only, and message bodies with phones, emails and addresses redacted.
 */
export async function buildContext(
  deps: { store: Store; policy: Policy; now: () => Date },
  event: HarnessEvent,
  contact: Contact | null,
  revision?: RevisionContext,
): Promise<string> {
  const { store, policy } = deps;
  const parts: string[] = [];
  const body = typeof event.payload.body === "string" ? event.payload.body : "";
  const owner = await store.getOwner();

  parts.push(
    [
      "## Event",
      `Type: ${event.type}`,
      `Received: ${event.receivedAt.toISOString()} (now ${deps.now().toISOString()})`,
      contact
        ? `Sender: ${contact.kind} "${contact.firstName ?? contact.displayName}", contact_id ${contact.id}, ` +
          `prefers ${contact.preferredChannel} in language "${contact.preferredLanguage}"`
        : "Sender: unknown. This sender is not in contacts and cannot be messaged.",
      event.emergencyHit
        ? "Emergency rules already matched this message. The safety reply and the owner alert were handled before you ran; do not repeat them."
        : "",
    ].filter(Boolean).join("\n"),
  );

  if (revision) {
    parts.push(
      [
        "## Owner instruction",
        "The owner reviewed an action you proposed and asked for a change. Redraft it accordingly.",
        `Proposed action: ${revision.action.toolName} (${revision.action.summary})`,
        `Proposed arguments: ${JSON.stringify(revision.action.args)}`,
        `The owner wrote: "${revision.instruction}"`,
      ].join("\n"),
    );
  } else if (contact?.id === owner.contactId) {
    parts.push(`## Owner instruction\nThe owner wrote: "${body}"`);
  } else {
    parts.push(`## Message\n${wrapUntrusted(event.type, event.id, redact(body))}`);
  }

  const tenant = contact ? await store.getTenantByContact(contact.id) : null;
  if (tenant) {
    const lease = await store.getActiveLease(tenant.propertyId);
    if (lease) {
      parts.push(`## Lease\nActive from ${lease.startDate} to ${lease.endDate}. Rent is due on day ${lease.dueDay}.`);
    }
    const open = await store.listRequests(tenant.propertyId, { openOnly: true });
    parts.push(
      "## Open maintenance requests\n" +
        (open.length
          ? open.map((r) => `- ${r.id}: ${wrapUntrusted("request_title", r.id, r.title)} [${r.category}, ${r.urgency}, ${r.status}]`).join("\n")
          : "None."),
    );
    // Only facts the owner has approved. Proposed facts never reach the model.
    const facts = [
      ...(await store.listMemoryFacts("tenant", tenant.id, "active")),
      ...(await store.listMemoryFacts("property", tenant.propertyId, "active")),
    ];
    if (facts.length) {
      parts.push("## Notes the owner has approved\n" + facts.map((f) => `- (${f.category}) ${f.fact}`).join("\n"));
    }
  }

  if (contact) {
    const threadId = await store.getOrCreateThread(contact.preferredChannel, contact.id);
    const history = (await store.listThreadMessages(threadId))
      .filter((m) => m.eventId !== event.id)
      .slice(-policy.context.thread_messages);
    if (history.length) {
      parts.push(
        "## Earlier messages on this thread (oldest first)\n" +
          history
            .map((m) =>
              m.direction === "outbound"
                ? `We sent (${m.createdAt.toISOString()}): ${m.redactedBody}`
                : `They sent (${m.createdAt.toISOString()}):\n${wrapUntrusted(m.channel, m.id, m.redactedBody)}`,
            )
            .join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}
