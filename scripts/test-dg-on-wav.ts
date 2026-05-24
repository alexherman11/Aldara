import 'dotenv/config';
import * as _dotenv from 'dotenv';
_dotenv.config({ override: true });
import fs from 'node:fs';

const paths = ['.logs/pron-test/turn-1.wav','.logs/pron-test/turn-2.wav','.logs/pron-test/turn-3.wav'];
for (const p of paths) {
  const wav = fs.readFileSync(p);
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=multi&punctuate=true', {
    method: 'POST',
    headers: { Authorization: 'Token ' + process.env.DEEPGRAM_API_KEY!, 'Content-Type': 'audio/wav' },
    body: wav,
  });
  const j: any = await r.json();
  const a = j.results?.channels?.[0]?.alternatives?.[0];
  console.log(p, '→', JSON.stringify({transcript: a?.transcript || '', conf: a?.confidence, words: a?.words?.length}));
}
