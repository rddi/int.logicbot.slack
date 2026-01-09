// AWS Lambda entrypoint for Logic Bot
// This file exports the Lambda handler that uses AwsLambdaReceiver

import { AwsLambdaReceiver } from '@slack/bolt';
import { setAppReceiver } from './config';

// Create AWS Lambda receiver
const receiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

// Set app with receiver BEFORE importing handlers
setAppReceiver(receiver);

// Import all handlers - they will register on the app with receiver
import './index';

// Export the handler
export const handler = receiver.toHandler();
