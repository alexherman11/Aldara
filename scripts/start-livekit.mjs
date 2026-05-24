import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(root, 'tools', 'livekit');
const config = join(binDir, 'livekit.yaml');
const bin = join(binDir, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');

if (!existsSync(bin)) {
  console.error(
    `[livekit] binary not found at ${bin}\n` +
    `Download it from https://github.com/livekit/livekit/releases/latest ` +
    `and extract into tools/livekit/ (see README).`,
  );
  process.exit(1);
}

const child = spawn(bin, ['--config', config], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
