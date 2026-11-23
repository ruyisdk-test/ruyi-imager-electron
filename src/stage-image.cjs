const fs = require('node:fs/promises');
const path = require('node:path');

async function withStagedImage(contents, root, image, use) {
  const directory = await fs.mkdtemp(path.join(root, 'writer-'));
  const source = path.join(directory, 'source.img');
  try {
    await new Promise((resolve, reject) => {
      const session = contents.session;
      let item;
      function cleanup() {
        clearTimeout(timer);
        session.off('will-download', onDownload);
        contents.off('render-process-gone', onGone);
        contents.off('destroyed', onGone);
      }
      function onGone() {
        item?.cancel();
        cleanup();
        reject(Error('Image transfer interrupted'));
      }
      function onDownload(_event, download, sender) {
        if (sender !== contents || download.getURL() !== image.url) return;
        item = download;
        clearTimeout(timer);
        session.off('will-download', onDownload);
        download.setSavePath(source);
        download.once('done', (_event, state) => {
          cleanup();
          if (state === 'completed') resolve();
          else reject(Error(`Image transfer ${state}`));
        });
      }
      const timer = setTimeout(onGone, 30000);
      session.on('will-download', onDownload);
      contents.once('render-process-gone', onGone);
      contents.once('destroyed', onGone);
      try { contents.downloadURL(image.url); }
      catch (error) { cleanup(); reject(error); }
    });
    if ((await fs.stat(source)).size !== image.size) throw Error('Incomplete disk image');
    return await use(source);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { withStagedImage };
