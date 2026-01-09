// Main entry point - imports helpers and registers handlers

import { app, PORT, QUESTION_REGEX } from './config';
import { RoundStatus, RoundState, ScoreboardData, SolvePromptPayload, PrivateAnswerPayload } from './types';

// Import helpers
import { isAllowedChannel, isAdmin, resolveUserIdFromToken, looksLikeGuess, parseButtonData, validateOpAndRound } from './helpers/validation';
import { 
  encodeThreadTs, 
  decodeThreadTs, 
  formatRoundState, 
  findRoundControlMessage, 
  getQuestionText,
  getRootMessageText,
  findInstructionMessage,
  findAndUpdateInstructionMessage,
  updateRootMessageButton,
  updateRootMessageClosed
} from './helpers/rounds';
import { 
  getOrCreateScoreboard, 
  getScoreboardData, 
  updateScoreboard, 
  getYearFromTimestamp, 
  addPoints,
  addQuestion,
  removeQuestion
} from './helpers/scoreboard';
import { openDmChannel, getPermalink, ensureBotIdentity } from './helpers/slack';
import { buildSolveDmBlocks, updateDmMessageStatus, buildPrivateAnswerDmBlocks, sendWinnerSummary } from './helpers/messages';

// Helper functions are now imported from helpers modules above

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
\`/logic stats @user\` - Show stats for a user

*Including Images:*
If your question includes images, use \`/logic <question>\` first, then post your images directly in the thread that gets created.`;

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

      // Get all years from both scores and questions, sort them (newest first)
      const allYears = new Set([
        ...Object.keys(data.scoresByYear),
        ...Object.keys(data.questionsByYear)
      ]);
      const years = Array.from(allYears).sort((a, b) => parseInt(b) - parseInt(a));

      let scoreboardText = '*Scoreboard*\n\n';

      if (years.length === 0) {
        scoreboardText += 'No scores yet.';
      } else {
        // Display scores and questions by year
        for (const year of years) {
          const yearScores = data.scoresByYear[year] || {};
          const yearQuestions = data.questionsByYear[year] || {};
          
          // Get all users who have scores or questions in this year
          const allUsers = new Set([
            ...Object.keys(yearScores),
            ...Object.keys(yearQuestions)
          ]);

          if (allUsers.size === 0) continue;

          scoreboardText += `*${year}*\n`;
          
          // Combine scores and questions, then sort by score (descending)
          const entries = Array.from(allUsers).map(userId => ({
            userId,
            score: yearScores[userId] || 0,
            questions: yearQuestions[userId] || 0
          })).sort((a, b) => b.score - a.score);

          for (const { userId, score, questions } of entries) {
            try {
              const userInfo = await client.users.info({ user: userId });
              const displayName = userInfo.user?.real_name || userInfo.user?.name || userId;
              const questionText = questions > 0 ? ` (${questions} question${questions !== 1 ? 's' : ''})` : '';
              scoreboardText += `  ${displayName}: ${score} point${score !== 1 ? 's' : ''}${questionText}\n`;
            } catch {
              const questionText = questions > 0 ? ` (${questions} question${questions !== 1 ? 's' : ''})` : '';
              scoreboardText += `  <@${userId}>: ${score} point${score !== 1 ? 's' : ''}${questionText}\n`;
            }
          }
          scoreboardText += '\n';
        }
      }

      await client.chat.postMessage({
        channel: channel_id,
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
      
      // Calculate scores and questions by year and totals
      let totalScore = 0;
      let totalQuestions = 0;
      const statsByYear: Array<{ year: string; score: number; questions: number }> = [];
      
      // Get all years from both scores and questions
      const allYears = new Set([
        ...(data.scoresByYear ? Object.keys(data.scoresByYear) : []),
        ...(data.questionsByYear ? Object.keys(data.questionsByYear) : [])
      ]);
      const years = Array.from(allYears).sort((a, b) => parseInt(b) - parseInt(a));
      
      for (const year of years) {
        const yearScore = (data.scoresByYear?.[year]?.[targetUserId] || 0);
        const yearQuestions = (data.questionsByYear?.[year]?.[targetUserId] || 0);
        
        if (yearScore > 0 || yearQuestions > 0) {
          statsByYear.push({ year, score: yearScore, questions: yearQuestions });
          totalScore += yearScore;
          totalQuestions += yearQuestions;
        }
      }

      const userInfo = await client.users.info({ user: targetUserId });
      const displayName = userInfo.user?.real_name || userInfo.user?.name || targetUserId;

      // Build stats text
      let statsText = `*Stats for ${displayName}:*\n\n`;
      
      if (statsByYear.length === 0) {
        statsText += 'No points or questions yet.';
      } else {
        // Show scores and questions by year
        for (const { year, score, questions } of statsByYear) {
          const parts: string[] = [];
          if (score > 0) {
            parts.push(`${score} point${score !== 1 ? 's' : ''}`);
          }
          if (questions > 0) {
            parts.push(`${questions} question${questions !== 1 ? 's' : ''}`);
          }
          statsText += `${year}: ${parts.join(', ')}\n`;
        }
        
        const totalParts: string[] = [];
        if (totalScore > 0) {
          totalParts.push(`${totalScore} point${totalScore !== 1 ? 's' : ''}`);
        }
        if (totalQuestions > 0) {
          totalParts.push(`${totalQuestions} question${totalQuestions !== 1 ? 's' : ''}`);
        }
        statsText += `\n*Total: ${totalParts.join(', ')}*`;
      }

      await client.chat.postMessage({
        channel: channel_id,
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
    // Build blocks for the question message
    const questionBlocks: any[] = [
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
    ];

    // 1) Post the riddle to the channel as a normal message with a button for private answers
    const riddlePost = await client.chat.postMessage({
      channel: channel_id,
      text: `🧠 <@${user_id}> asks:\n_*${rawText}*_`,
      blocks: questionBlocks,
    });

    if (!riddlePost.ts) {
      throw new Error('Failed to create puzzle post (missing ts).');
    }

    const threadTs = riddlePost.ts;

    // Build updated blocks with all buttons
    const updatedQuestionBlocks: any[] = [
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
            text: { type: 'plain_text', text: 'Edit question' },
            action_id: 'edit_question',
            value: JSON.stringify({
              channelId: channel_id,
              encodedThreadTs: encodeThreadTs(threadTs),
              op: user_id,
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
    ];

    // Update the button value with the actual threadTs
    await client.chat.update({
      channel: channel_id,
      ts: riddlePost.ts,
      text: `🧠 <@${user_id}> asks:\n_*${rawText}*_`,
      blocks: updatedQuestionBlocks,
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
      question: rawText, // Store plain question text
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
        `Round *OPEN* - OP: <@${user_id}>\n` +
        `Reply in this thread with guesses. Or privately using the button above.\n` +
        `OP reacts with :yes: on the correct guess to solve (you'll be asked to confirm).\n\n` +
        `💡 _Tip: If your question includes images, you can post them directly in this thread._`,
    });

    // Track question count for the OP
    const year = getYearFromTimestamp(threadTs);
    await addQuestion(channel_id, user_id, year);

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

    // Don't allow solving bot messages
    const { botUserId } = await ensureBotIdentity();
    if (guessAuthorId === botUserId) {
      console.log('Reacted message is from the bot, ignoring');
      return;
    }

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

    // Get question text from round state (or parse as fallback)
    const questionText = await getQuestionText(client, channelId, threadTs, state);

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

    // Send summary DM to the winner
    const questionText = await getQuestionText(client, channelId, threadTs, updatedState);
    const permalink = await getPermalink(client, channelId, threadTs);
    await sendWinnerSummary(client, guessAuthorId, questionText, data.answerText, permalink, updatedState.op);
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

    // Get question text from round state (or parse as fallback)
    const questionText = await getQuestionText(client, channelId, threadTs, state);

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

    // Send summary DM to the winner
    const questionText = await getQuestionText(client, channelId, threadTs, updatedState);
    const permalink = await getPermalink(client, channelId, threadTs);
    await sendWinnerSummary(client, submitterId, questionText, data.answerText, permalink, updatedState.op);
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

// Edit question: Button handler (OP only)
app.action('edit_question', async ({ action, ack, body, client }) => {
  await ack();

  if (action.type !== 'button') return;

  const userId = (body as any).user.id;

  try {
    const buttonData = parseButtonData(action);
    if (!buttonData || !buttonData.encodedThreadTs) {
      console.error('Missing encodedThreadTs in button data');
      const channelId = buttonData?.channelId || (body as any).channel?.id;
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Error: Missing thread information.',
        });
      }
      return;
    }
    
    const { channelId, encodedThreadTs, op: expectedOp } = buttonData;
    const threadTs = decodeThreadTs(encodedThreadTs);

    // Validate OP and round status
    const validation = await validateOpAndRound(client, userId, channelId, threadTs, expectedOp!, 'edit');
    if (validation.error) {
      return; // Error already sent via validateOpAndRound
    }

    const roundInfo = validation.roundInfo!;

    // Get current question text
    const currentQuestion = await getQuestionText(client, channelId, threadTs, roundInfo.state);

    // Open modal for editing question
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'edit_question_modal',
        title: {
          type: 'plain_text',
          text: 'Edit question',
        },
        submit: {
          type: 'plain_text',
          text: 'Update',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        private_metadata: JSON.stringify({
          channelId,
          encodedThreadTs,
          op: userId,
        }),
        blocks: [
          {
            type: 'input',
            block_id: 'question_input',
            element: {
              type: 'plain_text_input',
              action_id: 'question',
              multiline: true,
              initial_value: currentQuestion,
              placeholder: {
                type: 'plain_text',
                text: 'Enter the question...',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Question',
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('Error opening edit question modal:', error);
    try {
      const buttonData = JSON.parse((action as any).value);
      const channelId = buttonData?.channelId || (body as any).channel?.id;
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Error opening edit question modal.',
        });
      }
    } catch (err) {
      console.error('Failed to send error message:', err);
    }
  }
});

// Edit question: Modal submit handler
app.view('edit_question_modal', async ({ ack, view, client, body }) => {
  await ack();

  try {
    const metadata = JSON.parse(view.private_metadata);
    const { channelId, encodedThreadTs, op } = metadata;
    const threadTs = decodeThreadTs(encodedThreadTs);
    const userId = (body as any).user.id;

    // Verify user is the OP
    if (userId !== op) {
      await client.views.update({
        view_id: view.id,
        view: {
          type: 'modal',
          title: {
            type: 'plain_text',
            text: 'Error',
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
                text: '❌ Only the OP can edit the question.',
              },
            },
          ],
        },
      });
      return;
    }

    // Get the new question from the modal
    const questionBlock = view.state.values.question_input;
    const newQuestion = (questionBlock?.question?.value || '').trim();

    if (!newQuestion) {
      // Question is empty, show error
      await client.views.update({
        view_id: view.id,
        view: {
          type: 'modal',
          callback_id: 'edit_question_modal',
          title: {
            type: 'plain_text',
            text: 'Edit question',
          },
          submit: {
            type: 'plain_text',
            text: 'Update',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          private_metadata: view.private_metadata,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '❌ Question cannot be empty.',
              },
            },
            {
              type: 'input',
              block_id: 'question_input',
              element: {
                type: 'plain_text_input',
                action_id: 'question',
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text: 'Enter the question...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Question',
              },
            },
          ],
        },
      });
      return;
    }

    // Find the round
    const roundInfo = await findRoundControlMessage(channelId, threadTs);
    if (!roundInfo) {
      await client.views.update({
        view_id: view.id,
        view: {
          type: 'modal',
          title: {
            type: 'plain_text',
            text: 'Error',
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
                text: '❌ Round not found.',
              },
            },
          ],
        },
      });
      return;
    }

    // Check if already closed or solved
    if (roundInfo.state.status === RoundStatus.CLOSED || roundInfo.state.status === RoundStatus.SOLVED) {
      const statusText = roundInfo.state.status === RoundStatus.CLOSED ? 'closed' : 'solved';
      await client.views.update({
        view_id: view.id,
        view: {
          type: 'modal',
          title: {
            type: 'plain_text',
            text: 'Error',
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
                text: `❌ Cannot edit a ${statusText} round.`,
              },
            },
          ],
        },
      });
      return;
    }

    // Update round state with new question
    const updatedState: RoundState = {
      ...roundInfo.state,
      question: newQuestion,
    };

    await client.chat.update({
      channel: channelId,
      ts: roundInfo.ts,
      text: formatRoundState(updatedState),
    });

    // Build updated blocks: text section, then buttons
    const updatedBlocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🧠 <@${op}> asks:\n_*${newQuestion}*_`,
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
              channelId: channelId,
              encodedThreadTs: encodeThreadTs(threadTs),
            }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Edit question' },
            action_id: 'edit_question',
            value: JSON.stringify({
              channelId: channelId,
              encodedThreadTs: encodeThreadTs(threadTs),
              op: op,
            }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Close round' },
            action_id: 'close_round',
            style: 'danger',
            value: JSON.stringify({
              channelId: channelId,
              encodedThreadTs: encodeThreadTs(threadTs),
              op: op,
            }),
          },
        ],
      },
    ];

    // Update root message with new question
    await client.chat.update({
      channel: channelId,
      ts: threadTs,
      text: `🧠 <@${op}> asks:\n_*${newQuestion}*_`,
      blocks: updatedBlocks,
    });

    // Post message in thread to notify of edit
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '📝 Question updated by OP.',
    });

    // Close the modal with success message
    await client.views.update({
      view_id: view.id,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: 'Success',
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
              text: '✅ Question updated successfully!',
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('Error updating question:', error);
    try {
      await client.views.update({
        view_id: view.id,
        view: {
          type: 'modal',
          title: {
            type: 'plain_text',
            text: 'Error',
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
                text: '❌ Error updating question.',
              },
            },
          ],
        },
      });
    } catch (err) {
      console.error('Failed to update modal with error:', err);
    }
  }
});

// Close round: Button handler (OP only)
app.action('close_round', async ({ action, ack, body, client }) => {
  await ack();

  if (action.type !== 'button') return;

  const userId = (body as any).user.id;

  try {
    const buttonData = parseButtonData(action);
    if (!buttonData || !buttonData.encodedThreadTs) {
      console.error('Missing encodedThreadTs in button data');
      const channelId = buttonData?.channelId || (body as any).channel?.id;
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Error: Missing thread information.',
        });
      }
      return;
    }
    
    const { channelId, encodedThreadTs, op: expectedOp } = buttonData;
    const threadTs = decodeThreadTs(encodedThreadTs);

    // Validate OP and round status
    const validation = await validateOpAndRound(client, userId, channelId, threadTs, expectedOp!, 'close');
    if (validation.error) {
      return; // Error already sent via validateOpAndRound
    }

    const roundInfo = validation.roundInfo!;

    // If round is OPEN (not SOLVED), remove question count from OP
    if (roundInfo.state.status === RoundStatus.OPEN) {
      const year = getYearFromTimestamp(threadTs);
      await removeQuestion(channelId, roundInfo.state.op, year);
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

    // Get question text from round state (or parse as fallback)
    const questionText = await getQuestionText(client, channelId, threadTs, roundInfo.state);

    // Find the solver from the instruction message
    const instructionMsg = await findInstructionMessage(client, channelId, threadTs);

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
              text: `*Question (<@${roundInfo.state.op}>):*\n_*${questionText}*_`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Answer (<@${instructionMsg?.solverId}>):*\n_${roundInfo.state.answer}_`,
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