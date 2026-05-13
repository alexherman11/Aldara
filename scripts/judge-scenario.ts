/**
 * Scenario judge — scores a captured scenario run against the explicit rubric
 * from the test plan, using Claude Sonnet as judge.
 *
 * Inputs:  scenarios/<name>/<runId>/transcript.json (from scenario-harness-direct)
 * Outputs: scenarios/<name>/<runId>/judgment.json + a short stdout summary
 *
 * The judge is GIVEN:
 *   - The full transcript
 *   - The scenario's expected behavior
 *   - The final controller state
 *
 * The judge MUST emit JSON with per-rubric numeric scores (1–5), a short
 * justification per rubric, and a list of detected anti-patterns. Anything
 * anti-pattern hit forces an overall pass=false.
 *
 * Usage:
 *   npx tsx scripts/judge-scenario.ts <scenarioRunDir>
 */

import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const JUDGE_MODEL = 'claude-sonnet-4-6';

const RUBRIC = `\
You are an expert judge evaluating a Spanish-English language tutor session.
Your job is to score the tutor (Sofía) against a written rubric.

You receive:
  - The scenario name and its expected behavior
  - The full transcript ([learner] / [tutor] turns)
  - The final controller state (bilingual ratio target, edge state)

Score each rubric dimension on 1–5:
  1 = clearly fails the criterion
  2 = mostly fails with some exceptions
  3 = mixed — meets some, fails some
  4 = mostly meets with minor lapses
  5 = clearly and consistently meets

Rubrics:

1. **persona_fit** — Does Sofía sound like a warm friend who happens to be a tutor (not a textbook, not a chatbot)? Curious, slightly playful, no performative enthusiasm? She makes small observations like a real friend would.

2. **code_switching_technique** — Does she use the sandwich technique, scaffolded substitution, or mirror-and-elevate at least once? Are Spanish words dropped into English sentences with meaning carried by context (vs translated after the fact)?

3. **no_quiz_no_drill** — Does she avoid quizzing the learner ("Can you say 'cat' in Spanish?") and avoid drill-style teaching ("Repeat after me")? Teaching should happen inside the conversation, not as a break from it.

4. **response_specificity** — Do her replies actually engage with what the learner said? A real friend remembers and references specific things. A response that could have been said to anyone gets a low score.

5. **bilingual_ratio_adherence** — Roughly compare Spanish-vs-English content in Sofía's turns to the controller's stated target (provided below). Within ±15 percentage points = 5; ±25 = 4; ±35 = 3; further off = 2 or 1.

6. **mistake_handling** — If the learner made grammar/word-choice errors, does Sofía model the correct form back inside her reply (instead of explicitly correcting)? If they pronounced something poorly, does she model the word back cleanly?

7. **naturalness** — Does the conversation flow like a real friendly exchange, or does it feel like a lesson dressed up as conversation?

Anti-patterns to detect (return list; ANY anti-pattern = overall pass=false):
  - Parenthetical translations like "hola (hello)"
  - Phonetic respellings like "co-ci-NAR"
  - Markdown formatting (asterisks, bullets, code fences)
  - "Repeat after me" / "Can you say"
  - "Very good!" reflexively after every learner turn
  - Pronunciation guides with dashes, IPA, etc.
  - Breaking out of conversation to deliver a lesson

Output ONLY a JSON object with this exact shape (no markdown fences, no preamble):

{
  "rubrics": {
    "persona_fit":              { "score": 1-5, "justification": "..." },
    "code_switching_technique": { "score": 1-5, "justification": "..." },
    "no_quiz_no_drill":         { "score": 1-5, "justification": "..." },
    "response_specificity":     { "score": 1-5, "justification": "..." },
    "bilingual_ratio_adherence":{ "score": 1-5, "justification": "..." },
    "mistake_handling":         { "score": 1-5, "justification": "..." },
    "naturalness":              { "score": 1-5, "justification": "..." }
  },
  "anti_patterns": [
    { "type": "...", "evidence": "..." }
  ],
  "overall": {
    "avg": <number, mean of the 7 scores>,
    "pass": <bool, true iff avg >= 4.0 AND anti_patterns is empty>,
    "summary": "<2-3 sentences on what was strong and what to fix next>"
  }
}
`;

interface Transcript {
  scenario: string;
  transcript: Array<{ role: 'learner' | 'tutor'; text: string }>;
  finalControllerState: { current_ratio_target: number; edge_state: string };
}

interface Judgment {
  rubrics: Record<string, { score: number; justification: string }>;
  anti_patterns: Array<{ type: string; evidence: string }>;
  overall: { avg: number; pass: boolean; summary: string };
}

async function judge(runDir: string): Promise<void> {
  const transcriptPath = join(runDir, 'transcript.json');
  if (!existsSync(transcriptPath)) {
    throw new Error(`No transcript.json in ${runDir}`);
  }
  const metaPath = join(runDir, 'meta.json');
  const data: Transcript = JSON.parse(readFileSync(transcriptPath, 'utf-8'));
  const meta = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, 'utf-8'))
    : { name: data.scenario, description: '(no meta found)' };

  const transcriptText = data.transcript
    .map((t) => `[${t.role}] ${t.text}`)
    .join('\n');

  const userPayload = `\
Scenario: ${meta.name}
Expected behavior: ${meta.description}

Final controller state:
  bilingual_ratio_target: ${data.finalControllerState.current_ratio_target.toFixed(2)} (${Math.round(data.finalControllerState.current_ratio_target * 100)}% English)
  edge_state: ${data.finalControllerState.edge_state}

Transcript:
${transcriptText}

Now produce the JSON judgment per the rubric.`;

  console.log(`Judging ${runDir} via ${JUDGE_MODEL}…\n`);
  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2048,
    system: RUBRIC,
    messages: [{ role: 'user', content: userPayload }],
  });

  const raw =
    resp.content[0]?.type === 'text' ? resp.content[0].text : '';
  const clean = raw.replace(/```json\n?|```\n?/g, '').trim();
  let judgment: Judgment;
  try {
    judgment = JSON.parse(clean);
  } catch (err) {
    console.error('Judge returned non-JSON output:', err);
    console.error('Raw:', raw);
    process.exit(1);
  }

  // Persist the judgment + summary
  writeFileSync(join(runDir, 'judgment.json'), JSON.stringify(judgment, null, 2));

  // Stdout summary
  console.log('─── Rubric scores ───');
  for (const [name, { score, justification }] of Object.entries(judgment.rubrics)) {
    const bar = '█'.repeat(score) + '░'.repeat(5 - score);
    console.log(`  ${name.padEnd(30)} ${bar}  ${score}/5  — ${justification}`);
  }
  console.log('\n─── Anti-patterns ───');
  if (judgment.anti_patterns.length === 0) {
    console.log('  (none)');
  } else {
    for (const ap of judgment.anti_patterns) {
      console.log(`  • ${ap.type}: ${ap.evidence}`);
    }
  }
  console.log('\n─── Overall ───');
  console.log(`  avg=${judgment.overall.avg.toFixed(2)}/5   pass=${judgment.overall.pass}`);
  console.log(`  ${judgment.overall.summary}`);
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('Usage: npx tsx scripts/judge-scenario.ts <scenarioRunDir>');
    process.exit(1);
  }
  await judge(runDir);
}

main().catch((err) => {
  console.error('Judge failed:', err);
  process.exit(1);
});
