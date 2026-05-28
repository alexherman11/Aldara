// Heuristic, dependency-free end-of-utterance detector tuned for LANGUAGE
// LEARNERS rather than fluent native speakers.
//
// It implements the shape LiveKit's AgentSession expects for a model-based turn
// detector (`turnHandling.turnDetection`): once VAD detects a silence at the end
// of speech, the session calls `predictEndOfTurn` and uses the returned
// probability to choose how long to wait before committing the turn:
//
//   prob >= unlikelyThreshold  → commit after `endpointing.minDelay`  (snappy)
//   prob <  unlikelyThreshold  → wait until `endpointing.maxDelay`    (patient)
//
// If the learner resumes speaking inside that window the pending commit is
// cancelled, so a long `maxDelay` is essentially "free" — it only adds latency
// when the learner actually goes quiet. We therefore bias HARD toward "not done"
// whenever the transcript looks mid-thought (a dangling connector, an article or
// preposition with nothing after it, a filler, or a trailing comma). Those are
// exactly the moments a naive silence timer cuts a learner off while they hunt
// for the next word. A complete-looking sentence, by contrast, commits snappily.
//
// This is a pragmatic stand-in for a neural EOU model (LiveKit's MultilingualModel
// is published only against agents core 1.4.x; we are pinned to 1.2.6). It reads
// the transcript Soniox produces, so swapping in the real model later is a drop-in
// replacement of this object.

import { llm } from '@livekit/agents';

// Spanish (+ a few English) tokens that cannot END a finished utterance. If the
// learner trails off on one of these they are almost certainly mid-thought.
const DANGLING_TOKENS = new Set<string>([
  // conjunctions / connectors
  'y', 'e', 'o', 'u', 'ni', 'pero', 'sino', 'aunque', 'porque', 'pues',
  'que', 'como', 'cuando', 'donde', 'mientras', 'si', 'entonces',
  // articles
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo',
  // prepositions
  'a', 'al', 'ante', 'con', 'de', 'del', 'desde', 'en', 'entre', 'hacia',
  'hasta', 'para', 'por', 'según', 'sin', 'sobre', 'tras',
  // possessives / common pre-noun words that demand a continuation
  'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'muy', 'más', 'mas', 'tan',
  // English connectors (learners code-switch constantly)
  'and', 'or', 'but', 'the', 'to', 'my', 'a', 'an', 'of', 'for', 'with', 'i',
]);

// Hesitation fillers — "let me think" noises. Almost never a turn boundary.
const FILLER_TOKENS = new Set<string>([
  'este', 'esto', 'eh', 'ehh', 'em', 'emm', 'mmm', 'mm', 'pues', 'osea',
  'um', 'uh', 'uhh', 'hmm', 'er',
]);

function lastUserText(chatCtx: llm.ChatContext): string {
  const items = chatCtx.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { role?: string; textContent?: string };
    if (item?.role === 'user' && typeof item.textContent === 'string') {
      return item.textContent;
    }
  }
  return '';
}

export class LearnerEouDetector {
  readonly model = 'habla-learner-eou';
  readonly provider = 'habla';

  // Probability below which the session waits the full `maxDelay`. 0.5 keeps the
  // decision a clean "leaning done" vs "leaning not-done" split.
  async unlikelyThreshold(_language?: string): Promise<number | undefined> {
    return 0.5;
  }

  // Lenient on purpose: returning false would skip the model entirely and fall
  // back to the snappy `minDelay`, removing the learner protection. es/en are the
  // languages we serve; anything else still gets the benefit of the doubt.
  async supportsLanguage(_language?: string): Promise<boolean> {
    return true;
  }

  // Returns P(end-of-turn). Higher = more confident the learner is finished.
  async predictEndOfTurn(
    chatCtx: llm.ChatContext,
    _timeout?: number,
  ): Promise<number> {
    const raw = lastUserText(chatCtx).trim();
    if (!raw) return 0.5; // nothing to read — neutral; nothing to wait for anyway

    const lower = raw.toLowerCase();
    const endsTerminal = /[.!?…]$/.test(raw);
    const endsComma = /[,;:]$/.test(raw);

    // Isolate the final word (strip surrounding punctuation, keep Spanish chars).
    const words = lower.split(/\s+/).filter(Boolean);
    const lastWord = (words[words.length - 1] ?? '').replace(
      /[^\p{L}\p{N}áéíóúñü]/giu,
      '',
    );

    // Strongest "not done" signals — independent of punctuation, which ASR often
    // omits. A trailing connector/article/preposition or a filler means wait.
    if (FILLER_TOKENS.has(lastWord)) return 0.1;
    if (DANGLING_TOKENS.has(lastWord)) return 0.15;
    if (endsComma) return 0.25;

    // A clean terminal punctuation mark is a strong "done" signal.
    if (endsTerminal) return 0.92;

    // Default: lean "done" (above threshold → snappy minDelay) so short complete
    // answers like "sí", "rojo", "me gusta el café" don't incur needless latency.
    return 0.6;
  }
}
