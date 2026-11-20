const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const name =
  process.platform === 'win32' ? 'ruyi-disk-writer.exe' : 'ruyi-disk-writer';
mkdirSync(path.join(root, 'bin'), { recursive: true });
execFileSync(
  'go',
  [
    'build',
    '-mod=readonly',
    '-trimpath',
    '-o',
    path.join(root, 'bin', name),
    '.',
  ],
  {
    cwd: path.join(root, 'writer'),
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0' },
  },
);
