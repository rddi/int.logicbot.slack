// Scoreboard-related helper functions

import * as crypto from 'crypto';
import { app } from '../config';
import { ScoreboardData } from '../types';
import { ensureBotIdentity } from './slack';

// Encryption key for scoreboard data (use env var or default)
const ENCRYPTION_KEY = process.env.SCOREBOARD_ENCRYPTION_KEY || 'logicbot-scoreboard-key-default-change-in-production';
const ALGORITHM = 'aes-256-cbc';

// Encrypt JSON data
function encryptData(data: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.padEnd(32).substring(0, 32)), iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Decrypt JSON data
function decryptData(encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.padEnd(32).substring(0, 32)), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Cache for scoreboard message TS per channel
const scoreboardMessageCache: Record<string, string> = {};

const padCenter = (text: string, width: number, forceTextLength: null | number = null) => {
  let textLength = text.length;
  if (forceTextLength) {
    textLength = forceTextLength;
  }
  const spaces = width - textLength;
  const leftSpaces = Math.floor(spaces / 2);
  const rightSpaces = spaces - leftSpaces;
  return ' '.repeat(leftSpaces) + text + ' '.repeat(rightSpaces);
};

// Format scoreboard data into display blocks
async function formatScoreboardBlocks(data: ScoreboardData, channelId: string): Promise<any[]> {
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🏆 Scoreboard',
        emoji: true,
      },
    },
    {
      type: 'divider',
    },
  ];

  // Get all years from both scores and questions, sort them (newest first)
  const allYears = new Set([
    ...Object.keys(data.scoresByYear || {}),
    ...Object.keys(data.questionsByYear || {}),
  ]);
  const years = Array.from(allYears).sort((a, b) => parseInt(b) - parseInt(a));

  if (years.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_No scores yet._',
      },
    });
    return blocks;
  }

  // Display scores and questions by year
  for (const year of years) {
    const yearScores = data.scoresByYear?.[year] || {};
    const yearQuestions = data.questionsByYear?.[year] || {};

    // Get all users who have scores or questions in this year
    const allUsers = new Set([
      ...Object.keys(yearScores),
      ...Object.keys(yearQuestions),
    ]);

    if (allUsers.size === 0) continue;

    // Add year header
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${year}*`,
      },
    });

    // Combine scores and questions, then get user info
    const entryPromises = Array.from(allUsers).map(async (userId) => {
      try {
        const userInfo = await app.client.users.info({ user: userId });
        const displayName = userInfo.user?.real_name || userInfo.user?.name || userId;
        return {
          userId,
          displayName,
          score: yearScores[userId] || 0,
          questions: yearQuestions[userId] || 0,
        };
      } catch {
        return {
          userId,
          displayName: `<@${userId}>`,
          score: yearScores[userId] || 0,
          questions: yearQuestions[userId] || 0,
        };
      }
    });

    // Resolve all user info promises
    const resolvedEntries = await Promise.all(entryPromises);

    // Sort by score (descending)
    resolvedEntries.sort((a, b) => b.score - a.score);

    // Build table for this year using code block for monospace formatting
    // Calculate column widths
    const maxNameLength = Math.max(
      'Player'.length,
      ...resolvedEntries.map((e) => e.displayName.length)
    );
    const nameWidth = Math.max(20, Math.min(maxNameLength + 2, 35));
    const scoreWidth = 4;
    const questionsWidth = 4;

    // Build table header
    // Use actual emoji Unicode characters since code blocks don't render emoji codes
    const separator = `┼─${'─'.repeat(nameWidth)}─┼─${'─'.repeat(scoreWidth)}─┼─${'─'.repeat(questionsWidth)}─┼`;
    const headerRow = `│ ${padCenter('Player', nameWidth)} │ ${padCenter('As', scoreWidth)} │ ${padCenter('Qs', questionsWidth)} │`;

    // Build table rows
    const tableRows = resolvedEntries
      .map(({ displayName, score, questions }) => {
        // Truncate display name if too long
        const truncatedName =
          displayName.length > nameWidth - 2
            ? displayName.substring(0, nameWidth - 5) + '...'
            : displayName;
        return `│ ${truncatedName.padEnd(nameWidth)} │ ${score.toString().padStart(scoreWidth)} │ ${questions.toString().padStart(questionsWidth)} │`;
      })
      .join('\n');

    // Combine into table format
    const tableText = `\`\`\`\n${separator}\n${headerRow}\n${separator}\n${tableRows}\n${separator}\n\`\`\``;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: tableText,
      },
    });
  }

  // Add last updated timestamp
  if (data.lastUpdated) {
    const updatedDate = new Date(data.lastUpdated);
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Last updated: ${updatedDate.toLocaleString()}_`,
        },
      ],
    });
  }

  return blocks;
}

// Format scoreboard data as text (for command output)
export async function formatScoreboardText(data: ScoreboardData, channelId: string): Promise<string> {
  // Get all years from both scores and questions, sort them (newest first)
  const allYears = new Set([
    ...Object.keys(data.scoresByYear || {}),
    ...Object.keys(data.questionsByYear || {}),
  ]);
  const years = Array.from(allYears).sort((a, b) => parseInt(b) - parseInt(a));

  if (years.length === 0) {
    return '🏆 *Scoreboard*\n\n_No scores yet._';
  }

  let text = '🏆 *Scoreboard*\n\n';

  // Display scores and questions by year
  for (const year of years) {
    const yearScores = data.scoresByYear?.[year] || {};
    const yearQuestions = data.questionsByYear?.[year] || {};

    // Get all users who have scores or questions in this year
    const allUsers = new Set([
      ...Object.keys(yearScores),
      ...Object.keys(yearQuestions),
    ]);

    if (allUsers.size === 0) continue;

    text += `*${year}*\n`;

    // Combine scores and questions, then get user info
    const entryPromises = Array.from(allUsers).map(async (userId) => {
      try {
        const userInfo = await app.client.users.info({ user: userId });
        const displayName = userInfo.user?.real_name || userInfo.user?.name || userId;
        return {
          userId,
          displayName,
          score: yearScores[userId] || 0,
          questions: yearQuestions[userId] || 0,
        };
      } catch {
        return {
          userId,
          displayName: `<@${userId}>`,
          score: yearScores[userId] || 0,
          questions: yearQuestions[userId] || 0,
        };
      }
    });

    // Resolve all user info promises
    const resolvedEntries = await Promise.all(entryPromises);

    // Sort by score (descending)
    resolvedEntries.sort((a, b) => b.score - a.score);

    // Build table for this year using code block for monospace formatting
    // Calculate column widths
    const maxNameLength = Math.max(
      'Player'.length,
      ...resolvedEntries.map((e) => e.displayName.length)
    );
    const nameWidth = Math.max(20, Math.min(maxNameLength + 2, 35));
    const scoreWidth = 4;
    const questionsWidth = 4;

    // Build table header
    const separator = `┼─${'─'.repeat(nameWidth)}─┼─${'─'.repeat(scoreWidth)}─┼─${'─'.repeat(questionsWidth)}─┼`;
    const headerRow = `│ ${padCenter('Player', nameWidth)} │ ${padCenter('As', scoreWidth)} │ ${padCenter('Qs', questionsWidth)} │`;

    // Build table rows
    const tableRows = resolvedEntries
      .map(({ displayName, score, questions }) => {
        // Truncate display name if too long
        const truncatedName =
          displayName.length > nameWidth - 2
            ? displayName.substring(0, nameWidth - 5) + '...'
            : displayName;
        return `│ ${truncatedName.padEnd(nameWidth)} │ ${score.toString().padStart(scoreWidth)} │ ${questions.toString().padStart(questionsWidth)} │`;
      })
      .join('\n');

    // Combine into table format
    const tableText = `\`\`\`\n${separator}\n${headerRow}\n${separator}\n${tableRows}\n${separator}\n\`\`\``;

    text += tableText + '\n\n';
  }

  // Add last updated timestamp
  if (data.lastUpdated) {
    const updatedDate = new Date(data.lastUpdated);
    text += `_Last updated: ${updatedDate.toLocaleString()}_`;
  }

  return text;
}

// Get or create scoreboard message (now uses formatted blocks)
export async function getOrCreateScoreboard(channelId: string): Promise<string> {
  try {
    // Check cache first
    if (scoreboardMessageCache[channelId]) {
      try {
        // Verify the message still exists
        await app.client.conversations.history({
          channel: channelId,
          latest: scoreboardMessageCache[channelId],
          limit: 1,
          inclusive: true,
        });
        return scoreboardMessageCache[channelId];
      } catch {
        // Message doesn't exist, clear cache and recreate
        delete scoreboardMessageCache[channelId];
      }
    }

    // Get pinned messages
    const pins = await app.client.pins.list({ channel: channelId });

    if (pins.items) {
      const { botUserId } = await ensureBotIdentity();

      // Find existing scoreboard(s) - look for header block with "🏆 Scoreboard"
      const existingScoreboards: Array<{ ts: string; item: any }> = [];
      for (const item of pins.items) {
        // Check if item is a message type and has message property
        if ('message' in item && item.message) {
          const message = item.message as any;
          if (message.user === botUserId) {
            const blocks = message.blocks || [];
            // Check if it's our scoreboard by looking for the header block with "🏆 Scoreboard"
            const hasScoreboardHeader = blocks.some(
              (block: any) =>
                block.type === 'header' &&
                block.text?.text?.includes('Scoreboard')
            );
            if (hasScoreboardHeader) {
              existingScoreboards.push({ ts: message.ts!, item });
            }
          }
        }
      }

      // If we found scoreboards, use the first one and unpin any duplicates
      if (existingScoreboards.length > 0) {
        const primaryScoreboard = existingScoreboards[0];
        
        // Unpin any duplicate scoreboards (keep only the first one)
        for (let i = 1; i < existingScoreboards.length; i++) {
          try {
            await app.client.pins.remove({
              channel: channelId,
              timestamp: existingScoreboards[i].ts,
            });
            console.log(`Unpinned duplicate scoreboard: ${existingScoreboards[i].ts}`);
          } catch (error) {
            console.error(`Error unpinning duplicate scoreboard:`, error);
          }
        }

        scoreboardMessageCache[channelId] = primaryScoreboard.ts;
        return primaryScoreboard.ts;
      }
    }

    // Create new scoreboard with initial data
    const scoreboardData: ScoreboardData = {
      scoresByYear: {},
      questionsByYear: {},
      lastUpdated: new Date().toISOString(),
    };

    const blocks = await formatScoreboardBlocks(scoreboardData, channelId);

    const result = await app.client.chat.postMessage({
      channel: channelId,
      text: 'Scoreboard',
      blocks,
    });

    if (!result.ts) {
      throw new Error('Failed to create scoreboard message (missing ts)');
    }

    // Pin the message
    await app.client.pins.add({
      channel: channelId,
      timestamp: result.ts,
    });

    scoreboardMessageCache[channelId] = result.ts;
    return result.ts;
  } catch (error) {
    console.error('Error getting/creating scoreboard:', error);
    throw error;
  }
}

// Get scoreboard data (now stored separately, encrypted)
export async function getScoreboardData(channelId: string): Promise<ScoreboardData> {
  try {
    // Try to get from pinned messages (look for encrypted data message)
    const pins = await app.client.pins.list({ channel: channelId });
    const { botUserId } = await ensureBotIdentity();

    if (pins.items) {
      for (const item of pins.items) {
        if ('message' in item && item.message) {
          const message = item.message as any;
          if (message.user === botUserId) {
            const text = message.text || '';
            
            // Try to find encrypted data in code block
            const codeBlockMatch = text.match(/```\n([\s\S]*?)\n```/);
            if (codeBlockMatch && codeBlockMatch[1].includes(':')) {
              // Likely encrypted data (format: iv:encrypted)
              try {
                const decrypted = decryptData(codeBlockMatch[1].trim());
                return JSON.parse(decrypted);
              } catch {
                // Not encrypted or decryption failed, try old format
              }
            }
            
            // Fallback: try old JSON format (for backward compatibility)
            const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
              try {
                return JSON.parse(jsonMatch[1]);
              } catch {
                continue;
              }
            }
          }
        }
      }
    }

    // If no data found, return empty scoreboard
    return { scoresByYear: {}, questionsByYear: {}, lastUpdated: new Date().toISOString() };
  } catch (error) {
    console.error('Error getting scoreboard data:', error);
    return { scoresByYear: {}, questionsByYear: {}, lastUpdated: new Date().toISOString() };
  }
}

// Store scoreboard data in a hidden pinned message (encrypted)
async function storeScoreboardData(channelId: string, data: ScoreboardData): Promise<void> {
  try {
    const { botUserId } = await ensureBotIdentity();
    const pins = await app.client.pins.list({ channel: channelId });

    // Look for existing data message
    let dataMessageTs: string | null = null;
    if (pins.items) {
      for (const item of pins.items) {
        if ('message' in item && item.message) {
          const message = item.message as any;
          if (message.user === botUserId) {
            const text = message.text || '';
            // Look for encrypted data marker or old format
            if (text.includes('Scoreboard Data') || (text.includes('"scores"') && text.includes('"questions"'))) {
              dataMessageTs = message.ts!;
              break;
            }
          }
        }
      }
    }

    // Encrypt the JSON data
    const jsonData = JSON.stringify(data);
    const encryptedData = encryptData(jsonData);
    const dataText = `Scoreboard Data\n\`\`\`\n${encryptedData}\n\`\`\``;

    if (dataMessageTs) {
      // Update existing data message
      await app.client.chat.update({
        channel: channelId,
        ts: dataMessageTs,
        text: dataText,
      });
    } else {
      // Create new data message
      const result = await app.client.chat.postMessage({
        channel: channelId,
        text: dataText,
      });

      if (result.ts) {
        // Pin the data message
        await app.client.pins.add({
          channel: channelId,
          timestamp: result.ts,
        });
      }
    }
  } catch (error) {
    console.error('Error storing scoreboard data:', error);
    // Don't throw - data storage is secondary to display
  }
}

// Update scoreboard (updates both display and data storage)
export async function updateScoreboard(
  channelId: string,
  updateFn: (data: ScoreboardData) => ScoreboardData
): Promise<void> {
  try {
    const scoreboardTs = await getOrCreateScoreboard(channelId);
    const currentData = await getScoreboardData(channelId);
    const updatedData = updateFn(currentData);
    updatedData.lastUpdated = new Date().toISOString();

    // Update the display message with formatted blocks
    const blocks = await formatScoreboardBlocks(updatedData, channelId);
    await app.client.chat.update({
      channel: channelId,
      ts: scoreboardTs,
      text: 'Scoreboard',
      blocks,
    });

    // Store the data in a separate hidden message for persistence
    await storeScoreboardData(channelId, updatedData);
  } catch (error) {
    console.error('Error updating scoreboard:', error);
    throw error;
  }
}

// Extract year from Slack timestamp (ts format: "1234567890.123456")
export function getYearFromTimestamp(ts: string): string {
  const timestamp = parseFloat(ts);
  const date = new Date(timestamp * 1000);
  return date.getFullYear().toString();
}

// Add points to a user (with optional year tracking)
export async function addPoints(
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

// Add a question count to a user (with year tracking)
export async function addQuestion(
  channelId: string,
  userId: string,
  year: string
): Promise<void> {
  await updateScoreboard(channelId, (data) => {
    // Initialize questionsByYear if it doesn't exist
    if (!data.questionsByYear) {
      data.questionsByYear = {};
    }

    if (!data.questionsByYear[year]) {
      data.questionsByYear[year] = {};
    }
    
    data.questionsByYear[year][userId] = (data.questionsByYear[year][userId] || 0) + 1;

    return data;
  });
}

// Remove a question count from a user (with year tracking)
export async function removeQuestion(
  channelId: string,
  userId: string,
  year: string
): Promise<void> {
  await updateScoreboard(channelId, (data) => {
    // Initialize questionsByYear if it doesn't exist
    if (!data.questionsByYear) {
      data.questionsByYear = {};
    }

    if (!data.questionsByYear[year]) {
      data.questionsByYear[year] = {};
    }
    
    const currentCount = data.questionsByYear[year][userId] || 0;
    const newCount = Math.max(0, currentCount - 1); // Ensure it doesn't go below 0
    
    if (newCount > 0) {
      data.questionsByYear[year][userId] = newCount;
    } else {
      // Remove the entry if count is 0
      delete data.questionsByYear[year][userId];
    }

    return data;
  });
}
