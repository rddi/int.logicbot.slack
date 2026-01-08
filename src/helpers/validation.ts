// Validation helpers

import { ALLOWED_CHANNEL_IDS, ADMIN_USER_IDS } from '../config';
import { RoundStatus, RoundState } from '../types';
import { findRoundControlMessage } from './rounds';

// Check if channel is allowed
export function isAllowedChannel(channelId: string): boolean {
  return ALLOWED_CHANNEL_IDS.includes(channelId);
}

// Check if user is admin
export function isAdmin(userId: string): boolean {
  return ADMIN_USER_IDS.includes(userId);
}

// Parse button action data (common pattern)
export function parseButtonData(action: any): { channelId: string; encodedThreadTs: string; op?: string } | null {
  try {
    return JSON.parse((action as any).value);
  } catch {
    return null;
  }
}

// Validate OP and round status for button actions
export async function validateOpAndRound(
  client: any,
  userId: string,
  channelId: string,
  threadTs: string,
  expectedOp: string,
  action: 'edit' | 'close'
): Promise<{ roundInfo: { ts: string; state: RoundState } | null; error: string | null }> {
  // Check if user is the OP
  if (userId !== expectedOp) {
    const actionText = action === 'edit' ? 'edit the question' : 'close this round';
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Only the OP can ${actionText}.`,
    });
    return { roundInfo: null, error: 'NOT_OP' };
  }

  // Find the round
  const roundInfo = await findRoundControlMessage(channelId, threadTs);
  if (!roundInfo) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Round not found.',
    });
    return { roundInfo: null, error: 'NOT_FOUND' };
  }

  // Check if already closed or solved
  if (roundInfo.state.status === RoundStatus.CLOSED) {
    const message = action === 'edit' ? 'Cannot edit a closed round.' : 'This round is already closed.';
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: message,
    });
    return { roundInfo: null, error: 'ALREADY_CLOSED' };
  }

  if (roundInfo.state.status === RoundStatus.SOLVED) {
    const message = action === 'edit' ? 'Cannot edit a solved round.' : 'Cannot close a solved round.';
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: message,
    });
    return { roundInfo: null, error: 'ALREADY_SOLVED' };
  }

  return { roundInfo, error: null };
}

// Resolve user ID from token (mention, raw ID, or username)
export async function resolveUserIdFromToken(client: any, token: string): Promise<string | null> {
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

// Check if message looks like a guess
export function looksLikeGuess(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return (
    lower.startsWith('my guess') ||
    lower.startsWith('guess:') ||
    lower.startsWith('answer:') ||
    lower.startsWith('is it')
  );
}
