import type { LanguageTag, TranscribedWord } from './stt/types.js';

/**
 * Phrase segmenter for code-switching learner speech.
 *
 * Takes a transcript with per-word timestamps (from any STT provider) and
 * produces language-tagged phrases that can be scored independently. Two
 * concerns merged:
 *
 *   1. Silence segmentation — split on inter-word gaps > SILENCE_THRESHOLD_SEC.
 *      Long pauses are natural in L2 speech and shouldn't merge into one
 *      contaminated "utterance" passed to pronunciation scoring.
 *
 *   2. Language segmentation — split when consecutive words switch languages.
 *      Mid-phrase "but I don't know" interrupting Spanish becomes its own
 *      English phrase, not part of the surrounding Spanish phrase.
 *
 * Output drives per-phrase Azure pronunciation scoring (Spanish phrases only)
 * and per-phrase UI rendering (English shown as plain text, Spanish annotated).
 */

export interface Phrase {
  /** Concatenated word text, single-spaced */
  text: string;
  /** Per-word breakdown (preserves timestamps for audio slicing) */
  words: TranscribedWord[];
  /** Dominant language of the phrase */
  language: LanguageTag;
  /** Audio slice start, seconds */
  start_sec: number;
  /** Audio slice end, seconds */
  end_sec: number;
}

const SILENCE_THRESHOLD_SEC = 0.6;
const MIN_PHRASE_DURATION_SEC = 0.18;

// Spanish "stopword" lexicon for cheap language classification. Far from
// exhaustive — covers the high-frequency words an A1–B1 learner produces.
// Lowercased. Includes common L2-influenced spellings (e.g., "estas" without accent).
const SPANISH_LEXICON: ReadonlySet<string> = new Set([
  // articles/determiners
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  // pronouns
  'yo', 'tu', 'tú', 'el', 'él', 'ella', 'nosotros', 'ustedes', 'ellos', 'ellas',
  'me', 'te', 'se', 'nos', 'le', 'les', 'lo', 'mi', 'tu', 'su', 'mis', 'tus', 'sus',
  // common verbs (conjugated)
  'es', 'son', 'soy', 'eres', 'somos', 'fue', 'fueron', 'era', 'eran',
  'esta', 'está', 'están', 'estoy', 'estaba',
  'tengo', 'tienes', 'tiene', 'tenemos', 'tienen', 'tener',
  'hago', 'haces', 'hace', 'hacemos', 'hacen', 'hacer',
  'voy', 'vas', 'va', 'vamos', 'van', 'ir',
  'quiero', 'quieres', 'quiere', 'queremos', 'quieren',
  'puedo', 'puedes', 'puede', 'podemos', 'pueden',
  'sé', 'sabes', 'sabe', 'sabemos', 'saben',
  'gusta', 'gustan', 'gustaria', 'gustaría', 'encanta', 'encantan',
  'necesito', 'necesitas', 'necesita',
  'aprender', 'aprendo', 'aprendes', 'aprende',
  'hablar', 'hablo', 'hablas', 'habla',
  'estudiar', 'estudio', 'estudias', 'estudia',
  'trabajar', 'trabajo', 'trabajas', 'trabaja',
  'vivir', 'vivo', 'vives', 'vive', 'vivimos',
  'comer', 'como', 'comes', 'come', 'comemos',
  'beber', 'bebo', 'bebes', 'bebe',
  'cocinar', 'cocino', 'cocinas', 'cocina',
  'caminar', 'camino', 'caminas', 'camina',
  'leer', 'leo', 'lees', 'lee',
  'escribir', 'escribo', 'escribes', 'escribe',
  'completar', 'completo', 'completas', 'completa',
  'intentar', 'intento', 'intentas', 'intenta', 'intentando',
  'preguntar', 'pregunto', 'preguntas', 'pregunta', 'preguntarte',
  // common nouns
  'casa', 'familia', 'comida', 'agua', 'café', 'leche', 'tiempo', 'día', 'noche',
  'hombre', 'mujer', 'niño', 'niña', 'amigo', 'amiga', 'perro', 'gato',
  'libro', 'palabra', 'palabras', 'frase', 'pregunta', 'respuesta',
  'español', 'inglés', 'idioma', 'lengua', 'país', 'ciudad', 'calle',
  'cosa', 'cosas', 'manera', 'parte', 'lugar', 'mundo', 'persona', 'gente',
  'tareas', 'problema', 'pregunta', 'idea', 'plan', 'trabajo',
  // adjectives
  'bueno', 'buena', 'malo', 'mala', 'grande', 'pequeño', 'pequeña', 'bonito', 'bonita',
  'feliz', 'triste', 'cansado', 'cansada', 'fácil', 'difícil', 'rápido', 'lento',
  'mucho', 'mucha', 'muchos', 'muchas', 'poco', 'poca', 'todo', 'toda', 'todos', 'todas',
  // prepositions/connectors
  'a', 'al', 'de', 'del', 'en', 'con', 'sin', 'por', 'para', 'sobre', 'entre',
  'y', 'o', 'pero', 'porque', 'que', 'qué', 'si', 'sí', 'no', 'cuando', 'donde',
  'como', 'cómo', 'también', 'tampoco', 'muy', 'más', 'menos', 'ya', 'aún', 'todavía',
  // greetings/interjections
  'hola', 'adiós', 'gracias', 'pues', 'bueno', 'vale', 'claro', 'bien', 'mal',
  // numbers
  'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'veinte', 'treinta', 'cien', 'mil',
]);

// English lexicon for code-switch detection — shorter on purpose, covers the
// hesitation/fallback words an L2 Spanish learner most often switches to.
const ENGLISH_LEXICON: ReadonlySet<string> = new Set([
  'i', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'have', 'had', 'has',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'so', 'because', 'if', 'when', 'where', 'how', 'why', 'what',
  'know', 'think', 'want', 'need', 'like', 'love', 'try', 'trying', 'learn', 'learning',
  'feel', 'see', 'go', 'going', 'come', 'say', 'said', 'tell', 'speak', 'use',
  'just', 'still', 'really', 'very', 'too', 'also', 'even', 'maybe', 'always', 'never',
  'about', 'with', 'without', 'from', 'into', 'over', 'out', 'up', 'down', 'in', 'on',
  'to', 'of', 'for', 'at', 'by',
  'yes', 'okay', 'ok', 'right', 'sure', 'well',
  'people', 'thing', 'things', 'time', 'day', 'way', 'word', 'words', 'house', 'broom',
  // common stumble fillers
  'um', 'uh', 'hmm', 'er',
]);

// Words that exist in both Spanish and English with non-trivial frequency.
// These return 'unknown' from classifyWord so the smoothing pass can decide
// from neighbor context — otherwise "but I need a broom" splits because 'a'
// is also a Spanish preposition.
const AMBIGUOUS: ReadonlySet<string> = new Set([
  'a', 'no', 'me', 'mi', 'tu', 'su', 'la', 'el', 'son',
]);

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[.,!?;:¿¡"'()\[\]]/g, '').trim();
}

/**
 * Classify a single word. Lexicon-match-based — fast, no model call. Returns
 * 'unknown' for words not in either lexicon (proper nouns, FSRS items, learner
 * coinages) AND for ambiguous words that exist in both languages. Unknown
 * words inherit neighbor language during segmentation.
 */
export function classifyWord(word: string): LanguageTag {
  const w = normalizeWord(word);
  if (!w) return 'unknown';

  // Tildes and ñ are unambiguous Spanish signals
  if (/[áéíóúñ¿¡]/.test(w)) return 'es';

  // Words that exist in both languages need context — let smoothing decide
  if (AMBIGUOUS.has(w)) return 'unknown';

  if (SPANISH_LEXICON.has(w)) return 'es';
  if (ENGLISH_LEXICON.has(w)) return 'en';
  return 'unknown';
}

/**
 * Walk the words array, tag each by language, propagate 'unknown' tags by
 * looking at left/right neighbors with definite tags. After this pass every
 * word has a concrete language tag (defaults to Spanish if context is unclear,
 * since this is a Spanish-tutoring app and unknown words in conversation are
 * far more likely to be learner Spanish than learner English).
 */
function tagLanguages(words: TranscribedWord[]): TranscribedWord[] {
  const tagged = words.map((w) => ({
    ...w,
    // Trust the STT provider's per-word language tag when present (Deepgram
    // nova-3 multi mode emits these). Fall back to our lexicon classifier.
    language: w.language && w.language !== 'unknown' ? w.language : classifyWord(w.word),
  }));

  // Two-pass smoothing: left-to-right then right-to-left, replacing 'unknown'
  // with the closest neighbor's concrete tag.
  for (let i = 0; i < tagged.length; i++) {
    if (tagged[i].language === 'unknown' && i > 0 && tagged[i - 1].language !== 'unknown') {
      tagged[i].language = tagged[i - 1].language;
    }
  }
  for (let i = tagged.length - 1; i >= 0; i--) {
    if (tagged[i].language === 'unknown' && i < tagged.length - 1 && tagged[i + 1].language !== 'unknown') {
      tagged[i].language = tagged[i + 1].language;
    }
  }
  // Anything still 'unknown' defaults to Spanish (app context).
  for (const w of tagged) {
    if (w.language === 'unknown') w.language = 'es';
  }
  return tagged;
}

export function segment(words: TranscribedWord[]): Phrase[] {
  if (words.length === 0) return [];

  const tagged = tagLanguages(words);
  const phrases: Phrase[] = [];

  let current: TranscribedWord[] = [tagged[0]];
  let currentLang: LanguageTag = tagged[0].language!;

  const flush = () => {
    if (current.length === 0) return;
    const duration = current[current.length - 1].end_sec - current[0].start_sec;
    if (duration < MIN_PHRASE_DURATION_SEC) {
      // Phrase too short — likely a single throwaway word. Drop it rather
      // than send a fragment to pronunciation scoring.
      current = [];
      return;
    }
    phrases.push({
      text: current.map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim(),
      words: current,
      language: currentLang,
      start_sec: current[0].start_sec,
      end_sec: current[current.length - 1].end_sec,
    });
    current = [];
  };

  for (let i = 1; i < tagged.length; i++) {
    const prev = tagged[i - 1];
    const next = tagged[i];
    const gap = next.start_sec - prev.end_sec;

    const silenceBreak = gap >= SILENCE_THRESHOLD_SEC;
    const langSwitch = next.language !== currentLang;

    if (silenceBreak || langSwitch) {
      flush();
      currentLang = next.language!;
    }
    current.push(next);
  }
  flush();

  return phrases;
}
