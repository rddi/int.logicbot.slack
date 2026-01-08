import { App, LogLevel } from '@slack/bolt';
import * as dotenv from 'dotenv';

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
const ALLOWED_CHANNEL_IDS = [
  process.env.LOGIC_CHANNEL_ID_MAIN!,
  process.env.LOGIC_CHANNEL_ID_TEST!,
];

const ADMIN_USER_IDS = process.env.LOGIC_ADMIN_USER_IDS
  ? process.env.LOGIC_ADMIN_USER_IDS.split(',').map(id => id.trim())
  : [];

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  logLevel: LogLevel.INFO,
  processBeforeResponse: true,
});

// Cache bot user ID / bot ID (set during startup)
let BOT_USER_ID: string | null = null;
let BOT_ID: string | null = null;

// Types
interface RoundState {
  version: string;
  op: string; // User ID of the OP
  status: 'OPEN' | 'SOLVED';
  threadTs: string; // Thread timestamp (root message ts for the round)
  channelId: string;
}

interface ScoreboardData {
  scoresByYear: Record<string, Record<string, number>>; // year -> userId -> score
  lastUpdated: string; // ISO timestamp
}

interface SolvePromptPayload {
  channelId: string;
  threadTs: string;
  guessAuthorId: string;
  roundControlTs: string;
  questionText: string;
  answerText: string;
  dmChannelId: string;
  dmMessageTs: string;
}

interface PrivateAnswerPayload {
  channelId: string;
  threadTs: string;
  submitterId: string;
  roundControlTs: string;
  questionText: string;
  answerText: string;
  dmChannelId: string;
  dmMessageTs: string;
}

// Helper: Resolve user ID from token
async function resolveUserIdFromToken(client: any, token: string): Promise<string | null> {
  const t = token.trim();

  // Case 1: Slack mention token: <@U123ABC456> or <@U123ABC456|matt>
  const mention = t.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/);
  if (mention) return mention[1];

  // Case 2: Raw ID: U123ABC456
  if (/^U[A-Z0-9]{8,}$/.test(t)) return t;

  // Case 3: Plain @handle: @matt  -> look up user by name/display_name/real_name
  const handle = t.startsWith('@') ? t.slice(1) : t;
  if (!handle) return null;

  // users.list can be large; this is simplest, but you may want caching later
  const res = await client.users.list();
  const members = res.members || [];

  const found = members.find((u: any) => {
    const name = (u.name || '').toLowerCase();
    const display = (u.profile?.display_name || '').toLowerCase();
    const real = (u.profile?.real_name || '').toLowerCase();
    const h = handle.toLowerCase();
    return name === h || display === h || real === h;
  });

  return found?.id || null;
}

// Helper: Check if channel is allowed
function isAllowedChannel(channelId: string): boolean {
  return ALLOWED_CHANNEL_IDS.includes(channelId);
}

// Helper: Check if user is admin
function isAdmin(userId: string): boolean {
  return ADMIN_USER_IDS.includes(userId);
}

// Helper: Parse round state from bot message text
function parseRoundState(text: string): RoundState | null {
  try {
    // Format: [logic_round v1] op=U123 status=OPEN threadTs=123.456 channelId=C123
    const match = text.match(
      /\[logic_round v(\d+)\]\s+op=(\w+)\s+status=(\w+)\s+threadTs=([\d.]+)\s+channelId=(\w+)/
    );
    if (!match) return null;

    return {
      version: match[1],
      op: match[2],
      status: match[3] as 'OPEN' | 'SOLVED',
      threadTs: match[4],
      channelId: match[5],
    };
  } catch {
    return null;
  }
}

// Helper: Format round state to bot message text
function formatRoundState(state: RoundState): string {
  return `[logic_round v${state.version}] op=${state.op} status=${state.status} threadTs=${state.threadTs} channelId=${state.channelId}`;
}

// Helper: Get bot user ID / bot ID (cached)
async function ensureBotIdentity(): Promise<{ botUserId: string; botId: string | null }> {
  if (!BOT_USER_ID) {
    const authResult = await app.client.auth.test();
    BOT_USER_ID = authResult.user_id!;
    BOT_ID = authResult.bot_id || null;
  }
  return { botUserId: BOT_USER_ID!, botId: BOT_ID };
}

// Helper: Find round control message in a thread
async function findRoundControlMessage(
  channelId: string,
  threadTs: string
): Promise<{ ts: string; state: RoundState } | null> {
  try {
    const result = await app.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
    });

    if (!result.messages) return null;

    // Find the bot's control message
    const { botUserId, botId } = await ensureBotIdentity();
    for (const message of result.messages) {
      const msgAny = message as any;
      const isFromThisBot =
        (message.user && message.user === botUserId) ||
        (botId && msgAny.bot_id && msgAny.bot_id === botId);

      if (
        isFromThisBot &&
        message.text &&
        message.text.startsWith('[logic_round')
      ) {
        const state = parseRoundState(message.text);
        if (state) {
          return { ts: message.ts!, state };
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding round control message:', error);
    return null;
  }
}

// Helper: Get or create scoreboard message
async function getOrCreateScoreboard(channelId: string): Promise<string> {
  try {
    // Get pinned messages
    const pins = await app.client.pins.list({ channel: channelId });

    if (pins.items) {
      const { botUserId } = await ensureBotIdentity();

      // Find existing scoreboard
      for (const item of pins.items) {
        // Check if item is a message type and has message property
        if ('message' in item && item.message) {
          const message = item.message as any; // Type assertion needed due to Slack API types
          if (message.user === botUserId) {
            const text = message.text || '';
            if (text.includes('"scores"') || text.includes('Scoreboard')) {
              return message.ts!;
            }
          }
        }
      }
    }

    // Create new scoreboard
    const result = await app.client.chat.postMessage({
      channel: channelId,
      text: 'Scoreboard',
    });

    const scoreboardData: ScoreboardData = {
      scoresByYear: {},
      lastUpdated: new Date().toISOString(),
    };

    // Update with JSON data
    await app.client.chat.update({
      channel: channelId,
      ts: result.ts!,
      text: `Scoreboard\n\`\`\`json\n${JSON.stringify(scoreboardData, null, 2)}\n\`\`\``,
    });

    // Pin the message
    await app.client.pins.add({
      channel: channelId,
      timestamp: result.ts!,
    });

    return result.ts!;
  } catch (error) {
    console.error('Error getting/creating scoreboard:', error);
    throw error;
  }
}

// Helper: Get scoreboard data
async function getScoreboardData(channelId: string): Promise<ScoreboardData> {
  try {
    const scoreboardTs = await getOrCreateScoreboard(channelId);
    const result = await app.client.conversations.history({
      channel: channelId,
      latest: scoreboardTs,
      limit: 1,
      inclusive: true,
    });

    if (!result.messages || result.messages.length === 0) {
      return { scoresByYear: {}, lastUpdated: new Date().toISOString() };
    }

    const message = result.messages[0];
    const text = message.text || '';

    // Extract JSON from code block
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    // Fallback: try parsing entire message
    try {
      const parsed = JSON.parse(text);
      // Ensure scoresByYear exists for backward compatibility
      if (!parsed.scoresByYear) {
        parsed.scoresByYear = {};
      }
      // Remove legacy scores field if it exists
      if (parsed.scores) {
        delete parsed.scores;
      }
      return parsed;
    } catch {
      return { scoresByYear: {}, lastUpdated: new Date().toISOString() };
    }
  } catch (error) {
    console.error('Error getting scoreboard data:', error);
    return { scoresByYear: {}, lastUpdated: new Date().toISOString() };
  }
}

// Helper: Update scoreboard
async function updateScoreboard(
  channelId: string,
  updateFn: (data: ScoreboardData) => ScoreboardData
): Promise<void> {
  try {
    const scoreboardTs = await getOrCreateScoreboard(channelId);
    const currentData = await getScoreboardData(channelId);
    const updatedData = updateFn(currentData);
    updatedData.lastUpdated = new Date().toISOString();

    await app.client.chat.update({
      channel: channelId,
      ts: scoreboardTs,
      text: `Scoreboard\n\`\`\`json\n${JSON.stringify(updatedData, null, 2)}\n\`\`\``,
    });
  } catch (error) {
    console.error('Error updating scoreboard:', error);
    throw error;
  }
}

// Helper: Extract year from Slack timestamp (ts format: "1234567890.123456")
function getYearFromTimestamp(ts: string): string {
  const timestamp = parseFloat(ts);
  const date = new Date(timestamp * 1000);
  return date.getFullYear().toString();
}

// Helper: Add points to a user (with optional year tracking)
async function addPoints(
  channelId: string,
  userId: string,
  points: number,
  year?: string
): Promise<void> {
  await updateScoreboard(channelId, (data) => {
    // Initialize scoresByYear if it doesn't exist
    if (!data.scoresByYear) {
      data.scoresByYear = {};
    }

    // Year-based scores (year is required)
    if (year) {
      if (!data.scoresByYear[year]) {
        data.scoresByYear[year] = {};
      }
      data.scoresByYear[year][userId] = (data.scoresByYear[year][userId] || 0) + points;
      if (data.scoresByYear[year][userId] < 0) data.scoresByYear[year][userId] = 0;
    }

    return data;
  });
}

// Helper: Check if message looks like a guess
function looksLikeGuess(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return (
    lower.startsWith('my guess') ||
    lower.startsWith('guess:') ||
    lower.startsWith('answer:') ||
    lower.startsWith('is it')
  );
}

// Helper: Open a DM with a user
async function openDmChannel(client: any, userId: string): Promise<string> {
  const res = await client.conversations.open({ users: userId });
  const dmChannelId = res.channel?.id;
  if (!dmChannelId) throw new Error('Failed to open DM channel');
  return dmChannelId;
}

// Helper: Slack message permalink (for "View thread" link button)
async function getPermalink(client: any, channelId: string, messageTs: string): Promise<string | null> {
  try {
    const res = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return res.permalink || null;
  } catch (e) {
    console.error('Error getting permalink:', e);
    return null;
  }
}

// Helper: Create DM solve confirmation blocks
function buildSolveDmBlocks(params: {
  guessAuthorId: string;
  questionText: string;
  answerText: string;
  permalink: string | null;
  payloadValue: string;
}) {
  const { guessAuthorId, questionText, answerText, permalink, payloadValue } = params;

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `Has <@${guessAuthorId}> solved your question:\n\n` +
          `> *"${questionText}"*\n\n` +
          `with their answer:\n\n` +
          `> _"${answerText}"_`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Yes' },
          style: 'primary',
          action_id: 'confirm_solve',
          value: payloadValue,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'No' },
          action_id: 'cancel_solve',
          value: payloadValue,
        },
      ],
    },
  ];

  // Add "View thread" link button if we have a permalink
  if (permalink) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View thread' },
          url: permalink,
          action_id: 'view_thread_link',
        },
      ],
    });
  }

  return blocks;
}

// Helper: Update DM message in-place to show status
async function updateDmMessageStatus(client: any, dmChannelId: string, dmMessageTs: string, text: string, status: 'CONFIRMED' | 'CANCELLED') {
  const statusEmoji = status === 'CONFIRMED' ? '✅' : '❌';
  await client.chat.update({
    channel: dmChannelId,
    ts: dmMessageTs,
    text: `${statusEmoji} ${text}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji} ${text}`,
        },
      },
    ],
  });
}

// Helper: Create DM blocks for private answer confirmation (similar to buildSolveDmBlocks but for private answers)
function buildPrivateAnswerDmBlocks(params: {
  submitterId: string;
  questionText: string;
  answerText: string;
  permalink: string | null;
  payloadValue: string;
}) {
  const { submitterId, questionText, answerText, permalink, payloadValue } = params;

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `Has <@${submitterId}> solved your question:\n\n` +
          `> "${questionText}"\n\n` +
          `with their private answer:\n\n` +
          `> _"${answerText}"_`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Yes' },
          style: 'primary',
          action_id: 'confirm_private_solve',
          value: payloadValue,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'No' },
          action_id: 'cancel_private_solve',
          value: payloadValue,
        },
      ],
    },
  ];

  // Add "View thread" link button if we have a permalink
  if (permalink) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View thread' },
          url: permalink,
          action_id: 'view_thread_link',
        },
      ],
    } as any);
  }

  return blocks;
}

// Slash command handler
app.command('/logic', async ({ command, ack, respond, client }) => {
  await ack();

  const { channel_id, user_id, text } = command;

  // Check if channel is allowed
  if (!isAllowedChannel(channel_id)) {
    await respond({
      response_type: 'ephemeral',
      text: "Sorry, I only operate in specific channels. This command isn't available here.",
    });
    return;
  }

  // IMPORTANT: don't lowercase the raw text globally, because it can contain <@U...> mentions
  const rawText = (text || '').trim();
  const commandTextLower = rawText.toLowerCase();

  const section1 = `*Logic Bot Commands:*
\`/logic <your question>\` - Start a new round by posting the question to the channel and starting a thread
\`/logic help\` - Show this help message
\`/logic scoreboard\` - Ensure scoreboard exists and show it
\`/logic stats\` - Show your stats
\`/logic stats @user\` - Show stats for a user`;

let section2 = '';
if (isAdmin(user_id)) {
  section2 = `\n\n*Admin Commands:*
\`/logic setscore @user 10\` - Set a user's score
\`/logic addpoint @user\` - Add 1 point to a user
\`/logic removepoint @user\` - Remove 1 point from a user`;
}

  const section3 = `\n\n*How it works:*
- A round = a Slack thread (the bot creates the thread for you)
- Start a round by running \`/logic <question>\` in the channel
- The OP (who started the round) reacts with :yes: to a guess to solve it
- Points are awarded when a round is solved`;

  const helpText = `${section1}${section2}${section3}`;

  // Handle subcommands
  if (commandTextLower === 'help') {
    await respond({
      response_type: 'ephemeral',
      text: helpText,
    });
    return;
  }

  if (commandTextLower === 'scoreboard') {
    try {
      await getOrCreateScoreboard(channel_id);
      const data = await getScoreboardData(channel_id);

      // Ensure scoresByYear exists
      if (!data.scoresByYear) {
        data.scoresByYear = {};
      }

      // Get all years and sort them (newest first)
      const years = Object.keys(data.scoresByYear).sort((a, b) => parseInt(b) - parseInt(a));

      let scoreboardText = '*Scoreboard*\n\n';

      if (years.length === 0) {
        scoreboardText += 'No scores yet.';
      } else {
        // Display scores by year
        for (const year of years) {
          const yearScores = data.scoresByYear[year];
          if (!yearScores || Object.keys(yearScores).length === 0) continue;

          scoreboardText += `*${year}*\n`;
          const entries = Object.entries(yearScores)
            .sort(([, a], [, b]) => b - a);

          for (const [userId, score] of entries) {
            try {
              const userInfo = await client.users.info({ user: userId });
              const displayName = userInfo.user?.real_name || userInfo.user?.name || userId;
              scoreboardText += `  ${displayName}: ${score}\n`;
            } catch {
              scoreboardText += `  <@${userId}>: ${score}\n`;
            }
          }
          scoreboardText += '\n';
        }
      }

      await respond({
        response_type: 'ephemeral',
        text: scoreboardText,
      });
    } catch (error) {
      console.error('Error showing scoreboard:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error displaying scoreboard.',
      });
    }
    return;
  }

  if (commandTextLower.startsWith('stats')) {
    try {
      let targetUserId = user_id;

      // Check if @user was mentioned (use rawText, not lowercased)
      const mentionMatch = rawText.match(/stats\s+<@(\w+)>/i);
      if (mentionMatch) {
        targetUserId = mentionMatch[1];
      }

      const data = await getScoreboardData(channel_id);
      
      // Calculate total score across all years
      let totalScore = 0;
      if (data.scoresByYear) {
        for (const yearScores of Object.values(data.scoresByYear)) {
          totalScore += yearScores[targetUserId] || 0;
        }
      }

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `*Stats for ${displayName}:*\n${totalScore} point${totalScore !== 1 ? 's' : ''}`,
      });
    } catch (error) {
      console.error('Error showing stats:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error displaying stats.',
      });
    }
    return;
  }

  // Admin commands
  if (commandTextLower.startsWith('setscore')) {
    if (!isAdmin(user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: 'Sorry, only admins can use this command.',
      });
      return;
    }

    // Use rawText to preserve mention formatting, but allow uppercase/lowercase command
    const match = rawText.match(/setscore\s+<@(\w+)>\s+(\d+)/i);
    if (!match) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /logic setscore @user <points>',
      });
      return;
    }

    // const targetUserId = match[1];



    let targetUserId: string | null = null;

    try {
      targetUserId = await resolveUserIdFromToken(client, match[1]);
    } catch (error) {
      console.error('Error resolving user ID:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error resolving user ID.',
      });
      return;
    }

    if (!targetUserId) {
      await respond({
        response_type: 'ephemeral',
        text: 'User not found.',
      });
      return;
    }
    const points = parseInt(match[2], 10);

    try {
      // Use current year for admin-set scores
      const currentYear = new Date().getFullYear().toString();
      await updateScoreboard(channel_id, (data) => {
        // Initialize scoresByYear if it doesn't exist
        if (!data.scoresByYear) {
          data.scoresByYear = {};
        }
        if (!data.scoresByYear[currentYear]) {
          data.scoresByYear[currentYear] = {};
        }

        // Set year-based score
        data.scoresByYear[currentYear][targetUserId] = points;
        if (data.scoresByYear[currentYear][targetUserId] < 0) {
          data.scoresByYear[currentYear][targetUserId] = 0;
        }

        return data;
      });

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `Set ${displayName}'s score to ${points} points.`,
      });
    } catch (error) {
      console.error('Error setting score:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error setting score.',
      });
    }
    return;
  }

  if (commandTextLower.startsWith('addpoint')) {
    if (!isAdmin(user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: 'Sorry, only admins can use this command.',
      });
      return;
    }

    const match = rawText.match(/addpoint\s+@(\w+)/i);
    if (!match) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /logic addpoint @user, received: ' + rawText,
      });
      return;
    }

    

    let targetUserId: string | null = null;

    try {
      targetUserId = await resolveUserIdFromToken(client, match[1]);
    } catch (error) {
      console.error('Error resolving user ID:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error resolving user ID.',
      });
      return;
    }

    if (!targetUserId) {
      await respond({
        response_type: 'ephemeral',
        text: 'User not found.',
      });
      return;
    }

    console.log(targetUserId);

    try {
      // Use current year for admin-added points
      const currentYear = new Date().getFullYear().toString();
      await addPoints(channel_id, targetUserId, 1, currentYear);

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `Added 1 point to ${displayName}.`,
      });
    } catch (error) {
      console.error('Error adding point:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error adding point.',
      });
    }
    return;
  }

  if (commandTextLower.startsWith('removepoint')) {
    if (!isAdmin(user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: 'Sorry, only admins can use this command.',
      });
      return;
    }

    const match = rawText.match(/removepoint\s+<@(\w+)>/i);
    if (!match) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /logic removepoint @user',
      });
      return;
    }

    // const targetUserId = match[1];



    let targetUserId: string | null = null;

    try {
      targetUserId = await resolveUserIdFromToken(client, match[1]);
    } catch (error) {
      console.error('Error resolving user ID:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error resolving user ID.',
      });
      return;
    }

    if (!targetUserId) {
      await respond({
        response_type: 'ephemeral',
        text: 'User not found.',
      });
      return;
    }

    try {
      // Use current year for admin-removed points
      const currentYear = new Date().getFullYear().toString();
      await addPoints(channel_id, targetUserId, -1, currentYear);

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `Removed 1 point from ${displayName}.`,
      });
    } catch (error) {
      console.error('Error removing point:', error);
      await respond({
        response_type: 'ephemeral',
        text: 'Error removing point.',
      });
    }
    return;
  }

  // /logic <question> posts the question to the channel, then starts a thread on that post.
  if (!rawText) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/logic <your question>`\nExample: `/logic I speak without a mouth and hear without ears. What am I?`',
    });
    return;
  }

  try {
    // 1) Post the riddle to the channel as a normal message with a button for private answers
    const riddlePost = await client.chat.postMessage({
      channel: channel_id,
      text: `🧠 <@${user_id}> asks:\n_*${rawText}*_`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🧠 <@${user_id}> asks:\n_*${rawText}*_`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Submit answer privately' },
              action_id: 'submit_private_answer',
              value: JSON.stringify({
                channelId: channel_id,
                threadTs: '', // Will be set after post
              }),
            },
          ],
        },
      ],
    });

    if (!riddlePost.ts) {
      throw new Error('Failed to create puzzle post (missing ts).');
    }

    const threadTs = riddlePost.ts;

    // Update the button value with the actual threadTs
    await client.chat.update({
      channel: channel_id,
      ts: riddlePost.ts,
      text: `🧠 <@${user_id}> asks:\n_*${rawText}*_`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🧠 <@${user_id}> asks:\n_*${rawText}*_`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Submit answer privately' },
              action_id: 'submit_private_answer',
              value: JSON.stringify({
                channelId: channel_id,
                threadTs: threadTs,
              }),
            },
          ],
        },
      ],
    });

    // 2) Ensure a round doesn't already exist in that new thread (it shouldn't, but keeps logic consistent)
    const existingRound = await findRoundControlMessage(channel_id, threadTs);
    if (existingRound) {
      await respond({
        response_type: 'ephemeral',
        text: 'A round already exists for that puzzle thread.',
      });
      return;
    }

    // 3) Create round control message in the thread (first reply)
    const roundState: RoundState = {
      version: '1',
      op: user_id,
      status: 'OPEN',
      threadTs: threadTs,
      channelId: channel_id,
    };

    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: threadTs,
      text: formatRoundState(roundState),
    });

    // Optional: friendly instruction message (keeps control message machine-parseable)
    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: threadTs,
      text:
        `Round OPEN - OP: <@${user_id}>\n` +
        `Reply in this thread with guesses.\n` +
        `OP reacts with :yes: on the correct guess to solve (you’ll be asked to confirm).`,
    });

    await respond({
      response_type: 'ephemeral',
      text: 'Puzzle posted and round started. Use the thread under the puzzle for guesses.',
    });
  } catch (error) {
    console.error('Error starting round:', error);
    await respond({
      response_type: 'ephemeral',
      text: 'Error starting round.',
    });
  }
});

// Reaction handler: OP reacts with :yes: to solve
app.event('reaction_added', async ({ event, client }) => {
  // Only process reactions in allowed channels
  if (!event.item?.channel || !isAllowedChannel(event.item.channel)) {
    return;
  }

  // Only process :yes: reactions
  if (event.reaction !== 'yes') {
    console.log('Reaction is not :yes:', event.reaction);
    return;
  }
  console.log('Reaction is :yes:', event.reaction);

  if (!event.item.ts) {
    console.log('Reaction item ts is missing');
    return;
  }
  console.log('Reaction item ts is present');

  const channelId = event.item.channel;
  const reactedMessageTs = event.item.ts;

  try {
    // First, get the message to find if it's in a thread
    const messageInfo = await client.conversations.history({
      channel: channelId,
      latest: reactedMessageTs,
      limit: 1,
      inclusive: true,
    });

    if (!messageInfo.messages || messageInfo.messages.length === 0) {
      console.log('No messages found in history');
      return;
    }

    const rootMessage = messageInfo.messages[0];
    
    // Must be in a thread
    if (!rootMessage.thread_ts) {
      console.log('Reacted message thread ts is missing');
      return;
    }

    const threadTs = rootMessage.thread_ts;

    // Get all messages in the thread to find the specific one that was reacted to
    const threadReplies = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
    });

    if (!threadReplies.messages) {
      console.log('No thread replies found');
      return;
    }

    // Find the exact message that was reacted to
    const reactedMessage = threadReplies.messages.find(
      (msg) => msg.ts === reactedMessageTs
    );

    if (!reactedMessage) {
      console.log('Reacted message not found in thread');
      return;
    }

    const answerText = (reactedMessage.text || '(no text)').trim();

    // Find the round
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo) {
      console.log('No round found in this thread');
      return; // No round in this thread
    } else {
      console.log('Round found in this thread');
    }

    const { state } = roundInfo;

    // Check if already solved
    if (state.status === 'SOLVED') {
      console.log('Round is already solved');
      return;
    } else {
      console.log('Round is not solved');
    }

    // Check if the reactor is the OP
    if (event.user !== state.op) {
      console.log('Reactor is not the OP');
      return; // Only OP can solve
    } else {
      console.log('Reactor is the OP');
    }

    // Get the author of the reacted message
    if (!reactedMessage.user) {
      console.log('Reacted message user is missing');
      return;
    } else {
      console.log('Reacted message user is present');
      console.log(reactedMessage);
    }

    const guessAuthorId = event.item_user;

    // Don't let OP solve their own guess (except in test channel)
    if (guessAuthorId === state.op) {
      console.log('Guess author is the OP');
      if (channelId === process.env.LOGIC_CHANNEL_ID_TEST) {
        console.log('Guess author is the OP in test channel', guessAuthorId, state.op);
      } else {
        return;
      }
    } else {
        console.log('Guess author is not the OP', guessAuthorId, state.op);
    }

    // Fetch the original question (thread root message)
    const threadRoot = await client.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    const rootMsg = threadRoot.messages?.[0];
    const questionTextRaw = (rootMsg?.text || '(unknown question)').trim();
    const regex = /\s*?:brain: (.+) asks:\n/;
    const questionText = questionTextRaw.replace(regex, '').trim() || questionTextRaw;
    console.log('questionTextRaw', questionTextRaw);
    console.log('questionText', questionText);

    // Build payload + permalink
    const dmChannelId = await openDmChannel(client, state.op);
    const permalink = await getPermalink(client, channelId, threadTs);

    const dmMessageText = 'Confirm solution';
    const initialPayload: SolvePromptPayload = {
      channelId,
      threadTs,
      guessAuthorId,
      roundControlTs: roundInfo.ts,
      questionText,
      answerText,
      dmChannelId,
      dmMessageTs: '', // set after post
    };

    // Post DM first (need ts for update-in-place)
    const dmPost = await client.chat.postMessage({
      channel: dmChannelId,
      text: dmMessageText,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `Has <@${guessAuthorId}> solved your question:\n\n` +
              `> "${questionText}"\n\n` +
              `with their answer:\n\n` +
              `> _"${answerText}"_`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Yes' },
              style: 'primary',
              action_id: 'confirm_solve',
              value: '__PAYLOAD_PLACEHOLDER__',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'No' },
              action_id: 'cancel_solve',
              value: '__PAYLOAD_PLACEHOLDER__',
            },
          ],
        },
        ...(permalink
          ? [
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View thread' },
                    url: permalink,
                    action_id: 'view_thread_link',
                  },
                ],
              } as any,
            ]
          : []),
      ],
    });

    if (!dmPost.ts) throw new Error('Failed to post DM confirmation (missing ts)');

    // Now we have dmMessageTs; update DM with correct payload values (includes dm ids for in-place update)
    initialPayload.dmMessageTs = dmPost.ts;

    const payloadValue = JSON.stringify(initialPayload);

    // Update DM so buttons contain the correct payload (and acts as a "single source of truth")
    await client.chat.update({
      channel: dmChannelId,
      ts: dmPost.ts,
      text: dmMessageText,
      blocks: buildSolveDmBlocks({
        guessAuthorId,
        questionText,
        answerText,
        permalink,
        payloadValue,
      }),
    });

    console.log('DM confirmation sent to OP');
  } catch (error) {
    console.error('Error handling reaction:', error);
  }
});

// Button action handler: Confirm solve
app.action('confirm_solve', async ({ action, ack, client }) => {
  await ack();

  if (action.type !== 'button') return;

  try {
    const data = JSON.parse((action as any).value) as SolvePromptPayload;
    const { channelId, threadTs, guessAuthorId, roundControlTs, dmChannelId, dmMessageTs } = data;

    // Anti-double-confirm guard: re-check round status
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo || roundInfo.state.status === 'SOLVED') {
      await updateDmMessageStatus(
        client,
        dmChannelId,
        dmMessageTs,
        'This round was already solved (no changes made).',
        'CANCELLED'
      );
      return;
    }

    // Update round state to SOLVED
    const updatedState: RoundState = {
      ...roundInfo.state,
      status: 'SOLVED',
    };

    await client.chat.update({
      channel: channelId,
      ts: roundControlTs,
      text: formatRoundState(updatedState),
    });

    // Award point (with year tracking from thread timestamp)
    const year = getYearFromTimestamp(threadTs);
    await addPoints(channelId, guessAuthorId, 1, year);

    // Post generic solved message
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '✅ Solved. Point goes to <@' + guessAuthorId + '>',
    });

    // Update the DM message in place
    await updateDmMessageStatus(
      client,
      dmChannelId,
      dmMessageTs,
      'Confirmed — round solved and 1 point awarded to <@' + guessAuthorId + '>.',
      'CONFIRMED'
    );
  } catch (error) {
    console.error('Error confirming solve:', error);

    // Best-effort DM update if payload present
    try {
      const value = (action as any).value;
      if (value) {
        const data = JSON.parse(value) as Partial<SolvePromptPayload>;
        if (data.dmChannelId && data.dmMessageTs) {
          await updateDmMessageStatus(
            client,
            data.dmChannelId,
            data.dmMessageTs,
            'Error solving round. Please try again.',
            'CANCELLED'
          );
        }
      }
    } catch {
      // ignore
    }
  }
});

// Button action handler: Cancel solve
app.action('cancel_solve', async ({ action, ack, client }) => {
  await ack();
  if (action.type !== 'button') return;

  try {
    const data = JSON.parse((action as any).value) as SolvePromptPayload;
    const { dmChannelId, dmMessageTs } = data;

    // Update the DM message in place
    await updateDmMessageStatus(
      client,
      dmChannelId,
      dmMessageTs,
      'Cancelled — round remains open.',
      'CANCELLED'
    );
  } catch (error) {
    console.error('Error cancelling solve:', error);
  }
});

// Private answer submission: Button handler to open modal
app.action('submit_private_answer', async ({ action, ack, body, client }) => {
  await ack();

  if (action.type !== 'button') return;

  try {
    const buttonData = JSON.parse((action as any).value);
    const { channelId, threadTs } = buttonData;

    // Open modal for private answer submission
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'private_answer_modal',
        title: {
          type: 'plain_text',
          text: 'Submit answer',
        },
        submit: {
          type: 'plain_text',
          text: 'Send',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        private_metadata: JSON.stringify({
          channelId,
          threadTs,
          submitterId: (body as any).user.id,
        }),
        blocks: [
          {
            type: 'input',
            block_id: 'answer_input',
            element: {
              type: 'plain_text_input',
              action_id: 'answer',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Enter your answer...',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Your answer',
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('Error opening private answer modal:', error);
  }
});

// Private answer submission: Modal submit handler
app.view('private_answer_modal', async ({ ack, view, client }) => {
  await ack();

  try {
    const metadata = JSON.parse(view.private_metadata);
    const { channelId, threadTs, submitterId } = metadata;

    // Get the answer from the modal
    const answerBlock = view.state.values.answer_input;
    const answerText = (answerBlock?.answer?.value || '').trim();

    if (!answerText) {
      // Answer is empty, modal will show error
      return;
    }

    // Find the round
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo) {
      // Round not found, send error to submitter
      const submitterDm = await openDmChannel(client, submitterId);
      await client.chat.postMessage({
        channel: submitterDm,
        text: '❌ Error: Round not found. The puzzle may have been deleted.',
      });
      return;
    }

    const { state } = roundInfo;

    // Check if already solved
    if (state.status === 'SOLVED') {
      const submitterDm = await openDmChannel(client, submitterId);
      await client.chat.postMessage({
        channel: submitterDm,
        text: '❌ This puzzle has already been solved.',
      });
      return;
    }

    // Get question text from thread root
    const threadRoot = await client.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    const rootMsg = threadRoot.messages?.[0];
    const questionTextRaw = (rootMsg?.text || '(unknown question)').trim();
    // Extract question text, removing the "🧠 <@user> asks:" prefix and markdown formatting
    let questionText = questionTextRaw.replace(/^🧠 <@\w+> asks:\n_?\*?/, '').replace(/_?\*?$/, '').trim() || questionTextRaw;

    // Build payload + permalink
    const dmChannelId = await openDmChannel(client, state.op);
    const permalink = await getPermalink(client, channelId, threadTs);

    const dmMessageText = 'Confirm private answer';
    const initialPayload: PrivateAnswerPayload = {
      channelId,
      threadTs,
      submitterId,
      roundControlTs: roundInfo.ts,
      questionText,
      answerText,
      dmChannelId,
      dmMessageTs: '', // set after post
    };

    // Post DM first (need ts for update-in-place)
    const dmPost = await client.chat.postMessage({
      channel: dmChannelId,
      text: dmMessageText,
      blocks: buildPrivateAnswerDmBlocks({
        submitterId,
        questionText,
        answerText,
        permalink,
        payloadValue: '__PAYLOAD_PLACEHOLDER__',
      }),
    });

    if (!dmPost.ts) throw new Error('Failed to post DM confirmation (missing ts)');

    // Now we have dmMessageTs; update DM with correct payload values
    initialPayload.dmMessageTs = dmPost.ts;
    const payloadValue = JSON.stringify(initialPayload);

    // Update DM so buttons contain the correct payload
    await client.chat.update({
      channel: dmChannelId,
      ts: dmPost.ts,
      text: dmMessageText,
      blocks: buildPrivateAnswerDmBlocks({
        submitterId,
        questionText,
        answerText,
        permalink,
        payloadValue,
      }),
    });
  } catch (error) {
    console.error('Error handling private answer submission:', error);
  }
});

// Private answer: Confirm solve handler
app.action('confirm_private_solve', async ({ action, ack, client }) => {
  await ack();

  if (action.type !== 'button') return;

  try {
    const data = JSON.parse((action as any).value) as PrivateAnswerPayload;
    const { channelId, threadTs, submitterId, roundControlTs, dmChannelId, dmMessageTs } = data;

    // Anti-double-confirm guard: re-check round status
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo || roundInfo.state.status === 'SOLVED') {
      await updateDmMessageStatus(
        client,
        dmChannelId,
        dmMessageTs,
        'This round was already solved (no changes made).',
        'CANCELLED'
      );
      return;
    }

    // Update round state to SOLVED
    const updatedState: RoundState = {
      ...roundInfo.state,
      status: 'SOLVED',
    };

    await client.chat.update({
      channel: channelId,
      ts: roundControlTs,
      text: formatRoundState(updatedState),
    });

    // Award point (with year tracking from thread timestamp)
    const year = getYearFromTimestamp(threadTs);
    await addPoints(channelId, submitterId, 1, year);

    // Post generic solved message in thread
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '✅ Solved. Point goes to <@' + submitterId + '>',
    });

    // Update the OP DM message in place
    await updateDmMessageStatus(
      client,
      dmChannelId,
      dmMessageTs,
      'Confirmed — round solved and 1 point awarded.',
      'CONFIRMED'
    );

    // DM the submitter
    const submitterDm = await openDmChannel(client, submitterId);
    await client.chat.postMessage({
      channel: submitterDm,
      text: '✅ Your private answer was accepted — you earned 1 point.',
    });
  } catch (error) {
    console.error('Error confirming private solve:', error);

    // Best-effort DM update if payload present
    try {
      const value = (action as any).value;
      if (value) {
        const data = JSON.parse(value) as Partial<PrivateAnswerPayload>;
        if (data.dmChannelId && data.dmMessageTs) {
          await updateDmMessageStatus(
            client,
            data.dmChannelId,
            data.dmMessageTs,
            'Error solving round. Please try again.',
            'CANCELLED'
          );
        }
      }
    } catch {
      // ignore
    }
  }
});

// Private answer: Cancel solve handler
app.action('cancel_private_solve', async ({ action, ack, client }) => {
  await ack();
  if (action.type !== 'button') return;

  try {
    const data = JSON.parse((action as any).value) as PrivateAnswerPayload;
    const { dmChannelId, dmMessageTs, submitterId } = data;

    // Update the OP DM message in place
    await updateDmMessageStatus(
      client,
      dmChannelId,
      dmMessageTs,
      'Cancelled — round remains open.',
      'CANCELLED'
    );

    // DM the submitter
    const submitterDm = await openDmChannel(client, submitterId);
    await client.chat.postMessage({
      channel: submitterDm,
      text: '❌ Your private answer was not accepted this time.',
    });
  } catch (error) {
    console.error('Error cancelling private solve:', error);
  }
});

// Message handler: Auto-nudge for solved rounds
app.message(async ({ message, client }) => {
  // Only process user messages (not bot messages or subtypes) in allowed channels
  if (
    message.subtype ||
    !('channel' in message) ||
    !isAllowedChannel(message.channel) ||
    !('user' in message) ||
    !message.user
  ) {
    return;
  }

  // Must be in a thread
  if (!('thread_ts' in message) || !message.thread_ts) {
    return;
  }

  const channelId = message.channel;
  const threadTs = message.thread_ts;
  const messageText = message.text || '';

  // Check if message looks like a guess
  if (!looksLikeGuess(messageText)) {
    return;
  }

  try {
    // Check if round is solved
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo || roundInfo.state.status !== 'SOLVED') {
      return; // Not solved, no nudge needed
    }

    // Post nudge
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "Heads-up: this one's already been solved - feel free to keep guessing for fun though!",
    });
  } catch (error) {
    console.error('Error checking for auto-nudge:', error);
  }
});

// Start the app
(async () => {
  try {
    await app.start(PORT);
    console.log(`⚡️ Logic Bot is running on port ${PORT}!`);
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();