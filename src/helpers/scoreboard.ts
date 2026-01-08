// Scoreboard-related helper functions

import { app } from '../config';
import { ScoreboardData } from '../types';
import { ensureBotIdentity } from './slack';

// Get or create scoreboard message
export async function getOrCreateScoreboard(channelId: string): Promise<string> {
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
      questionsByYear: {},
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

// Get scoreboard data
export async function getScoreboardData(channelId: string): Promise<ScoreboardData> {
  try {
    const scoreboardTs = await getOrCreateScoreboard(channelId);
    const result = await app.client.conversations.history({
      channel: channelId,
      latest: scoreboardTs,
      limit: 1,
      inclusive: true,
    });

    if (!result.messages || result.messages.length === 0) {
      return { scoresByYear: {}, questionsByYear: {}, lastUpdated: new Date().toISOString() };
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
      return JSON.parse(text);
    } catch {
      return { scoresByYear: {}, questionsByYear: {}, lastUpdated: new Date().toISOString() };
    }
  } catch (error) {
    console.error('Error getting scoreboard data:', error);
    return { scoresByYear: {}, questionsByYear: {}, lastUpdated: new Date().toISOString() };
  }
}

// Update scoreboard
export async function updateScoreboard(
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
