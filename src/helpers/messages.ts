// Message building helper functions

import { QUESTION_REGEX } from '../config';
import { encodeThreadTs } from './rounds';

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
