// Message building helper functions

import { QUESTION_REGEX } from '../config';
import { encodeThreadTs } from './rounds';
import { openDmChannel } from './slack';

// Create DM solve confirmation blocks
export function buildSolveDmBlocks(params: {
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
    } as any);
  }

  return blocks;
}

// Update DM message in-place to show status
export async function updateDmMessageStatus(client: any, dmChannelId: string, dmMessageTs: string, text: string, status: 'CONFIRMED' | 'CANCELLED') {
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

// Create DM blocks for private answer confirmation
export function buildPrivateAnswerDmBlocks(params: {
  submitterId: string;
  questionText: string;
  answerText: string;
  permalink: string | null;
  payloadValue: string;
}) {
  const { submitterId, questionText, answerText, permalink, payloadValue } = params;

  const strippedQuestionText = questionText.replace(QUESTION_REGEX, '').trim() || questionText;

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

// Send a summary DM to the winner when a round is solved
export async function sendWinnerSummary(
  client: any,
  winnerId: string,
  questionText: string,
  answerText: string,
  permalink: string | null,
  op: string
): Promise<void> {
  try {
    const dmChannelId = await openDmChannel(client, winnerId);
    
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎉 *Congratulations! You solved the puzzle!*\n\nYou earned 1 point for correctly answering <@${op}>'s question:`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Question:*\n> "${questionText}"\n\n*Your Answer:*\n> _"${answerText}"_`,
        },
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

    await client.chat.postMessage({
      channel: dmChannelId,
      text: `🎉 Congratulations! You solved the puzzle and earned 1 point!\n\nYou correctly answered <@${op}>'s question: "${questionText}"\nYour Answer: "${answerText}"`,
      blocks,
    });
  } catch (error) {
    console.error('Error sending winner summary DM:', error);
    // Don't throw - this is a nice-to-have feature
  }
}
