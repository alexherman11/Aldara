import dotenv from 'dotenv';
dotenv.config({ override: true });

async function main() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    console.error('AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set');
    process.exit(2);
  }

  console.log(`Region: ${region}`);
  console.log(`Key length: ${key.length} chars`);
  console.log(`Key prefix: ${key.slice(0, 4)}…`);

  const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  console.log(`POST ${url}`);

  const startedAt = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Length': '0',
      },
    });
  } catch (err) {
    console.error('Network error:', err);
    process.exit(1);
  }

  const latencyMs = Date.now() - startedAt;
  const body = await resp.text();

  console.log(`HTTP ${resp.status} ${resp.statusText} (${latencyMs} ms)`);

  if (resp.status === 200) {
    console.log(`Token received (${body.length} chars, JWT-shaped: ${body.split('.').length === 3})`);
    console.log('\nRESULT: Azure credentials are LIVE');
    process.exit(0);
  }

  console.log(`Body: ${body.slice(0, 500)}`);

  if (resp.status === 401) {
    console.log('\nRESULT: Azure key is INVALID or REVOKED (401 Unauthorized)');
  } else if (resp.status === 403) {
    console.log('\nRESULT: Azure key is FORBIDDEN — possibly disabled or quota exhausted');
  } else if (resp.status === 404) {
    console.log('\nRESULT: Region is INVALID (404) — check AZURE_SPEECH_REGION value');
  } else {
    console.log(`\nRESULT: Unexpected status ${resp.status}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
