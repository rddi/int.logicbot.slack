// Types and interfaces for the Logic Bot

export enum RoundStatus {
  OPEN = 'OPEN',
  SOLVED = 'SOLVED',
  CLOSED = 'CLOSED',
}

export interface RoundState {
  version: string;
  op: string; // User ID of the OP
  status: RoundStatus;
  threadTs: string; // Thread timestamp (root message ts for the round)
  channelId: string;
  question?: string; // Plain question text (stored to avoid parsing)
  answer?: string; // The accepted answer (only present when SOLVED)
}

export interface ScoreboardData {
  scoresByYear: Record<string, Record<string, number>>; // year -> userId -> score
  questionsByYear: Record<string, Record<string, number>>; // year -> userId -> question count
  lastUpdated: string; // ISO timestamp
}

export interface SolvePromptPayload {
  channelId: string;
  threadTs: string;
  guessAuthorId: string;
  roundControlTs: string;
  questionText: string;
  answerText: string;
  dmChannelId: string;
  dmMessageTs: string;
}

export interface PrivateAnswerPayload {
  channelId: string;
  threadTs: string;
  submitterId: string;
  roundControlTs: string;
  questionText: string;
  answerText: string;
  dmChannelId: string;
  dmMessageTs: string;
}
