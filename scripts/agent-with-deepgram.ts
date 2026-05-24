/**
 * Wrapper that boots src/agent.ts with STT_PROVIDER forced to "deepgram",
 * overriding the dotenv `override:true` in agent.ts. dotenv's override only
 * touches keys present in .env, and .env doesn't define STT_PROVIDER, so
 * setting it here BEFORE importing the agent module wins.
 *
 * Used by the pronunciation-pipeline test against the alt-port LiveKit
 * (ws://127.0.0.1:7890), because the OpenAI-synthesized "learner" audio
 * decodes cleanly with Deepgram REST but produces empty AssemblyAI transcripts.
 */
process.env.STT_PROVIDER = 'deepgram';
// LIVEKIT_URL IS defined in .env (=ws://127.0.0.1:7880), so override:true
// would normally stomp our shell value. Use the CLI flag instead — see
// node_modules/@livekit/agents/dist/cli.cjs:106 which respects `--url`
// regardless of env. We push the flag onto process.argv before importing.
const passthrough = process.argv.slice(2);
if (!passthrough.includes('--url')) {
  process.argv.push('--url', 'ws://127.0.0.1:7890');
}
if (!passthrough.includes('dev') && !passthrough.includes('start')) {
  process.argv.splice(2, 0, 'dev');
}

await import('../src/agent.js');

// Mark as a module so top-level await is legal (tsc TS1375).
export {};
