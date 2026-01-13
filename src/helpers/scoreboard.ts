// Scoreboard-related helper functions

import { app } from '../config';
import { ScoreboardData } from '../types';
import { ensureBotIdentity } from './slack';

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

    blocks.push({
      type: 'divider',
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

      // Find existing scoreboard
      for (const item of pins.items) {
        // Check if item is a message type and has message property
        if ('message' in item && item.message) {
          const message = item.message as any;
          if (message.user === botUserId) {
            const text = message.text || '';
            const blocks = message.blocks || [];
            // Check if it's our scoreboard (has "Scoreboard" header or contains scoreboard blocks)
            if (
              text.includes('Scoreboard') ||
              (blocks.length > 0 && blocks[0]?.text?.text?.includes('Scoreboard'))
            ) {
              scoreboardMessageCache[channelId] = message.ts!;
              return message.ts!;
            }
          }
        }
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

// Get scoreboard data (now stored separately, not in message)
// We'll use a hidden message or store in a separate location
// For now, we'll parse from a pinned message that stores JSON
export async function getScoreboardData(channelId: string): Promise<ScoreboardData> {
  try {
    // Try to get from pinned messages (look for JSON data message)
    const pins = await app.client.pins.list({ channel: channelId });
    const { botUserId } = await ensureBotIdentity();

    if (pins.items) {
      for (const item of pins.items) {
        if ('message' in item && item.message) {
          const message = item.message as any;
          if (message.user === botUserId) {
            const text = message.text || '';
            // Look for JSON data in code block
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

// Store scoreboard data in a hidden pinned message
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
            if (text.includes('"scores"') && text.includes('"questions"')) {
              dataMessageTs = message.ts!;
              break;
            }
          }
        }
      }
    }

    const dataText = `Scoreboard Data\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

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
