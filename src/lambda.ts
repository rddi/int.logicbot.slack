// AWS Lambda entrypoint for Logic Bot
// This file exports the Lambda handler that uses AwsLambdaReceiver

import { AwsLambdaReceiver } from '@slack/bolt';
import { setAppReceiver } from './config';
import type {
  APIGatewayProxyHandlerV2,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';

// Create AWS Lambda receiver
const receiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

// Set app with receiver BEFORE importing handlers
setAppReceiver(receiver);

// Import all handlers - they will register on the app with receiver
import './index';

// Get the Bolt handler
const boltHandler = receiver.toHandler();

// Wrapper handler that handles Slack URL verification before Bolt processing
export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> => {
  // Handle POST requests with url_verification in body
  const rawBody = event.body
  ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
  : '';

  if (rawBody) {
    try {
      const body = JSON.parse(rawBody);
      if (body.type === 'url_verification' && body.challenge) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge: body.challenge }),
        };
      }
    } catch {
      // not JSON; continue
    }
  }

  // All other requests go to Bolt handler
  // AwsLambdaReceiver expects v1 events, so we need to convert or pass through
  // The receiver should handle the conversion internally
  return boltHandler(event as any, context, () => {}) as Promise<APIGatewayProxyResultV2>;
};
