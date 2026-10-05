import { z } from "zod";
import { renderTemplate } from "@/harness/deliver";
import { ScopeError, defineTool, type ToolContext } from "@/harness/registry";
import {
  WRITE_TIMEOUT_MS, label, leaksOtherPartyPii, looksSensitive, recipientFacts, requireScope,
  scopeProperty, sentOrThrow,
} from "./shared";

// Outbound tools reference people by contact_id only. The harness resolves the
// real address at send time; the model never sees or supplies one.

const ACK_TEMPLATE = "ack_received";

function templateFor(ctx: ToolContext, language: string, templateId: string) {
  const template = (ctx.templates[language] ?? ctx.templates.en)?.[templateId];
  if (!template) throw new Error(`Unknown template: ${templateId}`);
  return template;
}

export const sendAck = defineTool({
  name: "send_ack",
  description: "Send the standard 'we got your message' acknowledgement to the person who just wrote in.",
  kind: "action",
  baseTier: 0,
  input: z.strictObject({}),
  output: z.object({ sent: z.literal(true), channel: z.enum(["sms", "email"]) }),
  timeoutMs: WRITE_TIMEOUT_MS,
  maxCallsPerRun: 1,
  async facts(_args, ctx) {
    return { recipient: await recipientFacts(ctx, requireScope(ctx).id), templateId: ACK_TEMPLATE };
  },
  async summarize(_args, ctx) {
    return `acknowledgement to ${label(requireScope(ctx), "")}`;
  },
  async execute(_args, ctx, meta) {
    const contact = requireScope(ctx);
    const template = templateFor(ctx, contact.preferredLanguage, ACK_TEMPLATE);
    const body = renderTemplate(template.body, { first_name: contact.firstName ?? contact.displayName });
    const result = sentOrThrow(
      await ctx.deliver({ contactId: contact.id, body, templateId: ACK_TEMPLATE, idempotencyKey: meta.idempotencyKey }),
    );
    return { sent: true as const, channel: result.channel };
  },
});

export const sendTemplateMessage = defineTool({
  name: "send_template_message",
  description: "Send an approved message template to a contact, in that contact's language.",
  kind: "action",
  // A templated message to someone other than the sender is never instant.
  baseTier: 1,
  input: z.strictObject({
    contact_id: z.string().min(1),
    template_id: z.string().min(1),
    vars: z.record(z.string(), z.string().max(300)).default({}),
  }),
  output: z.object({ sent: z.literal(true), channel: z.enum(["sms", "email"]) }),
  timeoutMs: WRITE_TIMEOUT_MS,
  async facts(args, ctx) {
    const contact = await ctx.store.getContact(args.contact_id);
    // Template variables are free text from the model, so they get the same checks as free text.
    const filled = Object.values(args.vars).join(" ");
    return {
      recipient: await recipientFacts(ctx, args.contact_id),
      // An unknown template id is treated as free text rather than trusted.
      templateId: ctx.templates.en?.[args.template_id] ? args.template_id : null,
      sensitive: looksSensitive(filled),
      containsOtherPartyPii: contact ? await leaksOtherPartyPii(ctx, contact.id, filled) : false,
    };
  },
  async summarize(args, ctx) {
    const contact = await ctx.store.getContact(args.contact_id);
    if (!contact) return `template "${args.template_id}" to ${label(null, args.contact_id)}`;
    const template = (ctx.templates[contact.preferredLanguage] ?? ctx.templates.en)?.[args.template_id];
    let text = `template "${args.template_id}"`;
    try {
      if (template) text = `"${renderTemplate(template.body, args.vars)}"`;
    } catch { /* missing variable: execution will fail and say so */ }
    return `${text} to ${label(contact, args.contact_id)}`;
  },
  async execute(args, ctx, meta) {
    const contact = await ctx.store.getContact(args.contact_id);
    if (!contact) throw new Error("Unknown contact.");
    const template = templateFor(ctx, contact.preferredLanguage, args.template_id);
    const body = renderTemplate(template.body, args.vars);
    const result = sentOrThrow(
      await ctx.deliver({ contactId: contact.id, body, templateId: args.template_id, idempotencyKey: meta.idempotencyKey }),
    );
    return { sent: true as const, channel: result.channel };
  },
});

export const sendFreeTextMessage = defineTool({
  name: "send_free_text_message",
  description: "Send a message you wrote yourself to a contact. Always needs owner approval.",
  kind: "action",
  baseTier: 2,
  input: z.strictObject({ contact_id: z.string().min(1), body: z.string().min(1).max(1200) }),
  output: z.object({ sent: z.literal(true), channel: z.enum(["sms", "email"]) }),
  timeoutMs: WRITE_TIMEOUT_MS,
  async facts(args, ctx) {
    const contact = await ctx.store.getContact(args.contact_id);
    return {
      recipient: await recipientFacts(ctx, args.contact_id),
      templateId: null,
      sensitive: looksSensitive(args.body),
      containsOtherPartyPii: contact ? await leaksOtherPartyPii(ctx, contact.id, args.body) : false,
    };
  },
  async summarize(args, ctx) {
    return `"${args.body}" to ${label(await ctx.store.getContact(args.contact_id), args.contact_id)}`;
  },
  async execute(args, ctx, meta) {
    const result = sentOrThrow(
      await ctx.deliver({ contactId: args.contact_id, body: args.body, idempotencyKey: meta.idempotencyKey }),
    );
    return { sent: true as const, channel: result.channel };
  },
});

export const alertOwner = defineTool({
  name: "alert_owner",
  description: "Send the owner a short note. Use to escalate or report; it does not ask for approval of anything.",
  kind: "action",
  baseTier: 0,
  ownerDirected: true,
  input: z.strictObject({ text: z.string().min(1).max(600) }),
  output: z.object({ sent: z.literal(true) }),
  timeoutMs: WRITE_TIMEOUT_MS,
  maxCallsPerRun: 3,
  async facts(_args, ctx) {
    return { recipient: await recipientFacts(ctx, (await ctx.store.getOwner()).contactId), templateId: undefined };
  },
  async summarize(args) {
    return `note to owner: "${args.text}"`;
  },
  async execute(args, ctx, meta) {
    const owner = await ctx.store.getOwner();
    sentOrThrow(
      await ctx.deliver({ contactId: owner.contactId, channel: "sms", body: args.text, idempotencyKey: meta.idempotencyKey }),
    );
    return { sent: true as const };
  },
});

export const scheduleVendorVisit = defineTool({
  name: "schedule_vendor_visit",
  description: "Book a vendor visit for a maintenance request on the calendar. Commits the quoted amount if one is given.",
  kind: "action",
  baseTier: 2,
  input: z.strictObject({
    request_id: z.string().min(1),
    vendor_id: z.string().min(1),
    starts_at: z.iso.datetime(),
    duration_minutes: z.number().int().min(15).max(480).default(60),
    quote_cents: z.number().int().nonnegative().optional(),
  }),
  output: z.object({ calendar_event_id: z.string(), request_status: z.string() }),
  timeoutMs: WRITE_TIMEOUT_MS,
  async facts(args, ctx) {
    const vendor = await ctx.store.getVendor(args.vendor_id);
    return {
      recipient: vendor
        ? await recipientFacts(ctx, vendor.contactId)
        : { known: false, isOwner: false, isEventContact: false },
      amountCents: args.quote_cents,
    };
  },
  async summarize(args, ctx) {
    const vendor = await ctx.store.getVendor(args.vendor_id);
    const contact = vendor ? await ctx.store.getContact(vendor.contactId) : null;
    const request = await ctx.store.getRequest(args.request_id);
    const cost = args.quote_cents === undefined ? "no quote" : `$${(args.quote_cents / 100).toFixed(2)}`;
    return `book ${contact?.displayName ?? "unknown vendor"} for "${request?.title ?? args.request_id}" at ${args.starts_at} (${cost})`;
  },
  async execute(args, ctx, meta) {
    const { propertyId } = await scopeProperty(ctx);
    const request = await ctx.store.getRequest(args.request_id);
    if (!request || request.propertyId !== propertyId) {
      throw new ScopeError("That request does not belong to this property.");
    }
    const vendor = await ctx.store.getVendor(args.vendor_id);
    if (!vendor) throw new Error("Unknown vendor.");
    const startsAt = new Date(args.starts_at);
    if (startsAt <= ctx.now()) throw new Error("Visit time is in the past.");
    const endsAt = new Date(startsAt.getTime() + args.duration_minutes * 60_000);
    const { eventId } = await ctx.ports.calendar.createEvent({
      title: `Vendor visit: ${request.title}`, startsAt, endsAt, idempotencyKey: meta.idempotencyKey,
    });
    const row = await ctx.store.insertCalendarEvent({
      providerEventId: eventId, kind: "vendor_visit", requestId: request.id, startsAt, endsAt,
    });
    const updated = await ctx.store.updateRequest(
      request.id,
      { status: "scheduled", vendorId: vendor.id, scheduledStart: startsAt, quoteCents: args.quote_cents ?? request.quoteCents },
      "agent",
      ctx.now(),
    );
    return { calendar_event_id: row.id, request_status: updated.status };
  },
});
