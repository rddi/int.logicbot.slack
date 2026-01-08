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

const regex = /\s*?:brain: (.+) asks:\n/;

// Types
enum RoundStatus {
  OPEN = 'OPEN',
  SOLVED = 'SOLVED',
  CLOSED = 'CLOSED',
}

interface RoundState {
  version: string;
  op: string; // User ID of the OP
  status: RoundStatus;
  threadTs: string; // Thread timestamp (root message ts for the round)
  channelId: string;
  answer?: string; // The accepted answer (only present when SOLVED)
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

// Helper: Encode threadTs to make it non-human-readable
function encodeThreadTs(threadTs: string): string {
  return Buffer.from(threadTs).toString('base64');
}

// Helper: Decode threadTs
function decodeThreadTs(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}

// Helper: Encode round state to make it non-human-readable
function encodeRoundState(state: RoundState): string {
  const json = JSON.stringify(state);
  return Buffer.from(json).toString('base64');
}

// Helper: Decode round state
function decodeRoundState(encoded: string): RoundState | null {
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(json) as RoundState;
  } catch {
    return null;
  }
}

// Helper: Parse round state from bot message text
function parseRoundState(text: string): RoundState | null {
  try {
    // Check if it's the new encoded format (base64)
    // Try to decode as base64 first
    try {
      const decoded = decodeRoundState(text);
      if (decoded) {
        return decoded;
      }
    } catch {
      // Not base64, try legacy format
    }

    // Legacy format: [logic_round v1] op=U123 status=OPEN threadTs=123.456 channelId=C123 [answer=...]
    const match = text.match(
      /\[logic_round v(\d+)\]\s+op=(\w+)\s+status=(\w+)\s+threadTs=([\d.]+)\s+channelId=(\w+)(?:\s+answer=([^\]]+))?/
    );
    if (!match) return null;

    // Map string status to enum
    const statusStr = match[3];
    let status: RoundStatus;
    if (statusStr === 'OPEN') {
      status = RoundStatus.OPEN;
    } else if (statusStr === 'SOLVED') {
      status = RoundStatus.SOLVED;
    } else if (statusStr === 'CLOSED') {
      status = RoundStatus.CLOSED;
    } else {
      return null; // Invalid status
    }

    const state: RoundState = {
      version: match[1],
      op: match[2],
      status: status,
      threadTs: match[4],
      channelId: match[5],
    };

    // Parse optional answer field
    if (match[6]) {
      state.answer = match[6];
    }

    return state;
  } catch {
    return null;
  }
}

// Helper: Format round state to bot message text (encoded)
function formatRoundState(state: RoundState): string {
  return encodeRoundState(state);
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

      if (isFromThisBot && message.text) {
        // Try to parse as round state (handles both encoded and legacy formats)
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
      const newScore = (data.scoresByYear[year][userId] || 0) + points;
      
      // Validate: scores cannot be negative
      if (newScore < 0) {
        throw new Error(`Cannot set score to negative value. Result would be ${newScore}.`);
      }
      
      data.scoresByYear[year][userId] = newScore;
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

// Helper: Update root message button to show "View answer" after puzzle is solved
async function updateRootMessageButton(client: any, channelId: string, threadTs: string, answer: string) {
  try {
    // Get the root message
    const rootMessage = await client.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    if (!rootMessage.messages || rootMessage.messages.length === 0) {
      return;
    }

    const rootMsg = rootMessage.messages[0];
    const rootText = rootMsg.text || '';

    // Get round info to find OP
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    const op = roundInfo?.state.op;

    // Update the message with "View answer" button
    await client.chat.update({
      channel: channelId,
      ts: threadTs,
      text: rootText,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: rootText,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View answer' },
              action_id: 'view_answer',
              value: JSON.stringify({
                channelId: channelId,
                encodedThreadTs: encodeThreadTs(threadTs),
              }),
            },
          ],
        },
      ],
    });
  } catch (error) {
    console.error('Error updating root message button:', error);
  }
}

// Helper: Find the instruction message and extract solver ID if solved
async function findInstructionMessage(
  client: any,
  channelId: string,
  threadTs: string
): Promise<{ ts: string; text: string; solverId?: string } | null> {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
    });

    if (!result.messages) return null;

    // Find the instruction message (starts with "Round")
    const { botUserId, botId } = await ensureBotIdentity();
    for (const message of result.messages) {
      const msgAny = message as any;
      const isFromThisBot =
        (message.user && message.user === botUserId) ||
        (botId && msgAny.bot_id && msgAny.bot_id === botId);

      if (isFromThisBot && message.text && message.text.startsWith('Round')) {
        // Extract solver ID if present (format: "Round SOLVED - OP: <@OP_ID> - Solved by: <@SOLVER_ID>")
        const solverMatch = message.text.match(/Solved by: <@(\w+)>/);
        const solverId = solverMatch ? solverMatch[1] : undefined;
        
        return {
          ts: message.ts!,
          text: message.text,
          solverId,
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding instruction message:', error);
    return null;
  }
}

// Helper: Find and update the instruction message in a thread
async function findAndUpdateInstructionMessage(
  client: any,
  channelId: string,
  threadTs: string,
  state: RoundState,
  solverId?: string
): Promise<void> {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
    });

    if (!result.messages) return;

    // Find the instruction message (starts with "Round")
    const { botUserId, botId } = await ensureBotIdentity();
    for (const message of result.messages) {
      const msgAny = message as any;
      const isFromThisBot =
        (message.user && message.user === botUserId) ||
        (botId && msgAny.bot_id && msgAny.bot_id === botId);

      if (isFromThisBot && message.text && message.text.startsWith('Round')) {
        // Found the instruction message, update it
        let statusText: string;
        let instructionText: string;

        if (state.status === RoundStatus.SOLVED) {
          statusText = 'SOLVED';
          const solverMention = solverId ? ` - Solved by: <@${solverId}>` : '';
          instructionText = `Round *${statusText}* - OP: <@${state.op}>${solverMention}`;
        } else if (state.status === RoundStatus.CLOSED) {
          statusText = 'CLOSED';
          instructionText = `Round *${statusText}* - OP: <@${state.op}>`;
        } else {
          statusText = 'OPEN';
          instructionText =
            `Round *${statusText}* - OP: <@${state.op}>\n` +
            `Reply in this thread with guesses. Or privately using the button above.\n` +
            `OP reacts with :yes: on the correct guess to solve (you'll be asked to confirm).`;
        }

        await client.chat.update({
          channel: channelId,
          ts: message.ts!,
          text: instructionText,
        });
        return;
      }
    }
  } catch (error) {
    console.error('Error finding/updating instruction message:', error);
  }
}

// Helper: Update root message to show closed state
async function updateRootMessageClosed(client: any, channelId: string, threadTs: string, op: string) {
  try {
    // Get the root message
    const rootMessage = await client.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    if (!rootMessage.messages || rootMessage.messages.length === 0) {
      return;
    }

    const rootMsg = rootMessage.messages[0];
    const rootText = rootMsg.text || '';

    // Update the message to show closed state (no buttons)
    await client.chat.update({
      channel: channelId,
      ts: threadTs,
      text: rootText + '\n\n_🔒 Round closed by OP_',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: rootText + '\n\n_🔒 Round closed by OP_',
          },
        },
      ],
    });
  } catch (error) {
    console.error('Error updating root message to closed state:', error);
  }
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

  const strippedQuestionText = questionText.replace(regex, '').trim() || questionText;

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `Has <@${submitterId}> solved your question:\n\n` +
          `> "${strippedQuestionText}"\n\n` +
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
\`/logic setscore @user <points> [year]\` - Set a user's score (year defaults to current year)
\`/logic addpoint @user [year]\` - Add 1 point to a user (year defaults to current year)
\`/logic removepoint @user [year]\` - Remove 1 point from a user (year defaults to current year)`;
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
      // Accept user in format: <@U123>, @U123, @username, or username
      const mentionMatch = rawText.match(/stats\s+(\S+)/i);
      if (mentionMatch) {
        try {
          const resolvedUserId = await resolveUserIdFromToken(client, mentionMatch[1]);
          if (resolvedUserId) {
            targetUserId = resolvedUserId;
          } else {
            await respond({
              response_type: 'ephemeral',
              text: 'User not found.',
            });
            return;
          }
        } catch (error) {
          console.error('Error resolving user ID:', error);
          await respond({
            response_type: 'ephemeral',
            text: 'Error resolving user ID.',
          });
          return;
        }
      }

      const data = await getScoreboardData(channel_id);
      
      // Calculate scores by year and total
      let totalScore = 0;
      const scoresByYear: Array<{ year: string; score: number }> = [];
      
      if (data.scoresByYear) {
        // Get all years and sort them (newest first)
        const years = Object.keys(data.scoresByYear).sort((a, b) => parseInt(b) - parseInt(a));
        
        for (const year of years) {
          const yearScore = data.scoresByYear[year][targetUserId] || 0;
          if (yearScore > 0) {
            scoresByYear.push({ year, score: yearScore });
            totalScore += yearScore;
          }
        }
      }

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      // Build stats text
      let statsText = `*Stats for ${displayName}:*\n\n`;
      
      if (scoresByYear.length === 0) {
        statsText += 'No points yet.';
      } else {
        // Show scores by year
        for (const { year, score } of scoresByYear) {
          statsText += `${year}: ${score} point${score !== 1 ? 's' : ''}\n`;
        }
        statsText += `\n*Total: ${totalScore} point${totalScore !== 1 ? 's' : ''}*`;
      }

      await respond({
        response_type: 'ephemeral',
        text: statsText,
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
    // Accept optional year: setscore @user <points> [year]
    const match = rawText.match(/setscore\s+(\S+)\s+(\d+)(?:\s+(\d{4}))?/i);
    if (!match) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /logic setscore @user <points> [year]',
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
    // Parse optional year, default to current year if not provided
    const year = match[3] || new Date().getFullYear().toString();

    // Validate: scores cannot be negative
    if (points < 0) {
      await respond({
        response_type: 'ephemeral',
        text: 'Error: Scores cannot be negative. Please use a value of 0 or greater.',
      });
      return;
    }

    try {
      await updateScoreboard(channel_id, (data) => {
        // Initialize scoresByYear if it doesn't exist
        if (!data.scoresByYear) {
          data.scoresByYear = {};
        }
        if (!data.scoresByYear[year]) {
          data.scoresByYear[year] = {};
        }

        // Set year-based score
        data.scoresByYear[year][targetUserId] = points;

        return data;
      });

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `Set ${displayName}'s score to ${points} points${year !== new Date().getFullYear().toString() ? ` for year ${year}` : ''}.`,
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

    // Accept optional year: addpoint @user [year]
    const match = rawText.match(/addpoint\s+(\S+)(?:\s+(\d{4}))?/i);
    if (!match) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /logic addpoint @user [year]',
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

    // Parse optional year, default to current year if not provided
    const year = match[2] || new Date().getFullYear().toString();

    try {
      await addPoints(channel_id, targetUserId, 1, year);

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `Added 1 point to ${displayName}${year !== new Date().getFullYear().toString() ? ` for year ${year}` : ''}.`,
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

    // Accept optional year: removepoint @user [year]
    const match = rawText.match(/removepoint\s+(\S+)(?:\s+(\d{4}))?/i);
    if (!match) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /logic removepoint @user [year]',
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

    // Parse optional year, default to current year if not provided
    const year = match[2] || new Date().getFullYear().toString();

    // Check if removing a point would result in negative score
    try {
      const currentData = await getScoreboardData(channel_id);
      const currentScore = currentData.scoresByYear[year]?.[targetUserId] || 0;
      
      if (currentScore - 1 < 0) {
        const userInfo = await client.users.info({ user: targetUserId });
        const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;
        await respond({
          response_type: 'ephemeral',
          text: `Error: Cannot remove point. ${displayName} has ${currentScore} point${currentScore !== 1 ? 's' : ''}${year !== new Date().getFullYear().toString() ? ` for year ${year}` : ''}. Scores cannot be negative.`,
        });
        return;
      }

      await addPoints(channel_id, targetUserId, -1, year);

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      await respond({
        response_type: 'ephemeral',
        text: `Removed 1 point from ${displayName}${year !== new Date().getFullYear().toString() ? ` for year ${year}` : ''}.`,
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
              text: { type: 'plain_text', text: 'Answer privately' },
              action_id: 'submit_private_answer',
              value: JSON.stringify({
                channelId: channel_id,
                threadTs: '', // Will be set after post
              }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Close round' },
              action_id: 'close_round',
              style: 'danger',
              value: JSON.stringify({
                channelId: channel_id,
                threadTs: '', // Will be set after post
                op: user_id,
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
              text: { type: 'plain_text', text: 'Answer privately' },
              action_id: 'submit_private_answer',
              value: JSON.stringify({
                channelId: channel_id,
                encodedThreadTs: encodeThreadTs(threadTs),
              }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Close round' },
              action_id: 'close_round',
              style: 'danger',
              value: JSON.stringify({
                channelId: channel_id,
                encodedThreadTs: encodeThreadTs(threadTs),
                op: user_id,
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
      status: RoundStatus.OPEN,
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

    // Check if already solved or closed
    if (state.status === RoundStatus.SOLVED || state.status === RoundStatus.CLOSED) {
      console.log('Round is already solved or closed');
      return;
    } else {
      console.log('Round is not solved or closed');
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
    if (!roundInfo || roundInfo.state.status === RoundStatus.SOLVED || roundInfo.state.status === RoundStatus.CLOSED) {
      const statusText = roundInfo?.state.status === RoundStatus.CLOSED ? 'closed' : 'solved';
      await updateDmMessageStatus(
        client,
        dmChannelId,
        dmMessageTs,
        `This round was already ${statusText} (no changes made).`,
        'CANCELLED'
      );
      return;
    }

    // Update round state to SOLVED with answer
    const updatedState: RoundState = {
      ...roundInfo.state,
      status: RoundStatus.SOLVED,
      answer: data.answerText,
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

    // Update root message button to show "View answer" instead of "Answer privately"
    if (updatedState.answer) {
      await updateRootMessageButton(client, channelId, threadTs, updatedState.answer);
    }

    // Update instruction message with SOLVED status and solver name
    await findAndUpdateInstructionMessage(client, channelId, threadTs, updatedState, guessAuthorId);

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
    const { channelId, encodedThreadTs } = buttonData;

    if (!encodedThreadTs) {
      console.error('Missing encodedThreadTs in button data');
      return;
    }

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
          encodedThreadTs: encodedThreadTs,
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
    const { channelId, encodedThreadTs, submitterId } = metadata;
    const threadTs = decodeThreadTs(encodedThreadTs);

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

    // Check if already solved or closed
    if (state.status === RoundStatus.SOLVED || state.status === RoundStatus.CLOSED) {
      const submitterDm = await openDmChannel(client, submitterId);
      const statusText = state.status === RoundStatus.SOLVED ? 'solved' : 'closed';
      await client.chat.postMessage({
        channel: submitterDm,
        text: `❌ This puzzle has already been ${statusText}.`,
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
    if (!roundInfo || roundInfo.state.status === RoundStatus.SOLVED || roundInfo.state.status === RoundStatus.CLOSED) {
      const statusText = roundInfo?.state.status === RoundStatus.CLOSED ? 'closed' : 'solved';
      await updateDmMessageStatus(
        client,
        dmChannelId,
        dmMessageTs,
        `This round was already ${statusText} (no changes made).`,
        'CANCELLED'
      );
      return;
    }

    // Update round state to SOLVED with answer
    const updatedState: RoundState = {
      ...roundInfo.state,
      status: RoundStatus.SOLVED,
      answer: data.answerText,
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
      text: '✅ Solved via private answer. Point goes to <@' + submitterId + '>',
    });

    // Update root message button to show "View answer" instead of "Answer privately"
    if (updatedState.answer) {
      await updateRootMessageButton(client, channelId, threadTs, updatedState.answer);
    }

    // Update instruction message with SOLVED status and solver name
    await findAndUpdateInstructionMessage(client, channelId, threadTs, updatedState, submitterId);

    // Update the OP DM message in place
    await updateDmMessageStatus(
      client,
      dmChannelId,
      dmMessageTs,
      'Confirmed — round solved and 1 point awarded to <@' + submitterId + '>.',
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

// Close round: Button handler (OP only)
app.action('close_round', async ({ action, ack, body, client }) => {
  await ack();

  if (action.type !== 'button') return;

  const userId = (body as any).user.id;

  try {
    const buttonData = JSON.parse((action as any).value);
    const { channelId, encodedThreadTs, op: expectedOp } = buttonData;
    
    if (!encodedThreadTs) {
      console.error('Missing encodedThreadTs in button data');
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Error: Missing thread information.',
      });
      return;
    }
    
    const threadTs = decodeThreadTs(encodedThreadTs);

    // Check if user is the OP
    if (userId !== expectedOp) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Only the OP can close this round.',
      });
      return;
    }

    // Find the round
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Round not found.',
      });
      return;
    }

    // Check if already closed or solved
    if (roundInfo.state.status === RoundStatus.CLOSED) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'This round is already closed.',
      });
      return;
    }

    if (roundInfo.state.status === RoundStatus.SOLVED) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'Cannot close a solved round.',
      });
      return;
    }

    // Update round state to CLOSED
    const updatedState: RoundState = {
      ...roundInfo.state,
      status: RoundStatus.CLOSED,
    };

    await client.chat.update({
      channel: channelId,
      ts: roundInfo.ts,
      text: formatRoundState(updatedState),
    });

    // Update root message to show closed state
    await updateRootMessageClosed(client, channelId, threadTs, userId);

    // Update instruction message with CLOSED status
    await findAndUpdateInstructionMessage(client, channelId, threadTs, updatedState);

    // Post message in thread
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '🔒 Round closed by OP.',
    });

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Round closed.',
    });
  } catch (error) {
    console.error('Error closing round:', error);
    try {
      const buttonData = JSON.parse((action as any).value);
      const channelId = buttonData?.channelId || (body as any).channel?.id;
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Error closing round.',
        });
      }
    } catch (err) {
      // If we can't even send an error message, just log it
      console.error('Failed to send error message:', err);
    }
  }
});

// View answer: Button handler to show answer in modal
app.action('view_answer', async ({ action, ack, body, client }) => {
  await ack();

  if (action.type !== 'button') return;

  try {
    const buttonData = JSON.parse((action as any).value);
    const { channelId, encodedThreadTs } = buttonData;
    const threadTs = decodeThreadTs(encodedThreadTs);

    // Find the round to get the answer
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo || !roundInfo.state.answer) {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: {
            type: 'plain_text',
            text: 'View answer',
          },
          close: {
            type: 'plain_text',
            text: 'Close',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Answer not found. This puzzle may not have been solved yet.',
              },
            },
          ],
        },
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
    let questionText = questionTextRaw.replace(/^🧠 <@\w+> asks:\n_?\*?/, '').replace(/_?\*?$/, '').trim() || questionTextRaw;

    // Find the solver from the instruction message
    const instructionMsg = await findInstructionMessage(client, channelId, threadTs);
    // const solverMention = instructionMsg?.solverId ? `Solved by: <@${instructionMsg.solverId}>\n\n` : '';

    // Open modal with answer
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: 'View answer',
        },
        close: {
          type: 'plain_text',
          text: 'Close',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Question (<@${roundInfo.state.op}>):*\n${questionText}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Answer (<@${instructionMsg?.solverId}>):*\n${roundInfo.state.answer}`,
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('Error viewing answer:', error);
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
    if (!roundInfo || roundInfo.state.status !== RoundStatus.SOLVED) {
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