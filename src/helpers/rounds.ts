// Round-related helper functions

import { app, QUESTION_REGEX } from '../config';
import { RoundStatus, RoundState } from '../types';
import { ensureBotIdentity } from './slack';

// Encode threadTs to make it non-human-readable
export function encodeThreadTs(threadTs: string): string {
  return Buffer.from(threadTs).toString('base64');
}

// Decode threadTs
export function decodeThreadTs(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}

// Encode round state to make it non-human-readable
export function encodeRoundState(state: RoundState): string {
  const json = JSON.stringify(state);
  return Buffer.from(json).toString('base64');
}

// Decode round state
export function decodeRoundState(encoded: string): RoundState | null {
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(json) as RoundState;
  } catch {
    return null;
  }
}

// Parse round state from bot message text
export function parseRoundState(text: string): RoundState | null {
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

// Format round state to bot message text (encoded)
export function formatRoundState(state: RoundState): string {
  return encodeRoundState(state);
}

// Find round control message in a thread
export async function findRoundControlMessage(
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

// Get question text from round state or parse from thread root (fallback)
export async function getQuestionText(
  client: any,
  channelId: string,
  threadTs: string,
  roundState?: RoundState
): Promise<string> {
  // If question is stored in state, use it
  if (roundState?.question) {
    return roundState.question;
  }

  // Fallback: parse from thread root message
  try {
    const threadRoot = await client.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    const rootMsg = threadRoot.messages?.[0];
    const questionTextRaw = (rootMsg?.text || '(unknown question)').trim();
    
    // Try multiple parsing patterns for backwards compatibility
    let questionText = questionTextRaw.replace(QUESTION_REGEX, '').trim() || questionTextRaw;
    questionText = questionText.replace(/^🧠 <@\w+> asks:\n_?\*?/, '').replace(/_?\*?$/, '').trim() || questionText;
    
    return questionText;
  } catch (error) {
    console.error('Error parsing question text:', error);
    return '(unknown question)';
  }
}

// Get root message text
export async function getRootMessageText(client: any, channelId: string, threadTs: string): Promise<string | null> {
  try {
    const rootMessage = await client.conversations.history({
      channel: channelId,
      latest: threadTs,
      inclusive: true,
      limit: 1,
    });

    if (!rootMessage.messages || rootMessage.messages.length === 0) {
      return null;
    }

    return rootMessage.messages[0].text || null;
  } catch (error) {
    console.error('Error getting root message text:', error);
    return null;
  }
}

// Find the instruction message and extract solver ID if solved
export async function findInstructionMessage(
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

// Find and update the instruction message in a thread
export async function findAndUpdateInstructionMessage(
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

// Update root message button to show "View answer" after puzzle is solved
export async function updateRootMessageButton(client: any, channelId: string, threadTs: string, answer: string) {
  try {
    const rootText = await getRootMessageText(client, channelId, threadTs);
    if (!rootText) {
      return;
    }

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

// Update root message to show closed state
export async function updateRootMessageClosed(client: any, channelId: string, threadTs: string, op: string) {
  try {
    const rootText = await getRootMessageText(client, channelId, threadTs);
    if (!rootText) {
      return;
    }

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
