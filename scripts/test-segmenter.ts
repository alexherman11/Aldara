import { segment, classifyWord, type Phrase } from '../src/segmenter.js';
import type { TranscribedWord } from '../src/stt/types.js';

/**
 * Segmenter contract tests. Verifies:
 *   1. Pure-Spanish utterance → single Spanish phrase
 *   2. Pure-English utterance → single English phrase
 *   3. Code-switched mid-utterance → two phrases, correctly tagged
 *   4. Silence gap >0.6s → splits even within same language
 *   5. Tilde/ñ words always classify as Spanish
 *   6. Unknown words inherit neighbor language
 *   7. Reproduces the actual session-2 transcript from the live log
 */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, info?: string) {
  if (ok) {
    console.log(`  PASS  ${label}${info ? ` — ${info}` : ''}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${info ? ` — ${info}` : ''}`);
    failed++;
  }
}

function mkWord(word: string, start: number, end: number): TranscribedWord {
  return { word, start_sec: start, end_sec: end };
}

function summarize(p: Phrase): string {
  return `"${p.text}" [${p.language}, ${p.start_sec.toFixed(2)}-${p.end_sec.toFixed(2)}s]`;
}

// ── 1. Pure Spanish ────────────────────────────────────────────────
console.log('\n── 1. Pure Spanish utterance ──');
{
  const ws: TranscribedWord[] = [
    mkWord('Hola', 0.0, 0.4),
    mkWord('me', 0.5, 0.6),
    mkWord('llamo', 0.7, 1.0),
    mkWord('Alex', 1.1, 1.5),
  ];
  const phrases = segment(ws);
  check('one phrase', phrases.length === 1, `got ${phrases.length}`);
  check('language = es', phrases[0]?.language === 'es');
  check('text = "Hola me llamo Alex"', phrases[0]?.text === 'Hola me llamo Alex');
}

// ── 2. Pure English ────────────────────────────────────────────────
console.log('\n── 2. Pure English utterance ──');
{
  const ws: TranscribedWord[] = [
    mkWord('I', 0.0, 0.1),
    mkWord('am', 0.2, 0.3),
    mkWord('trying', 0.4, 0.7),
    mkWord('to', 0.8, 0.9),
    mkWord('learn', 1.0, 1.3),
  ];
  const phrases = segment(ws);
  check('one phrase', phrases.length === 1);
  check('language = en', phrases[0]?.language === 'en');
}

// ── 3. Code-switched mid-utterance ─────────────────────────────────
console.log('\n── 3. Spanish → English mid-utterance ──');
{
  const ws: TranscribedWord[] = [
    mkWord('Me', 0.0, 0.1),
    mkWord('gusta', 0.2, 0.5),
    mkWord('aprender', 0.6, 1.0),
    mkWord('but', 1.1, 1.3),
    mkWord('I', 1.4, 1.5),
    mkWord('need', 1.6, 1.9),
    mkWord('a', 2.0, 2.1),
    mkWord('broom', 2.2, 2.5),
  ];
  const phrases = segment(ws);
  check('two phrases', phrases.length === 2, `got ${phrases.length}: ${phrases.map(summarize).join(' / ')}`);
  check(
    'first is Spanish',
    phrases[0]?.language === 'es' && phrases[0]?.text === 'Me gusta aprender',
    summarize(phrases[0]),
  );
  check(
    'second is English',
    phrases[1]?.language === 'en' && phrases[1]?.text === 'but I need a broom',
    summarize(phrases[1]),
  );
}

// ── 4. Silence gap splits ──────────────────────────────────────────
console.log('\n── 4. Silence gap >0.6s within same language ──');
{
  const ws: TranscribedWord[] = [
    mkWord('Hola', 0.0, 0.4),
    mkWord('me', 0.5, 0.6),
    mkWord('llamo', 0.7, 1.0),
    // 0.9s silence gap
    mkWord('Alex', 1.9, 2.3),
    mkWord('tengo', 2.4, 2.7),
    mkWord('treinta', 2.8, 3.2),
  ];
  const phrases = segment(ws);
  check('two phrases despite same language', phrases.length === 2, `got ${phrases.length}`);
  check('first ends before gap', phrases[0]?.end_sec === 1.0);
  check('second starts after gap', phrases[1]?.start_sec === 1.9);
}

// ── 5. Tildes / ñ always Spanish ──────────────────────────────────
console.log('\n── 5. Diacritic words classify as Spanish ──');
check('"día" → es', classifyWord('día') === 'es');
check('"niño" → es', classifyWord('niño') === 'es');
check('"está" → es', classifyWord('está') === 'es');
check('"¿cómo?" → es', classifyWord('¿cómo?') === 'es');

// ── 6. Unknown words inherit neighbor ──────────────────────────────
console.log('\n── 6. Unknown words inherit language from neighbors ──');
{
  const ws: TranscribedWord[] = [
    mkWord('Tengo', 0.0, 0.3),
    // 'una' is in lexicon, 'broma' (joke) is — but make it a real unknown
    mkWord('una', 0.4, 0.5),
    mkWord('zorrofobia', 0.6, 1.1), // made-up word, unknown
    mkWord('grande', 1.2, 1.5),
  ];
  const phrases = segment(ws);
  check(
    'unknown word inherits Spanish from neighbors',
    phrases.length === 1 && phrases[0]?.language === 'es',
    `got ${phrases.length}: ${phrases.map(summarize).join(' / ')}`,
  );
}

// ── 7. Real session-2 transcript (from live log) ───────────────────
console.log('\n── 7. Real learner session transcript ──');
{
  // The actual session-2 message: "Pues, para mí, mi día está bien, Estoy
  // intentando de hacer mis tareas y la problema es que ahora no tengo todo
  // que necesito para completar mi mis mis cosas sobre la casa, No tengo una
  // broom, but I'm trying to learn how to use those words."
  //
  // Synthesized with plausible timestamps. Tests that "broom" (unknown to
  // Spanish lexicon, English lexicon includes it) triggers the language
  // switch, and that the final English clause segments out.
  const baseTime = 0;
  const wordStream: Array<[string, number]> = [
    ['Pues', 0.5], ['para', 0.3], ['mi', 0.2], ['mi', 0.2], ['día', 0.3],
    ['está', 0.4], ['bien', 0.4],
    // ~0.8s pause
    ['Estoy', 0.5], ['intentando', 0.6], ['de', 0.2], ['hacer', 0.4],
    ['mis', 0.2], ['tareas', 0.5],
    ['y', 0.1], ['la', 0.1], ['problema', 0.5], ['es', 0.2], ['que', 0.2],
    ['ahora', 0.4], ['no', 0.2], ['tengo', 0.3], ['todo', 0.3], ['que', 0.2],
    ['necesito', 0.5], ['para', 0.3], ['completar', 0.5],
    ['mi', 0.2], ['mis', 0.2], ['mis', 0.2], ['cosas', 0.4],
    ['sobre', 0.4], ['la', 0.2], ['casa', 0.4],
    // 0.7s pause
    ['No', 0.2], ['tengo', 0.3], ['una', 0.2], ['broom', 0.4],
    // 0.7s pause then English
    ['but', 0.2], ['I\'m', 0.2], ['trying', 0.4], ['to', 0.1], ['learn', 0.3],
    ['how', 0.2], ['to', 0.1], ['use', 0.2], ['those', 0.3], ['words', 0.4],
  ];
  let t = baseTime;
  const ws: TranscribedWord[] = wordStream.map(([word, dur], i) => {
    const start = t;
    t += dur;
    const end = t;
    // inject silence after specific positions to simulate pauses
    if (i === 6) t += 0.8;       // after "bien"
    if (i === 32) t += 0.7;      // after "casa"
    if (i === 36) t += 0.7;      // after "broom"
    t += 0.05; // small inter-word gap
    return mkWord(word, start, end);
  });

  const phrases = segment(ws);
  console.log(`     produced ${phrases.length} phrases:`);
  for (const p of phrases) console.log(`       ${summarize(p)}`);

  const spanishPhrases = phrases.filter((p) => p.language === 'es');
  const englishPhrases = phrases.filter((p) => p.language === 'en');
  check(
    'at least 3 Spanish phrases',
    spanishPhrases.length >= 3,
    `got ${spanishPhrases.length}`,
  );
  check(
    'at least 1 English phrase',
    englishPhrases.length >= 1,
    `got ${englishPhrases.length}`,
  );
  check(
    'final phrase is English',
    phrases[phrases.length - 1]?.language === 'en',
  );
  check(
    'English phrase includes "but"',
    englishPhrases.some((p) => p.text.toLowerCase().includes('but')),
  );
  check(
    'no Spanish phrase is contaminated with English filler',
    !spanishPhrases.some((p) => /\bbut\b|\bi'm\b/i.test(p.text)),
  );
}

console.log('\n════════════════════════════════════════════════');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
