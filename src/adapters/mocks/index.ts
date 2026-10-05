import type { CalendarPort, EmailPort, Ports, SmsPort } from "@/harness/ports";

/**
 * Mock adapters record everything "sent" so tests can assert on it. Like a real
 * provider, a repeated idempotency key returns the first result and sends nothing.
 */

export class MockSms implements SmsPort {
  sent: { to: string; body: string; idempotencyKey: string; providerId: string }[] = [];
  /** Every call, including failed ones. */
  attempts: { to: string; body: string; idempotencyKey: string }[] = [];
  private failures: ((msg: { to: string; body: string }) => boolean)[] = [];

  /** The next `times` sends matching `when` (default: any) throw. */
  failNext(times = 1, when: (msg: { to: string; body: string }) => boolean = () => true) {
    for (let i = 0; i < times; i++) this.failures.push(when);
  }

  /** Every send matching `when` throws until `heal()` is called. */
  failAlways(when: (msg: { to: string; body: string }) => boolean = () => true) {
    this.permanent = when;
  }
  heal() {
    this.permanent = undefined;
    this.failures = [];
  }
  private permanent?: (msg: { to: string; body: string }) => boolean;

  async send(msg: { to: string; body: string; idempotencyKey: string }) {
    this.attempts.push(msg);
    const prior = this.sent.find((s) => s.idempotencyKey === msg.idempotencyKey);
    if (prior) return { providerId: prior.providerId };
    if (this.permanent?.(msg)) throw new Error("mock sms: provider unavailable");
    const idx = this.failures.findIndex((f) => f(msg));
    if (idx >= 0) {
      this.failures.splice(idx, 1);
      throw new Error("mock sms: transient failure");
    }
    const providerId = `SM-mock-${this.sent.length + 1}`;
    this.sent.push({ ...msg, providerId });
    return { providerId };
  }

  to(phone: string) {
    return this.sent.filter((s) => s.to === phone);
  }
}

export class MockEmail implements EmailPort {
  sent: { to: string; subject: string; body: string; idempotencyKey: string; providerId: string }[] = [];

  async send(msg: { to: string; subject: string; body: string; idempotencyKey: string }) {
    const prior = this.sent.find((s) => s.idempotencyKey === msg.idempotencyKey);
    if (prior) return { providerId: prior.providerId };
    const providerId = `EM-mock-${this.sent.length + 1}`;
    this.sent.push({ ...msg, providerId });
    return { providerId };
  }
}

export class MockCalendar implements CalendarPort {
  events: { eventId: string; title: string; startsAt: Date; endsAt: Date; idempotencyKey: string }[] = [];

  async createEvent(ev: { title: string; startsAt: Date; endsAt: Date; idempotencyKey: string }) {
    const prior = this.events.find((e) => e.idempotencyKey === ev.idempotencyKey);
    if (prior) return { eventId: prior.eventId };
    const eventId = `CAL-mock-${this.events.length + 1}`;
    this.events.push({ ...ev, eventId });
    return { eventId };
  }

  async deleteEvent(eventId: string) {
    this.events = this.events.filter((e) => e.eventId !== eventId);
  }
}

export interface MockPorts extends Ports {
  sms: MockSms;
  email: MockEmail;
  calendar: MockCalendar;
}

export function createMockPorts(): MockPorts {
  return { sms: new MockSms(), email: new MockEmail(), calendar: new MockCalendar() };
}
