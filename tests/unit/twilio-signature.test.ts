import { describe, expect, it } from "vitest";
import { twilioSignature, verifyTwilioSignature } from "@/adapters/twilio-signature";

const TOKEN = "test-token-not-a-real-secret";
const URL = "https://example.com/api/webhooks/twilio";
const PARAMS = { MessageSid: "SM123", From: "+14085550111", Body: "hola" };

describe("verifyTwilioSignature", () => {
  const good = twilioSignature(TOKEN, URL, PARAMS);

  it("accepts a correctly signed request regardless of parameter order", () => {
    expect(verifyTwilioSignature(TOKEN, URL, { Body: "hola", From: "+14085550111", MessageSid: "SM123" }, good)).toBe(true);
  });

  it.each([
    ["a changed body", TOKEN, URL, { ...PARAMS, Body: "hola!" }, good],
    ["a changed sender", TOKEN, URL, { ...PARAMS, From: "+14085550100" }, good],
    ["an added parameter", TOKEN, URL, { ...PARAMS, Extra: "1" }, good],
    ["a different URL", TOKEN, `${URL}?x=1`, PARAMS, good],
    ["the wrong token", "other-token", URL, PARAMS, good],
    ["a truncated signature", TOKEN, URL, PARAMS, good.slice(0, -2)],
    ["no signature", TOKEN, URL, PARAMS, null],
    ["an empty signature", TOKEN, URL, PARAMS, ""],
    ["an empty token", "", URL, PARAMS, twilioSignature("", URL, PARAMS)],
  ])("rejects %s", (_name, token, url, params, signature) => {
    expect(verifyTwilioSignature(token, url, params, signature)).toBe(false);
  });
});
