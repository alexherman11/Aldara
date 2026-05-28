// Offline sanity check for the learner-aware end-of-utterance detector.
// Pure logic, no network — safe to fold into `npm test` later. Run directly:
//   npx tsx scripts/test-learner-eou.ts
import { LearnerEouDetector } from '../src/turn/learner-eou.js';

const det = new LearnerEouDetector();

// Build a fake ChatContext exposing just what predictEndOfTurn reads (.items).
function ctx(userText: string): any {
  return { items: [{ role: 'user', textContent: userText }] };
}

type Case = { text: string; expect: 'wait' | 'commit'; why: string };

// 'wait'  → prob < 0.5  → session waits to maxDelay (don't cut the learner off)
// 'commit'→ prob >= 0.5 → session commits after minDelay (snappy)
const cases: Case[] = [
  { text: 'Yo quiero ir a la playa.', expect: 'commit', why: 'complete sentence + terminal punctuation' },
  { text: 'Me gusta el', expect: 'wait', why: 'dangling article "el"' },
  { text: 'Pienso que', expect: 'wait', why: 'dangling connector "que"' },
  { text: 'Yo tengo un perro y', expect: 'wait', why: 'dangling "y"' },
  { text: 'Quiero comer porque', expect: 'wait', why: 'dangling "porque"' },
  { text: 'Este', expect: 'wait', why: 'filler "este"' },
  { text: 'eh', expect: 'wait', why: 'filler "eh"' },
  { text: 'Bueno,', expect: 'wait', why: 'trailing comma' },
  { text: 'sí', expect: 'commit', why: 'short but complete one-word answer' },
  { text: 'rojo', expect: 'commit', why: 'short content-word answer' },
  { text: 'Me gusta el café', expect: 'commit', why: 'complete-looking, no dangler' },
  { text: 'I want to', expect: 'wait', why: 'English dangling "to"' },
  { text: '', expect: 'commit', why: 'empty → neutral 0.5 (>= threshold)' },
];

let failures = 0;
for (const c of cases) {
  const prob = await det.predictEndOfTurn(ctx(c.text));
  const threshold = (await det.unlikelyThreshold('es')) ?? 0.5;
  const decision = prob < threshold ? 'wait' : 'commit';
  const ok = decision === c.expect;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} p=${prob.toFixed(2)} ${decision.padEnd(6)} (want ${c.expect.padEnd(6)}) "${c.text}" — ${c.why}`,
  );
}

console.log(
  `\nsupportsLanguage(es)=${await det.supportsLanguage('es')}, ` +
    `unlikelyThreshold=${await det.unlikelyThreshold('es')}`,
);
if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nAll learner-EOU cases passed.');
