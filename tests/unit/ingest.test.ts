import { describe, expect, it } from "vitest";
import type { EmergencyInput, EmergencyOutcome } from "@/harness/emergency/types";
import { ingestInbound, type InboundMessage } from "@/harness/ingest";
import { CONTACTS, NOW, UNKNOWN_PHONE, createTestWorld } from "@/harness/testing";

const NO_HIT: EmergencyOutcome = { hit: false, tenantReply: "not_applicable", ownerAlert: "not_applicable" };

function setup(emergency: (input: EmergencyInput) => Promise<EmergencyOutcome> = async () => NO_HIT) {
  const world = createTestWorld();
  const calls: string[] = [];
  const emergencyInputs: EmergencyInput[] = [];
  const deps = {
    store: world.store,
    getPolicy: () => world.loaded.policy,
    now: () => NOW,
    handleEmergency: async (input: EmergencyInput) => {
      calls.push("emergency");
      emergencyInputs.push(input);
      return emergency(input);
    },
    enqueue: async (id: string) => { calls.push(`enqueue:${id}`); },
  };
  return { ...world, deps, calls, emergencyInputs };
}

const sms = (externalId: string, body: string, from: string = CONTACTS.tenant.phone): InboundMessage => ({
  source: "twilio", externalId, channel: "sms", from, body,
});

describe("ingestInbound", () => {
  it("stores, runs the emergency check, records the message and enqueues, in that order", async () => {
    const h = setup();
    const result = await ingestInbound(h.deps, sms("SM1", "The kitchen sink is dripping"));
    expect(result.status).toBe("queued");
    expect(h.calls).toEqual(["emergency", `enqueue:${result.event.id}`]);
    expect(h.store.events).toMatchObject([{ externalId: "SM1", contactId: "c-tenant", status: "queued" }]);
    expect(h.store.messages).toMatchObject([{ direction: "inbound", providerId: "SM1", eventId: result.event.id }]);
    expect(h.emergencyInputs[0]).toMatchObject({ contact: { id: "c-tenant" }, isAutoReply: false });
  });

  it("does nothing at all on a provider retry", async () => {
    const h = setup();
    await ingestInbound(h.deps, sms("SM1", "There is a fire"));
    const retry = await ingestInbound(h.deps, sms("SM1", "There is a fire"));
    expect(retry.status).toBe("duplicate");
    expect(h.calls.filter((c) => c === "emergency")).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith("enqueue"))).toHaveLength(1);
    expect(h.store.events).toHaveLength(1);
    expect(h.store.messages).toHaveLength(1);
  });

  it("runs the emergency check on auto-replies but does not hand them to the agent", async () => {
    const h = setup();
    const result = await ingestInbound(h.deps, sms("SM1", "Auto-reply: I'm driving right now"));
    expect(result).toMatchObject({ status: "suppressed", reason: "auto_reply" });
    expect(h.emergencyInputs[0]!.isAutoReply).toBe(true);
    expect(h.calls).toEqual(["emergency"]);
    expect(h.store.events[0]!.status).toBe("suppressed");
    expect(h.store.auditLog.some((a) => a.action === "event.suppressed")).toBe(true);
  });

  it("breaks a ping-pong: the third identical message is suppressed", async () => {
    const h = setup();
    const statuses = [];
    for (const id of ["SM1", "SM2", "SM3"]) {
      statuses.push((await ingestInbound(h.deps, sms(id, "Thanks, we received your message."))).status);
    }
    expect(statuses).toEqual(["queued", "queued", "suppressed"]);
  });

  it("still queues the event when the emergency handler throws", async () => {
    const h = setup(async () => { throw new Error("handler bug, call 408-555-0111"); });
    const result = await ingestInbound(h.deps, sms("SM1", "gas smell"));
    expect(result).toMatchObject({ status: "queued", emergency: null });
    const entry = h.store.auditLog.find((a) => a.action === "emergency.handler_error");
    expect(entry?.details).toEqual({ error: "handler bug, call [PHONE]" });
  });

  it("accepts an unknown sender with no contact and no thread", async () => {
    const h = setup();
    const result = await ingestInbound(h.deps, sms("SM1", "Is the house for rent?", UNKNOWN_PHONE));
    expect(result.status).toBe("queued");
    expect(result.event.contactId).toBeUndefined();
    expect(h.emergencyInputs[0]).toMatchObject({ contact: null, fromAddress: UNKNOWN_PHONE });
    expect(h.store.messages).toHaveLength(0);
  });
});
