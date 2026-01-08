// Slack API helper functions

import { app, BOT_USER_ID, BOT_ID, setBotIdentity } from '../config';

// Get bot user ID / bot ID (cached)
export async function ensureBotIdentity(): Promise<{ botUserId: string; botId: string | null }> {
  if (!BOT_USER_ID) {
    const authResult = await app.client.auth.test();
    const userId = authResult.user_id!;
    const botId = authResult.bot_id || null;
    setBotIdentity(userId, botId);
  }
  return { botUserId: BOT_USER_ID!, botId: BOT_ID };
}

// Open a DM with a user
export async function openDmChannel(client: any, userId: string): Promise<string> {
  const res = await client.conversations.open({ users: userId });
  const dmChannelId = res.channel?.id;
  if (!dmChannelId) throw new Error('Failed to open DM channel');
  return dmChannelId;
}

// Slack message permalink (for "View thread" link button)
export async function getPermalink(client: any, channelId: string, messageTs: string): Promise<string | null> {
  try {
    const res = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return res.permalink || null;
  } catch (e) {
    console.error('Error getting permalink:', e);
    return null;
  }
}
