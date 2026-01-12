console.log("🔥🔥🔥 LAMBDA CODE VERSION: 2026-01-12-CHALLENGE-FIX 🔥🔥🔥");
// AWS Lambda entrypoint for Logic Bot (API Gateway HTTP API -> Lambda proxy)
// Known-good pattern:
// 1) respond to Slack url_verification immediately (no signature check)
// 2) otherwise delegate to AwsLambdaReceiver/Bolt
// 3) never crash without logging

import { AwsLambdaReceiver } from "@slack/bolt";
import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { setAppReceiver } from "./config";

// --- Validate env (do NOT log secrets) ---
const signingSecret = process.env.SLACK_SIGNING_SECRET;
if (!signingSecret) throw new Error("Missing SLACK_SIGNING_SECRET");

const receiver = new AwsLambdaReceiver({ signingSecret });

// IMPORTANT: set receiver before importing any handlers
setAppReceiver(receiver);
import "./index";

// Use receiver.start() handler (more robust than toHandler across event shapes)
const awsHandlerPromise = receiver.start();

function decodeBody(event: any): string {
  if (!event?.body) return "";
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

export const handler: APIGatewayProxyHandlerV2 = async (event, context): Promise<APIGatewayProxyResultV2> => {
  try {
    // 1) Slack URL verification (Slack sends POST with JSON body)
    const rawBody = decodeBody(event);

    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed?.type === "url_verification" && parsed?.challenge) {
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: parsed.challenge }),
          };
        }
      } catch {
        // not JSON; fall through to Bolt
      }
    }

    // 2) Delegate everything else to Bolt
    const awsHandler = await awsHandlerPromise;
    // receiver.start() returns a (event, context, callback) handler
    return (await awsHandler(event as any, context as any, () => {})) as any;
  } catch (err) {
    console.error("Lambda handler error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal Server Error" }),
    };
  }
};