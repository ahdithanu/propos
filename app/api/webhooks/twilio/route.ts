import { verifyTwilioSignature } from "@/adapters/twilio-signature";
import { getPipeline } from "@/runtime";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const twiml = (status: number) => new Response(EMPTY_TWIML, { status, headers: { "Content-Type": "text/xml" } });

/** Inbound SMS. Replies are sent by the pipeline, never in the webhook response. */
export async function POST(request: Request): Promise<Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return new Response("SMS webhook is not configured", { status: 503 });

  const params = Object.fromEntries(
    [...(await request.formData()).entries()].map(([key, value]) => [key, String(value)]),
  );
  // Twilio signs the public URL it called, which is not always what the app sees behind a proxy.
  const url = process.env.TWILIO_WEBHOOK_URL ?? request.url;
  if (!verifyTwilioSignature(authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new Response("invalid signature", { status: 403 });
  }

  const { MessageSid, From, Body } = params;
  if (!MessageSid || !From) return new Response("missing MessageSid or From", { status: 400 });

  // The event is stored before anything else, so if a later step fails Twilio's
  // retry is deduplicated and the sweeper re-queues the stored event.
  await (await getPipeline()).receive({
    source: "twilio", externalId: MessageSid, channel: "sms", from: From, body: Body ?? "", signatureValid: true,
  });
  return twiml(200);
}
