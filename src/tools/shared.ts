import type { DeliverResult } from "@/harness/deliver";
import type { ActionFacts } from "@/harness/policy/types";
import { containsOtherPartyPii } from "@/harness/redact";
import { DeliveryBlocked, ScopeError, type ToolContext } from "@/harness/registry";
import type { Contact } from "@/harness/types";

export const READ_TIMEOUT_MS = 5_000;
export const WRITE_TIMEOUT_MS = 15_000;

export function requireScope(ctx: ToolContext): Contact {
  if (!ctx.scopeContact) throw new ScopeError("This tool needs a triggering contact and there is none.");
  return ctx.scopeContact;
}

/** The property this run may touch: the triggering tenant's. */
export async function scopeProperty(ctx: ToolContext): Promise<{ propertyId: string; tenantId?: string }> {
  const contact = requireScope(ctx);
  const tenant = await ctx.store.getTenantByContact(contact.id);
  if (tenant) return { propertyId: tenant.propertyId, tenantId: tenant.id };
  throw new ScopeError(`${contact.kind} contacts have no property scope in this version.`);
}

export async function recipientFacts(ctx: ToolContext, contactId: string): Promise<NonNullable<ActionFacts["recipient"]>> {
  const contact = await ctx.store.getContact(contactId);
  if (!contact) return { known: false, isOwner: false, isEventContact: false };
  const owner = await ctx.store.getOwner();
  const vendor = contact.kind === "vendor"
    ? (await ctx.store.listVendors()).find((v) => v.contactId === contact.id)
    : undefined;
  return {
    known: true,
    kind: contact.kind,
    isOwner: contact.id === owner.contactId,
    isEventContact: contact.id === ctx.scopeContact?.id,
    vendorHasPriorJob: vendor ? await ctx.store.vendorHasPriorJob(vendor.id) : undefined,
  };
}

export async function leaksOtherPartyPii(ctx: ToolContext, recipientId: string, text: string): Promise<boolean> {
  return containsOtherPartyPii(text, recipientId, await ctx.store.listContacts());
}

const SENSITIVE = [
  /\b(rent|lease|deposit|evict\w*|late fee|notice to|legal|lawyer|attorney|court|sue|lawsuit|habitab\w*|withhold\w*)\b/i,
  /\b(renta|alquiler|contrato|dep[oó]sito|desalojo|abogad[oa]|demanda|tribunal|aviso de)\b/i,
];

/** Rough keyword check for rent, lease and legal topics. Errs toward flagging. */
export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((p) => p.test(text));
}

export function sentOrThrow(result: DeliverResult): Extract<DeliverResult, { status: "sent" }> {
  if (result.status !== "sent") throw new DeliveryBlocked(result);
  return result;
}

export function label(contact: Contact | null, fallbackId: string): string {
  return contact ? `${contact.kind} ${contact.displayName}` : `unknown contact ${fallbackId}`;
}
