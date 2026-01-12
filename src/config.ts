// Configuration and constants

import * as dotenv from 'dotenv';
import { App, LogLevel } from '@slack/bolt';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'LOGIC_CHANNEL_ID_MAIN',
  'LOGIC_CHANNEL_ID_TEST',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Configuration
export const ALLOWED_CHANNEL_IDS = [
  process.env.LOGIC_CHANNEL_ID_MAIN!,
  process.env.LOGIC_CHANNEL_ID_TEST!,
];

export const ADMIN_USER_IDS = process.env.LOGIC_ADMIN_USER_IDS
  ? process.env.LOGIC_ADMIN_USER_IDS.split(',').map(id => id.trim())
  : [];

export const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Initialize Slack app
// For Lambda, receiver will be set via setAppReceiver()
// Initialize Slack app
let appInstance: App | null = null;

export function getApp(): App {
  if (!appInstance) {
    throw new Error(
      "Slack App not initialised. In Lambda, lambda.ts must call setAppReceiver(receiver) before importing handlers."
    );
  }
  return appInstance;
}

export function setAppReceiver(receiver: any) {
  if (appInstance) {
    throw new Error("App already initialized. Receiver must be set before app creation.");
  }
  appInstance = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    logLevel: LogLevel.INFO,
    processBeforeResponse: true,
    receiver,
  });
}

// Lazy export to preserve existing imports: `import { app } from './config'`
export const app = new Proxy({} as App, {
  get(_target, prop) {
    return (getApp() as any)[prop];
  },
}) as App;

// IMPORTANT:
// Do NOT eagerly create the App at module load.
// In Lambda mode, lambda.ts will call setAppReceiver(receiver) before importing handlers.
// In local/server mode, callers should call getApp() explicitly (or create their own entrypoint).

// Cache bot user ID / bot ID (set during startup)
export let BOT_USER_ID: string | null = null;
export let BOT_ID: string | null = null;

export function setBotIdentity(userId: string, botId: string | null) {
  BOT_USER_ID = userId;
  BOT_ID = botId;
}

// Regex for parsing question text
export const QUESTION_REGEX = /\s*?:brain: (.+) asks:\n/;
