/**
 * Shared voice-session helpers — pure functions and types used by both the
 * normal tutoring Session page and the post-signup Placement page. Extracted
 * so the two pages don't drift apart on transcript merging or orb mapping.
 */

import type { Room, TranscriptionSegment } from 'livekit-client';

export const PARTICIPANT_IDENTITY = 'learner';

export type OrbState = 'idle' | 'speaking' | 'listening';

export type Fragment = { segId: string; text: string; final: boolean };

export type Msg = {
  /** Stable id for React keys. Equals `${role}:${first segId}`. */
  id: string;
  role: 'tutor' | 'learner';
  /**
   * One bubble can absorb multiple LiveKit transcription segments that arrive
   * back-to-back from the same speaker, so a streamed multi-clause turn shows
   * as a single bubble rather than a rain of little ones.
   */
  fragments: Fragment[];
  /** True once every fragment is marked final. */
  final: boolean;
};

/** Map a LiveKit agent state attribute to the orb's visual state. */
export function agentStateToOrb(agentState: string | undefined): OrbState {
  switch (agentState) {
    case 'speaking':
      return 'speaking';
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'speaking';
    case 'initializing':
    case 'idle':
    default:
      return 'idle';
  }
}

/**
 * Strip punctuation and bracket/quote characters, collapse whitespace, and
 * lowercase — so two reasonable spellings of an utterance hash to one bucket.
 */
export function normalizeText(s: string | undefined): string {
  return (s ?? '')
    .replace(/[.,!?;:¿¡"'`\[\]\(\)\{\}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Flatten a bubble's fragments into its display text. */
export function bubbleText(msg: Msg): string {
  return msg.fragments
    .map((f) => f.text.trim())
    .filter((t) => t.length > 0)
    .join(' ');
}

/**
 * Merge an incoming batch of transcription segments into the running message
 * list. Updates a segment in place when LiveKit re-emits the same id, and
 * coalesces consecutive same-role segments into one bubble (a turn boundary is
 * implicit — the arrival of a segment from the other role).
 */
export function mergeSegments(
  prev: Msg[],
  segments: TranscriptionSegment[],
  role: 'tutor' | 'learner',
): Msg[] {
  let next = prev;
  let mutated = false;

  for (const seg of segments) {
    // 1. Update path — segment id already lives in some bubble.
    let updatedExisting = false;
    for (let i = 0; i < next.length; i++) {
      const bubble = next[i];
      const fragIdx = bubble.fragments.findIndex((f) => f.segId === seg.id);
      if (fragIdx < 0) continue;
      if (!mutated) {
        next = [...next];
        mutated = true;
      }
      const newFrags = [...bubble.fragments];
      newFrags[fragIdx] = {
        segId: seg.id,
        text: seg.text,
        final: seg.final,
      };
      next[i] = {
        ...bubble,
        fragments: newFrags,
        final: newFrags.every((f) => f.final),
      };
      updatedExisting = true;
      break;
    }
    if (updatedExisting) continue;

    // 2. New segment id — attach to the still-open same-role bubble at the
    // tail, or start a fresh bubble.
    let openIdx = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role !== role) break;
      openIdx = i;
      break;
    }

    if (!mutated) {
      next = [...next];
      mutated = true;
    }

    const newFrag: Fragment = {
      segId: seg.id,
      text: seg.text,
      final: seg.final,
    };

    if (openIdx >= 0) {
      const cur = next[openIdx];
      const newFrags = [...cur.fragments, newFrag];
      next[openIdx] = {
        ...cur,
        fragments: newFrags,
        final: newFrags.every((f) => f.final),
      };
    } else {
      next.push({
        id: `${role}:${seg.id}`,
        role,
        fragments: [newFrag],
        final: seg.final,
      });
    }
  }

  return mutated ? next : prev;
}

/** Find the identity of the agent participant in a room, if connected. */
export function findAgentIdentity(room: Room): string | null {
  for (const [, p] of room.remoteParticipants) {
    if (p.attributes?.['lk.agent.state']) return p.identity;
  }
  return null;
}
