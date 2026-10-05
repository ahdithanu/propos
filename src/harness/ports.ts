/**
 * Outbound ports. Real adapters (Phase 5) and mocks implement the same
 * interfaces, so tests and evals run the exact production code path.
 */

export interface SmsPort {
  send(msg: { to: string; body: string; idempotencyKey: string }): Promise<{ providerId: string }>;
}

export interface EmailPort {
  send(msg: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ providerId: string }>;
}

export interface CalendarPort {
  createEvent(ev: {
    title: string;
    startsAt: Date;
    endsAt: Date;
    idempotencyKey: string;
  }): Promise<{ eventId: string }>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface Ports {
  sms: SmsPort;
  email: EmailPort;
  calendar: CalendarPort;
}
