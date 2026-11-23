const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { archiveIndex, ensureArchive } = require('../src/archive-cache.cjs');

test('new sessions reuse verified files and repair corrupt files from a mirror', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-archive-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('a small image archive');
  const distfile = { name: 'board.img.gz', size: bytes.length, checksums: {
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }, resolved_urls: ['https://mirror.example/board.img.gz'] };
  const packages = { board: [{ package: 'board', version: '1', data: { distfiles: [distfile] } }] };
  const reopen = () => [...archiveIndex(root, packages).values()][0];
  const retrieve = (fetch) => ensureArchive(reopen(), fetch, new AbortController().signal, () => {});
  assert.equal(await retrieve(async () => new Response(bytes)), 'downloaded');
  assert.deepEqual(await fs.readFile(path.join(root, 'board', '1', 'downloads', distfile.name)), bytes);
  assert.equal(await retrieve(() => assert.fail('unexpected network access')), 'cached');
  await fs.writeFile(reopen().file, Buffer.alloc(bytes.length));
  await assert.rejects(retrieve(async () => new Response(Buffer.alloc(bytes.length))), /SHA-256 mismatch/);
  assert.deepEqual(await fs.readdir(path.dirname(reopen().file)), [distfile.name]);
  assert.equal(await retrieve(async () => new Response(bytes)), 'downloaded');
  assert.deepEqual(await fs.readFile(reopen().file), bytes);
});
