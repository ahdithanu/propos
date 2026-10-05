/**
 * LEARNING MODE: emergency handler. Read docs/learning/emergency-path.md first.
 * Implement src/harness/emergency/handler.ts until this file is green.
 * (Needs detectEmergency from detect.ts; the rule set here is synthetic.)
 */
import { describe, expect, it } from "vitest";
import { withStagingRedirect } from "@/adapters/staging";
import { handleEmergency } from "@/harness/emergency/handler";
import {
  EMERGENCY_TEMPLATE_ID,
  type EmergencyDeps, type EmergencyInput, type EmergencyRuleSet,
} from "@/harness/emergency/types";
import { CONTACTS, NOW, OWNER, UNKNOWN_PHONE, createTestWorld } from "@/harness/testing";
import type { Contact } from "@/harness/types";

const RULES: EmergencyRuleSet = {
  version: 1,
  rules: [{ id: "t_gas", category: "gas", language: "any", pattern: "gas" }],
};
const TENANT = CONTACTS.tenant.phone;

async function setup(over: Partial<EmergencyDeps> = {}) {
  const world = createTestWorld();
  const clock = { now: NOW };
  const sleeps: number[] = [];
  const fallback: { to: string; body: string; idempotencyKey: string }[] = [];
  const deps: EmergencyDeps = {
    sms: world.ports.sms,
    store: world.store,
    rules: RULES,
    templates: world.loaded.templates,
    config: { cooldownMinutes: 30, sendAttempts: 3 },
    now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); },
    enqueueFallback: async (job) => { fallback.push(job); },
    ...over,
  };
  let n = 0;
  /** Inserts a fresh event and builds the handler input for it. */
  const inbound = async (body: string, contact: Contact | null = CONTACTS.tenant, extra: Partial<EmergencyInput> = {}) => {
    const { event } = await world.store.insertEvent({
      type: "sms.inbound", source: "twilio", externalId: `SM${++n}`, contactId: contact?.id,
      payload: { body }, receivedAt: clock.now,
    });
    return { eventId: event.id, contact, fromAddress: contact?.phone ?? UNKNOWN_PHONE, body, isAutoReply: false, ...extra };
  };
  const advance = (minutes: number) => { clock.now = new Date(clock.now.getTime() + minutes * 60_000); };
  const safety = (lang: string) => world.loaded.templates[lang]![EMERGENCY_TEMPLATE_ID]!.body;
  return { ...world, deps, sleeps, fallback, inbound, advance, safety, sms: world.ports.sms };
}

describe("no emergency", () => {
  it("does nothing and says so", async () => {
    const h = await setup();
    const input = await h.inbound("the cabinet hinge is loose");
    expect(await handleEmergency(h.deps, input)).toEqual({ hit: false, tenantReply: "not_applicable", ownerAlert: "not_applicable" });
    expect(h.sms.attempts).toHaveLength(0);
    expect(h.store.events[0]!.emergencyHit).toBe(false);
  });

  it("ignores emergency words in a message from the owner", async () => {
    const h = await setup();
    const outcome = await handleEmergency(h.deps, await h.inbound("did the gas company come by?", CONTACTS.owner));
    expect(outcome.hit).toBe(false);
    expect(h.sms.attempts).toHaveLength(0);
  });
});

describe("a hit from the tenant", () => {
  it("sends the safety template in the tenant's language and alerts the owner", async () => {
    const h = await setup();
    const outcome = await handleEmergency(h.deps, await h.inbound("Huele a gas en la cocina"));
    expect(outcome).toMatchObject({ hit: true, match: { ruleId: "t_gas", category: "gas" }, tenantReply: "sent", ownerAlert: "sent" });
    expect(h.sms.to(TENANT).map((m) => m.body)).toEqual([h.safety("es")]);
    const alert = h.sms.to(OWNER.phone);
    expect(alert).toHaveLength(1);
    expect(alert[0]!.body).toContain("Maria Alvarez");
    expect(alert[0]!.body).toContain("gas");
    expect(alert[0]!.body).toContain("Huele a gas en la cocina");
  });

  it("marks the event and leaves a trail", async () => {
    const h = await setup();
    const input = await h.inbound("gas leak");
    await handleEmergency(h.deps, input);
    expect(h.store.events[0]!.emergencyHit).toBe(true);
    // The outbound safety reply is recorded with its template id; the cooldown depends on it.
    expect(h.store.messages).toContainEqual(
      expect.objectContaining({ direction: "outbound", contactId: "c-tenant", templateId: EMERGENCY_TEMPLATE_ID }),
    );
    expect(h.store.auditLog.some((a) => a.entity === "event" && a.entityId === input.eventId)).toBe(true);
  });

  it("uses no queue when sending works", async () => {
    const h = await setup();
    await handleEmergency(h.deps, await h.inbound("gas leak"));
    expect(h.fallback).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });

  it("falls back to English when there is no template in the contact's language", async () => {
    const h = await setup();
    const contact: Contact = { ...CONTACTS.tenant, preferredLanguage: "vi" };
    await handleEmergency(h.deps, await h.inbound("gas", contact));
    expect(h.sms.to(TENANT)[0]!.body).toBe(h.safety("en"));
  });

  it("replies to a vendor who reports an emergency, too", async () => {
    const h = await setup();
    const outcome = await handleEmergency(h.deps, await h.inbound("I smell gas at the house", CONTACTS.plumber));
    expect(outcome).toMatchObject({ tenantReply: "sent", ownerAlert: "sent" });
    expect(h.sms.to(CONTACTS.plumber.phone)[0]!.body).toBe(h.safety("en"));
  });

  it("keeps the owner alert to a few SMS segments however long the message is", async () => {
    const h = await setup();
    const long = `gas leak ${"and it is very bad ".repeat(200)}`;
    await handleEmergency(h.deps, await h.inbound(long));
    const alert = h.sms.to(OWNER.phone)[0]!.body;
    expect(alert.length).toBeLessThanOrEqual(480);
    expect(alert).toContain("gas leak and it is very bad");
  });

  it("is not subject to the daily message cap", async () => {
    const h = await setup();
    for (let i = 0; i < 20; i++) {
      await h.store.insertMessage({
        threadId: "t", direction: "outbound", channel: "sms", contactId: "c-tenant",
        body: "x", redactedBody: "x", isAutoReply: false, createdAt: NOW,
      });
    }
    expect((await handleEmergency(h.deps, await h.inbound("gas"))).tenantReply).toBe("sent");
  });
});

describe("when not to text the sender", () => {
  it("auto-reply: never answer a machine, still tell the owner", async () => {
    const h = await setup();
    const outcome = await handleEmergency(h.deps, await h.inbound("Auto-reply: at the gas station", CONTACTS.tenant, { isAutoReply: true }));
    expect(outcome).toMatchObject({ hit: true, tenantReply: "skipped_auto_reply", ownerAlert: "sent" });
    expect(h.sms.to(TENANT)).toHaveLength(0);
  });

  it("unknown number: never text it, tell the owner which number it was", async () => {
    const h = await setup();
    const outcome = await handleEmergency(h.deps, await h.inbound("gas leak at your rental", null));
    expect(outcome).toMatchObject({ hit: true, tenantReply: "skipped_unknown_sender", ownerAlert: "sent" });
    expect(h.sms.to(UNKNOWN_PHONE)).toHaveLength(0);
    expect(h.sms.to(OWNER.phone)[0]!.body).toContain(UNKNOWN_PHONE);
  });

  it("paused: the reply to the tenant is held, and the owner is told it was not sent", async () => {
    const h = await setup();
    await h.store.setPaused(true, "owner", NOW);
    const outcome = await handleEmergency(h.deps, await h.inbound("gas leak"));
    expect(outcome).toMatchObject({ hit: true, tenantReply: "held_paused", ownerAlert: "sent" });
    expect(h.sms.to(TENANT)).toHaveLength(0);
    expect(h.sms.to(OWNER.phone)[0]!.body).toMatch(/paused/i);
  });

  it("cooldown: a second emergency text soon after gets no second safety reply, but the owner hears about both", async () => {
    const h = await setup();
    await handleEmergency(h.deps, await h.inbound("gas leak"));
    h.advance(29);
    const second = await handleEmergency(h.deps, await h.inbound("the gas is getting worse"));
    expect(second).toMatchObject({ hit: true, tenantReply: "cooldown", ownerAlert: "sent" });
    expect(h.sms.to(TENANT)).toHaveLength(1);
    expect(h.sms.to(OWNER.phone)).toHaveLength(2);

    h.advance(2);
    const third = await handleEmergency(h.deps, await h.inbound("still smell gas"));
    expect(third.tenantReply).toBe("sent");
    expect(h.sms.to(TENANT)).toHaveLength(2);
  });
});

describe("the same event twice", () => {
  it("sends nothing the second time", async () => {
    const h = await setup();
    const input = await h.inbound("gas leak");
    await handleEmergency(h.deps, input);
    const again = await handleEmergency(h.deps, input);
    expect(again.hit).toBe(true);
    expect(h.sms.to(TENANT)).toHaveLength(1);
    expect(h.sms.to(OWNER.phone)).toHaveLength(1);
  });

  it("sends once when two webhook deliveries race", async () => {
    const h = await setup();
    const input = await h.inbound("gas leak");
    await Promise.all([handleEmergency(h.deps, input), handleEmergency(h.deps, input)]);
    expect(h.sms.to(TENANT)).toHaveLength(1);
    expect(h.sms.to(OWNER.phone)).toHaveLength(1);
  });
});

describe("when Twilio fails", () => {
  it("retries in-process and succeeds without the queue", async () => {
    const h = await setup();
    h.sms.failNext(2, (m) => m.to === TENANT);
    const outcome = await handleEmergency(h.deps, await h.inbound("gas leak"));
    expect(outcome.tenantReply).toBe("sent");
    expect(h.sms.attempts.filter((a) => a.to === TENANT)).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.fallback).toEqual([]);
  });

  it("retries with the same idempotency key, and a different key per recipient", async () => {
    const h = await setup();
    h.sms.failNext(2, (m) => m.to === TENANT);
    await handleEmergency(h.deps, await h.inbound("gas leak"));
    const tenantKeys = new Set(h.sms.attempts.filter((a) => a.to === TENANT).map((a) => a.idempotencyKey));
    const ownerKeys = new Set(h.sms.attempts.filter((a) => a.to === OWNER.phone).map((a) => a.idempotencyKey));
    expect(tenantKeys.size).toBe(1);
    expect(ownerKeys.size).toBe(1);
    expect([...tenantKeys][0]).not.toBe([...ownerKeys][0]);
  });

  it("gives up after the configured attempts and hands the reply to the queue", async () => {
    const h = await setup();
    h.sms.failAlways((m) => m.to === TENANT);
    const outcome = await handleEmergency(h.deps, await h.inbound("Huele a gas"));
    expect(outcome).toMatchObject({ hit: true, tenantReply: "queued_fallback", ownerAlert: "sent" });
    expect(h.sms.attempts.filter((a) => a.to === TENANT)).toHaveLength(3);
    expect(h.fallback).toHaveLength(1);
    expect(h.fallback[0]).toMatchObject({ to: TENANT, body: h.safety("es") });
    expect(h.fallback[0]!.idempotencyKey).toBe(h.sms.attempts.find((a) => a.to === TENANT)!.idempotencyKey);
  });

  it("still replies to the tenant when the owner alert cannot be sent", async () => {
    const h = await setup();
    h.sms.failAlways((m) => m.to === OWNER.phone);
    const outcome = await handleEmergency(h.deps, await h.inbound("gas leak"));
    expect(outcome).toMatchObject({ tenantReply: "sent", ownerAlert: "queued_fallback" });
    expect(h.fallback.map((f) => f.to)).toEqual([OWNER.phone]);
  });

  it("never throws, even when sending, the queue and the audit log all fail", async () => {
    const h = await setup({
      enqueueFallback: async () => { throw new Error("queue down"); },
    });
    h.sms.failAlways();
    h.store.audit = async () => { throw new Error("db down"); };
    const outcome = await handleEmergency(h.deps, await h.inbound("gas leak"));
    expect(outcome.hit).toBe(true);
  });
});

describe("staging mode", () => {
  it("never reaches the tenant's real number", async () => {
    const world = createTestWorld();
    const staged = withStagingRedirect(world.ports, OWNER, async () => "tenant: Maria");
    const h = await setup();
    const deps = { ...h.deps, sms: staged.sms, store: world.store };
    const { event } = await world.store.insertEvent({
      type: "sms.inbound", source: "twilio", externalId: "SM-staging", contactId: "c-tenant", payload: {}, receivedAt: NOW,
    });
    await handleEmergency(deps, { eventId: event.id, contact: CONTACTS.tenant, fromAddress: TENANT, body: "gas leak", isAutoReply: false });
    expect(world.ports.sms.sent).toHaveLength(2);
    expect(world.ports.sms.sent.every((m) => m.to === OWNER.phone)).toBe(true);
    expect(world.ports.sms.sent.some((m) => m.body.startsWith("[STAGING"))).toBe(true);
  });
});
