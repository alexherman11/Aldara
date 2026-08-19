/**
 * Client-side translate / dictionary helpers for the hover-on-tutor-text
 * feature. Server endpoints live in src/token-server.ts:
 *   GET /api/dict/translate?q=…&context=…
 *   GET /api/dict/lookup?word=…
 *
 * We keep a small in-memory LRU here so that re-hovering a word (or hovering
 * the same word in two different bubbles) hits a single network request.
 * Server has its own 24h cache too — this just removes a roundtrip.
 */

export interface TranslateResp {
  translation: string;
  provider: string;
  cached?: boolean;
}

export interface DictSense {
  partOfSpeech: string;
  definitions: string[];
  examples: string[];
}

export interface DictLookupResp {
  word: string;
  senses: DictSense[];
  examples: Array<{ es: string; en: string }>;
  cached?: boolean;
}

class LruCache<V> {
  private max: number;
  private map = new Map<string, V>();
  constructor(max: number) {
    this.max = max;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

const translateCache = new LruCache<TranslateResp>(200);
const lookupCache = new LruCache<DictLookupResp>(200);
const inflightTranslate = new Map<string, Promise<TranslateResp>>();
const inflightLookup = new Map<string, Promise<DictLookupResp>>();

export function normalizeWord(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/^[¿¡"'`(\[{.,!?;:]+|[.,!?;:"'`)\]}]+$/g, '')
    .trim()
    .toLowerCase();
}

export function translate(
  word: string,
  context: string,
): Promise<TranslateResp> {
  const key = `${normalizeWord(word)}::${context.slice(0, 80).toLowerCase()}`;
  const hit = translateCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = inflightTranslate.get(key);
  if (flight) return flight;

  const params = new URLSearchParams({ q: word });
  if (context) params.set('context', context);
  const p = fetch(`/api/dict/translate?${params.toString()}`)
    .then(async (r) => {
      if (!r.ok) throw new Error(`translate ${r.status}`);
      const data = (await r.json()) as TranslateResp;
      translateCache.set(key, data);
      return data;
    })
    .finally(() => {
      inflightTranslate.delete(key);
    });
  inflightTranslate.set(key, p);
  return p;
}

export function lookup(word: string): Promise<DictLookupResp> {
  const key = normalizeWord(word);
  const hit = lookupCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = inflightLookup.get(key);
  if (flight) return flight;

  const p = fetch(`/api/dict/lookup?word=${encodeURIComponent(word)}`)
    .then(async (r) => {
      if (!r.ok) throw new Error(`lookup ${r.status}`);
      const data = (await r.json()) as DictLookupResp;
      lookupCache.set(key, data);
      return data;
    })
    .finally(() => {
      inflightLookup.delete(key);
    });
  inflightLookup.set(key, p);
  return p;
}
