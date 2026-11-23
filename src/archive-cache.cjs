const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { download } = require('./policy.cjs');

function archiveIndex(root, packages) {
  const index = new Map();
  for (const versions of Object.values(packages)) {
    for (const pkg of versions) {
      for (const spec of pkg.data.distfiles) {
        const parts = [pkg.package, pkg.version, spec.name];
        if (!parts.every(part => typeof part === 'string' && part.length && !/^[.]+$|[\\/:\x00-\x1f]/.test(part)))
          throw Error('Invalid catalog archive path');
        const key = `ruyi-image://archive/${parts.map(encodeURIComponent).join('/')}`;
        index.set(key, { ...spec, file: path.join(root, pkg.package, pkg.version, 'downloads', spec.name) });
      }
    }
  }
  return index;
}

async function saveArchive(spec, source, signal, progress) {
  const directory = path.dirname(spec.file);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.partial-${randomUUID()}`);
  try {
    const hash = createHash('sha256');
    await pipeline(source, async function* (chunks) {
      let bytes = 0;
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > spec.size) throw Error(`Incorrect size for ${spec.name}`);
        hash.update(chunk);
        progress(bytes);
        yield chunk;
      }
      if (bytes !== spec.size || hash.digest('hex') !== spec.checksums.sha256)
        throw Error(`Size or SHA-256 mismatch for ${spec.name}`);
    }, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    await fs.rename(temp, spec.file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function ensureArchive(spec, fetch, signal, report) {
  try {
    if ((await fs.stat(spec.file)).size === spec.size) {
      report('SHA-256', 0);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(spec.file, { signal })) hash.update(chunk);
      if (hash.digest('hex') === spec.checksums.sha256) return 'cached';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const errors = [];
  for (const url of spec.resolved_urls.filter(download)) {
    signal.throwIfAborted();
    try {
      report('Download', 0);
      const response = await fetch(url, { signal, credentials: 'omit' });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw Error(`HTTP ${response.status}`);
      }
      await saveArchive(spec, response.body, signal, bytes => report('Download', bytes));
      return 'downloaded';
    } catch (error) {
      signal.throwIfAborted();
      errors.push(`${new URL(url).host}: ${error.message}`);
    }
  }
  throw Error(errors.join('\n') || `No mirror for ${spec.name}`);
}

module.exports = { archiveIndex, ensureArchive, saveArchive };
