function segment(value) {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    /[\\/:\x00-\x1f]/.test(value)
  )
    throw Error(`Invalid image path: ${value}`);
  return value;
}

async function directory(parent, path) {
  for (const part of path)
    parent = await parent.getDirectoryHandle(segment(part), { create: true });
  return parent;
}

async function existing(dir, name) {
  try {
    return await (await dir.getFileHandle(segment(name))).getFile();
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    return null;
  }
}

export async function prepareImages(
  pkg,
  { root, runtime, log, progress, localFile, signal },
) {
  const base = await directory(root, ['RuyiImages', pkg.package, pkg.version]);
  const extracted = await directory(base, ['images']);
  const wanted = [
    ...new Set(Object.values(pkg.data.provisionable.partition_map)),
  ];
  for (const path of wanted) path.split('/').forEach(segment);
  const files = new Map();
  for (const name of pkg.data.blob.distfiles) {
    signal.throwIfAborted();
    const spec = pkg.data.distfiles.find((item) => item.name === name);
    if (!spec?.checksums?.sha256) throw Error(`No SHA-256 for ${name}`);
    const key = [pkg.package, pkg.version, name].map(encodeURIComponent).join('/');
    const url = `ruyi-image://archive/${key}`;
    const stopProgress = window.ruyiImager.onArchiveProgress(value => {
      if (value.name === name && !signal.aborted) progress(value);
    });
    let file;
    try {
      let response = await fetch(url, { signal });
      if (!response.ok) {
        log(await response.text());
        signal.throwIfAborted();
        await localFile(spec, url);
        signal.throwIfAborted();
        response = await fetch(url, { signal });
        if (!response.ok) throw Error(await response.text());
      }
      if (response.headers.get('X-Archive-Status') === 'cached') log(`Using cached file: ${name}`);
      file = await response.blob();
      if (file.size !== spec.size) throw Error(`Incomplete archive: ${name}`);
    } finally {
      stopProgress();
    }
    log(`SHA-256 ✓ ${name}`);
    const extracting = (percent) =>
      progress({ name, phase: 'Extract', percent });
    extracting(0);
    const found = await runtime.run(
      {
        kind: 'extract',
        file,
        dir: extracted,
        name,
        wanted,
        strip: spec.strip_components ?? 1,
      },
      undefined,
      extracting,
    );
    for (const path of found) {
      if (files.has(path)) throw Error(`Duplicate package image: ${path}`);
      const parts = path.split('/'),
        filename = parts.pop();
      const image = await existing(await directory(extracted, parts), filename);
      if (!image?.size) throw Error(`Empty or missing image: ${path}`);
      files.set(path, image);
    }
  }
  for (const path of wanted)
    if (!files.has(path)) throw Error(`Package does not contain ${path}`);
  progress(null);
  return files;
}
