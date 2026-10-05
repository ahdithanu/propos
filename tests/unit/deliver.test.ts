import { describe, expect, it } from "vitest";
import { parseMode, portsForMode } from "@/adapters/staging";
import { deliver, renderTemplate } from "@/harness/deliver";
import { CONTACTS, NOW, OWNER, createTestWorld } from "@/harness/testing";

function setup() {
  const world = createTestWorld();
  const deps = { store: world.store, ports: world.ports, policy: world.loaded.policy, now: () => NOW };
  return { ...world, deps };
}

describe("deliver", () => {
  it("resolves the address from the contact and records a redacted outbound message", async () => {
    const { deps, ports, store } = setup();
    const result = await deliver(deps, { contactId: "c-tenant", body: "Plumber is 408-555-0121", idempotencyKey: "k1" });
    expect(result).toMatchObject({ status: "sent", channel: "sms" });
    expect(ports.sms.sent).toMatchObject([{ to: CONTACTS.tenant.phone, body: "Plumber is 408-555-0121" }]);
    expect(store.messages).toMatchObject([{ direction: "outbound", contactId: "c-tenant", redactedBody: "Plumber is [PHONE]" }]);
    expect(JSON.stringify(store.auditLog)).not.toContain("555-0121");
  });

  it("uses the contact's preferred channel unless told otherwise", async () => {
    const { deps, ports } = setup();
    await deliver(deps, { contactId: "c-hvac", body: "hello", idempotencyKey: "k1" });
    await deliver(deps, { contactId: "c-hvac", channel: "sms", body: "hello", idempotencyKey: "k2" });
    expect(ports.email.sent).toHaveLength(1);
    expect(ports.sms.sent).toHaveLength(1);
  });

  it("blocks everyone except the owner while paused", async () => {
    const { deps, ports, store } = setup();
    await store.setPaused(true, "owner", NOW);
    expect(await deliver(deps, { contactId: "c-tenant", body: "x", idempotencyKey: "k1" })).toEqual({ status: "blocked_paused" });
    expect(await deliver(deps, { contactId: "c-owner", body: "x", idempotencyKey: "k2" })).toMatchObject({ status: "sent" });
    expect(ports.sms.sent.map((s) => s.to)).toEqual([OWNER.phone]);
  });

  it("enforces the per-recipient daily cap over a rolling 24 hours, but never on the owner", async () => {
    const { deps, ports } = setup();
    const cap = deps.policy.rate_limits.sms_per_recipient_per_day;
    for (let i = 0; i < cap; i++) {
      expect((await deliver(deps, { contactId: "c-tenant", body: `m${i}`, idempotencyKey: `k${i}` })).status).toBe("sent");
    }
    expect(await deliver(deps, { contactId: "c-tenant", body: "one more", idempotencyKey: "over" }))
      .toEqual({ status: "rate_limited", limit: cap });
    expect(ports.sms.to(CONTACTS.tenant.phone)).toHaveLength(cap);

    const tomorrow = { ...deps, now: () => new Date(NOW.getTime() + 25 * 3600_000) };
    expect((await deliver(tomorrow, { contactId: "c-tenant", body: "next day", idempotencyKey: "next" })).status).toBe("sent");

    for (let i = 0; i < cap + 2; i++) {
      expect((await deliver(deps, { contactId: "c-owner", body: `o${i}`, idempotencyKey: `o${i}` })).status).toBe("sent");
    }
  });

  it("refuses unknown contacts and contacts with no address for the channel", async () => {
    const { deps, store, ports } = setup();
    store.contacts.push({ id: "c-nophone", kind: "vendor", displayName: "No Phone", preferredChannel: "sms", preferredLanguage: "en", isAllowlisted: true });
    expect(await deliver(deps, { contactId: "nope", body: "x", idempotencyKey: "a" })).toEqual({ status: "unknown_contact" });
    expect(await deliver(deps, { contactId: "c-nophone", body: "x", idempotencyKey: "b" })).toEqual({ status: "no_address", channel: "sms" });
    expect(ports.sms.sent).toHaveLength(0);
  });
});

describe("renderTemplate", () => {
  it("fills variables and refuses to send a message with one missing", () => {
    expect(renderTemplate("Hi {{ first_name }}, {{q}}", { first_name: "Maria", q: "ok?" })).toBe("Hi Maria, ok?");
    expect(() => renderTemplate("Hi {{first_name}}", {})).toThrow(/first_name/);
  });
});

describe("staging mode", () => {
  it("rewrites every recipient to the owner and says who it would have reached", async () => {
    const { ports, store } = setup();
    const describe = async (to: string) => {
      const c = (await store.findContactByPhone(to)) ?? (await store.findContactByEmail(to));
      return c ? `${c.kind}: ${c.firstName}` : "unknown";
    };
    const staged = portsForMode("staging", ports, OWNER, describe);
    const deps = { store, ports: staged, policy: createTestWorld().loaded.policy, now: () => NOW };

    await deliver(deps, { contactId: "c-tenant", body: "Hola", idempotencyKey: "k1" });
    await deliver(deps, { contactId: "c-hvac", body: "Hello", idempotencyKey: "k2" });

    expect(ports.sms.sent).toMatchObject([{ to: OWNER.phone, body: "[STAGING → would send to tenant: Maria] Hola" }]);
    expect(ports.email.sent).toMatchObject([{ to: OWNER.email }]);
    expect(ports.email.sent[0]!.body).toContain("would send to vendor: Linh");
    const realAddresses: string[] = [CONTACTS.tenant.phone, CONTACTS.hvac.email];
    expect([...ports.sms.sent, ...ports.email.sent].some((m) => realAddresses.includes(m.to))).toBe(false);
  });

  it("treats a missing or misspelled mode as staging, never live", () => {
    expect(parseMode(undefined)).toBe("staging");
    expect(parseMode("LIVE")).toBe("staging");
    expect(parseMode("prod")).toBe("staging");
    expect(parseMode("live")).toBe("live");
  });
});
