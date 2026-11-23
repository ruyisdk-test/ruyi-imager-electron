const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  shell,
} = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream, openAsBlob } = require('node:fs');
const path = require('node:path');
const { DiskChoices } = require('./disk-choice.cjs');
const { archiveIndex, ensureArchive, saveArchive } = require('./archive-cache.cjs');
const { withStagedImage } = require('./stage-image.cjs');
const { site, page, download, validImage } = require('./policy.cjs');
const disks = require('./writer.cjs');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ruyi-imager',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'ruyi-image',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

async function openApp() {
  const writerName =
    process.platform === 'win32' ? 'ruyi-disk-writer.exe' : 'ruyi-disk-writer';
  const writer = path.join(
    app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..'),
    'bin',
    writerName,
  );
  await fs.access(writer);
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const contents = win.webContents;
  const session = contents.session;
  session.protocol.registerSource('ruyi-imager', {
    routes: [{
      match: { host: 'app' },
      source: {
        type: 'directory',
        root: path.join(app.getAppPath(), 'renderer'),
        headers: {
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ruyi-image:; object-src 'none'; frame-src 'none'; base-uri 'none'",
        },
      },
    }],
  });
  const targets = new Map();
  const choices = new DiskChoices();
  const catalog = JSON.parse(await fs.readFile(path.join(app.getAppPath(), 'renderer/static/catalog.json'), 'utf8'));
  const archives = archiveIndex(path.join(app.getPath('userData'), 'RuyiImages'), catalog.packages);
  let operating = false;
  let flashing = false;
  const busy = () => operating || flashing;
  const trusted = (frame) =>
    frame && frame === contents.mainFrame && page(frame.url);
  function verify(event) {
    if (event.sender !== contents || !trusted(event.senderFrame))
      throw Error('Unauthorized page');
  }
  function words(zh, en, de) {
    const language = app.getLocale().split('-')[0];
    return language === 'zh' ? zh : language === 'de' ? de : en;
  }
  const cancel = () => words('取消', 'Cancel', 'Abbrechen');
  async function pick(title, labels) {
    const { response } = await dialog.showMessageBox(win, {
      title: 'Ruyi Imager',
      message: title,
      buttons: [cancel(), ...labels],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response - 1;
  }
  const allowed = new Set(['usb', 'clipboard-sanitized-write']);
  session.setPermissionCheckHandler((sender, permission, origin, details) => {
    if (
      (sender && sender !== contents) ||
      (origin !== site && origin !== `${site}/`) ||
      !page(contents.getURL()) ||
      !allowed.has(permission)
    )
      return false;
    if (permission === 'usb')
      return !details.embeddingOrigin || details.embeddingOrigin === site;
    return details.isMainFrame;
  });
  session.setPermissionRequestHandler(
    (sender, permission, callback, details) => {
      const grant =
        sender === contents &&
        page(contents.getURL()) &&
        page(details.requestingUrl) &&
        allowed.has(permission) &&
        details.isMainFrame;
      callback(grant);
    },
  );
  session.on('select-usb-device', (event, { deviceList, frame }, callback) => {
    event.preventDefault();
    if (!trusted(frame)) {
      callback('');
      return;
    }
    const labels = deviceList.map(
      (device) =>
        `${device.productName || 'USB'} · ${device.vendorId.toString(16)}:${device.productId.toString(16)} ${device.serialNumber || ''}`,
    );
    void pick(
      words(
        '选择 Fastboot 开发板',
        'Select the Fastboot board',
        'Fastboot-Board auswählen',
      ),
      labels,
    ).then(
      (index) =>
        callback(trusted(frame) ? deviceList[index]?.deviceId || '' : ''),
      () => callback(''),
    );
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (download(url) && page(contents.getURL())) void shell.openExternal(url);
    return { action: 'deny' };
  });
  ipcMain.handle('archive:import', async (event, url) => {
    verify(event);
    const spec = archives.get(url);
    if (!spec) throw Error('Unknown archive');
    const selection = await dialog.showOpenDialog(win, { title: spec.name, properties: ['openFile'] });
    if (selection.canceled) return false;
    verify(event);
    await saveArchive(spec, createReadStream(selection.filePaths[0]), undefined, () => {});
    return true;
  });
  session.protocol.handle('ruyi-image', async (request) => {
    const spec = archives.get(request.url);
    if (
      !spec ||
      request.method !== 'GET' ||
      request.initiatorOrigin !== site ||
      !page(contents.getURL())
    )
      return new Response(null, { status: 403 });
    const headers = {
      'Access-Control-Allow-Origin': site,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Expose-Headers': 'X-Archive-Status',
    };
    try {
      let last = 0;
      headers['X-Archive-Status'] = await ensureArchive(spec, session.fetch.bind(session), request.signal, (phase, bytes) => {
        if (bytes && bytes < spec.size && Date.now() - last < 150) return;
        last = Date.now();
        if (!contents.isDestroyed()) contents.send('archive:progress', { name: spec.name, phase, bytes, total: spec.size });
      });
      return new Response(await openAsBlob(spec.file), { headers });
    } catch (error) {
      return new Response(error.message, { status: 502, headers });
    }
  });
  for (const name of ['will-navigate', 'will-redirect'])
    contents.on(name, (event, url) => {
      if (busy() || !page(url)) event.preventDefault();
    });
  function clearPageState() {
    targets.clear();
    choices.clear();
    flashing = false;
  }
  contents.on('did-navigate', clearPageState);
  contents.on('render-process-gone', clearPageState);
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && !page(url)) clearPageState();
  });
  win.on('close', (event) => {
    if (busy()) event.preventDefault();
  });

  ipcMain.handle('flashing', (event, active) => {
    verify(event);
    flashing = active === true;
  });
  ipcMain.handle('disk:list', async (event) => {
    verify(event);
    if (busy()) throw Error('Invalid disk selection');
    operating = true;
    try {
      const available = await disks.list(writer);
      verify(event);
      return choices.replace(available);
    } finally {
      operating = false;
    }
  });
  ipcMain.handle('disk:choose', async (event, slot, id) => {
    verify(event);
    if (busy() || typeof slot !== 'string' || slot.length > 128)
      throw Error('Invalid disk selection');
    const selected = choices.take(id);
    if (!selected) throw Error('Selected disk is no longer available');
    operating = true;
    try {
      const available = await disks.list(writer);
      verify(event);
      const current = available.find((disk) => disk.id === selected.id);
      if (!current) throw Error('Selected disk is no longer available');
      const token = randomUUID();
      if (targets.size >= 128) targets.clear();
      targets.set(token, current);
      return { id: token, label: current.label };
    } finally {
      operating = false;
    }
  });
  ipcMain.handle('disk:write', async (event, token, image) => {
    verify(event);
    const target = targets.get(token);
    if (
      !target ||
      !flashing ||
      operating ||
      !validImage(image) ||
      image.size > target.capacity
    )
      throw Error('Invalid disk or image');
    operating = true;
    try {
      await withStagedImage(contents, app.getPath('userData'), image, async source => {
        verify(event);
        try {
          await disks.write(writer, {
            Disk: target.id,
            Source: source,
            Size: image.size,
            SHA256: image.sha256,
          });
        } catch (error) {
          if (error.code === 124)
            throw Error(
              words(
                '写盘操作超时。请检查目标磁盘并重新完整刷写。',
                'Disk operation timed out. Check the target disk and retry the full write.',
                'Zeitüberschreitung beim Datenträgerzugriff. Prüfen Sie das Ziellaufwerk und wiederholen Sie den gesamten Schreibvorgang.',
              ),
            );
          throw Error(
            error.stderr?.trim().slice(-2048) ||
              `Disk writer exited (${error.code})`,
          );
        }
      });
    } finally {
      operating = false;
    }
  });
  async function loadPage(url) {
    try {
      await win.loadURL(url);
    } catch (error) {
      if (error.code !== 'ERR_ABORTED' && error.errno !== -3)
        dialog.showErrorBox('Ruyi Imager', error.message);
    }
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      {
        label: 'Ruyi Imager',
        submenu: [{ role: 'quit' }],
      },
      { role: 'editMenu' },
    ]),
  );
  await loadPage(`${site}/index.html`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app
    .whenReady()
    .then(openApp)
    .catch((error) => {
      dialog.showErrorBox('Ruyi Imager', error.message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
}
