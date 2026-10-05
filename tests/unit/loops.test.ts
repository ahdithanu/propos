import { describe, expect, it } from "vitest";
import { checkLoop, isAutoReply, isNoReplySender } from "@/harness/loops";
import type { Message } from "@/harness/types";

const limits = { max_agent_messages: 3, window_minutes: 30 };
const now = new Date("2026-10-05T18:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function msg(direction: "inbound" | "outbound", body: string, ago: number, isAuto = false): Message {
  return {
    id: `${direction}-${ago}`, threadId: "t", direction, channel: "sms", contactId: "c",
    body, redactedBody: body, isAutoReply: isAuto, createdAt: minutesAgo(ago),
  };
}

describe("isAutoReply", () => {
  it.each([
    [{ headers: { "Auto-Submitted": "auto-replied" }, body: "x" }],
    [{ headers: { "x-autoreply": "yes" }, body: "x" }],
    [{ headers: { Precedence: "bulk" }, body: "x" }],
    [{ from: "No-Reply <noreply@utility.example.com>", body: "Your bill is ready" }],
    [{ body: "I am out of the office until Monday." }],
    [{ body: "Automatic reply: on leave" }],
    [{ body: "I'm driving with Do Not Disturb turned on." }],
    [{ body: "Respuesta automática: estoy de vacaciones" }],
  ])("detects %j", (input) => {
    expect(isAutoReply(input)).toBe(true);
  });

  it.each([
    [{ headers: { "Auto-Submitted": "no" }, body: "the sink is leaking" }],
    [{ body: "The office door lock is broken" }],
    [{ from: "maria@example.com", body: "Can someone reply today?" }],
  ])("does not flag a person: %j", (input) => {
    expect(isAutoReply(input)).toBe(false);
  });

  it("recognises no-reply senders by local part only", () => {
    expect(isNoReplySender("do-not-reply@bank.example.com")).toBe(true);
    expect(isNoReplySender("norman@noreply-consulting.example.com")).toBe(false);
  });
});

describe("checkLoop", () => {
  it("lets a normal conversation through", () => {
    const thread = [msg("inbound", "sink leaking", 20), msg("outbound", "got it", 19)];
    expect(checkLoop({ body: "under the kitchen sink", isAutoReply: false }, thread, limits, now)).toEqual({ suppress: false });
  });

  it("suppresses auto-replies", () => {
    expect(checkLoop({ body: "out of office", isAutoReply: true }, [], limits, now))
      .toEqual({ suppress: true, reason: "auto_reply" });
  });

  it("suppresses the third identical body inside the window, ignoring case and spacing", () => {
    const thread = [msg("inbound", "Thanks for your message", 10), msg("inbound", "thanks  for your MESSAGE", 5)];
    expect(checkLoop({ body: "Thanks for your message ", isAutoReply: false }, thread, limits, now))
      .toEqual({ suppress: true, reason: "repeated_body" });
  });

  it("does not count identical bodies from outside the window", () => {
    const thread = [msg("inbound", "ok", 300), msg("inbound", "ok", 200)];
    expect(checkLoop({ body: "ok", isAutoReply: false }, thread, limits, now)).toEqual({ suppress: false });
  });

  it("suppresses when we have sent the limit since the last human-looking message", () => {
    const thread = [
      msg("inbound", "hello", 25), msg("outbound", "a", 24), msg("inbound", "auto", 23, true),
      msg("outbound", "b", 22), msg("inbound", "auto 2", 21, true), msg("outbound", "c", 20),
    ];
    expect(checkLoop({ body: "something new", isAutoReply: false }, thread, limits, now))
      .toEqual({ suppress: true, reason: "thread_velocity" });
  });

  it("resets the velocity count when a person writes again", () => {
    const thread = [
      msg("outbound", "a", 24), msg("outbound", "b", 22), msg("outbound", "c", 20),
      msg("inbound", "thanks, one more thing", 10), msg("outbound", "d", 9),
    ];
    expect(checkLoop({ body: "and another", isAutoReply: false }, thread, limits, now)).toEqual({ suppress: false });
  });
});
