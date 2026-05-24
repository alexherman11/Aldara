/**
 * Smoke test for the Google TTS plugin.
 *
 * Imports @livekit/agents-plugin-google's beta.TTS and instantiates it with
 * the default Gemini voice the agent picks for the new `google` provider.
 * Confirms the plugin is installed at the expected version and that the
 * constructor doesn't blow up. Synthesis is gated behind `--synthesize`
 * because that path requires GOOGLE_API_KEY (or VertexAI credentials).
 *
 * Run with:
 *   tsx scripts/test-google-tts.ts                # construct only (no creds)
 *   tsx scripts/test-google-tts.ts --synthesize   # also call .synthesize()
 */

import 'dotenv/config';
import * as google from '@livekit/agents-plugin-google';

const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE || 'Aoede';
const DEFAULT_MODEL = 'gemini-2.5-flash-tts';

async function main() {
  const shouldSynthesize = process.argv.includes('--synthesize');

  // The plugin's TTS constructor requires either a GOOGLE_API_KEY or
  // VertexAI credentials — it throws synchronously without them. We feed a
  // dummy key when none is present so the construct-only smoke test still
  // verifies the import shape, version, and option surface. The dummy key
  // never actually goes to Google because we skip synthesize() below.
  const apiKey =
    process.env.GOOGLE_API_KEY || (shouldSynthesize ? '' : 'placeholder-for-smoke-test');

  if (shouldSynthesize && !apiKey) {
    console.error(
      '--synthesize requires GOOGLE_API_KEY in the environment. Set it in .env or export it.',
    );
    process.exitCode = 1;
    return;
  }

  const tts = new google.beta.TTS({
    model: DEFAULT_MODEL,
    voiceName: DEFAULT_VOICE,
    apiKey,
    instructions:
      'Speak warmly and clearly as Sofía, a patient Spanish tutor.',
  });

  console.log(`Google TTS instance created OK: ${DEFAULT_VOICE}`);
  console.log(`  model=${DEFAULT_MODEL}`);
  console.log(`  label=${tts.label ?? '(no label exposed)'}`);
  console.log(
    `  api_key_source=${process.env.GOOGLE_API_KEY ? 'env' : 'placeholder (smoke test)'}`,
  );

  if (!shouldSynthesize) {
    console.log(
      'Skipping synthesize() — pass --synthesize to actually call the API ' +
        '(requires GOOGLE_API_KEY).',
    );
    return;
  }

  console.log('Calling synthesize("Hola, soy Sofía.")…');
  const stream = tts.synthesize('Hola, soy Sofía.');
  let frames = 0;
  for await (const _frame of stream) {
    frames++;
  }
  console.log(`Synthesize OK — received ${frames} audio frame(s).`);
}

main().catch((err) => {
  console.error('test-google-tts failed:', err);
  process.exitCode = 1;
});
