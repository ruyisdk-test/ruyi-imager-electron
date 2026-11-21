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
const path = require('node:path');
const { DiskChoices } = require('./disk-choice.cjs');
const { site, page, download, validImage } = require('./policy.cjs');
const disks = require('./writer.cjs');

protocol.registerSchemesAsPrivileged([
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
  const targets = new Map();
  const choices = new DiskChoices();
  const directories = new Set();
  const mirrorRequests = new Map();
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
    const url = new URL(contents.getURL() || site);
    return url.pathname.startsWith('/en/')
      ? en
      : url.pathname.startsWith('/de/')
        ? de
        : zh;
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
  const allowed = new Set(['usb', 'fileSystem', 'clipboard-sanitized-write']);
  function filePermission(details, requested = false) {
    if (details.fileAccessType === 'readable') return true;
    const file = details.filePath;
    if (
      details.fileAccessType !== 'writable' ||
      typeof file !== 'string' ||
      !path.isAbsolute(file)
    )
      return false;
    if (requested && details.isDirectory) {
      directories.add(file);
      return true;
    }
    for (const root of directories) {
      const relative = path.relative(root, file);
      if (
        !path.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`)
      )
        return true;
    }
    return false;
  }
  session.setPermissionCheckHandler((sender, permission, origin, details) => {
    if (
      (sender && sender !== contents) ||
      (origin !== site && origin !== `${site}/`) ||
      !page(contents.getURL()) ||
      !allowed.has(permission)
    )
      return false;
    if (permission === 'fileSystem') return filePermission(details);
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
        (details.isMainFrame || permission === 'fileSystem');
      callback(
        grant && (permission !== 'fileSystem' || filePermission(details, true)),
      );
    },
  );
  session.on('file-system-access-restricted', (_event, details, callback) => {
    if (!trusted(details.frame)) {
      callback('deny');
      return;
    }
    const message = words(
      '此位置受保护。请选择其他位置，例如下载目录中新建的子目录。',
      'This location is protected. Choose another location, such as a new folder inside Downloads.',
      'Dieser Speicherort ist geschützt. Wählen Sie einen anderen Ort, zum Beispiel einen neuen Ordner unter Downloads.',
    );
    void pick(
      `${message}\n\n${details.path}`,
      [words('重新选择', 'Choose again', 'Erneut auswählen')],
    ).then(
      (choice) =>
        callback(choice === 0 && trusted(details.frame) ? 'tryAgain' : 'deny'),
      () => callback('deny'),
    );
  });
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
  ipcMain.handle('mirror:url', (event, url) => {
    verify(event);
    if (typeof url !== 'string' || !download(url)) throw Error('Invalid mirror');
    if (mirrorRequests.size >= 16)
      mirrorRequests.delete(mirrorRequests.keys().next().value);
    const ticket = `ruyi-image://download/${randomUUID()}`;
    mirrorRequests.set(ticket, url);
    return ticket;
  });
  session.protocol.handle('ruyi-image', async (request) => {
    const url = mirrorRequests.get(request.url);
    if (
      !url ||
      request.method !== 'GET' ||
      request.initiatorOrigin !== site ||
      !page(contents.getURL())
    )
      return new Response(null, { status: 403 });
    mirrorRequests.delete(request.url);
    const headers = {
      'Access-Control-Allow-Origin': site,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    };
    try {
      const response = await session.fetch(url, {
        signal: request.signal,
        credentials: 'omit',
      });
      if (!response.ok) await response.body?.cancel();
      return new Response(response.ok ? response.body : null, {
        status: response.status,
        headers,
      });
    } catch {
      return new Response(null, { status: 502, headers });
    }
  });
  for (const name of ['will-navigate', 'will-redirect'])
    contents.on(name, (event, url) => {
      if (busy() || !page(url)) event.preventDefault();
    });
  function clearPageState() {
    mirrorRequests.clear();
    targets.clear();
    choices.clear();
    directories.clear();
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
  ipcMain.handle('disk:select', async (event, slot) => {
    verify(event);
    if (busy() || typeof slot !== 'string' || slot.length > 128)
      throw Error('Invalid disk selection');
    operating = true;
    try {
      for (;;) {
        const available = await disks.list(writer);
        verify(event);
        if (!available.length) {
          const retry = await pick(
            words(
              '请插入可移动磁盘或 SD 读卡器。',
              'Insert a removable disk or SD reader.',
              'Wechseldatenträger oder SD-Leser anschließen.',
            ),
            [words('刷新', 'Refresh', 'Aktualisieren')],
          );
          if (retry < 0) return null;
          continue;
        }
        const index = await pick(
          `${words('选择目标磁盘', 'Select target disk', 'Ziellaufwerk auswählen')} (${slot})`,
          available.map((disk) => disk.label),
        );
        verify(event);
        if (index < 0) return null;
        const id = randomUUID();
        if (targets.size >= 128) targets.clear();
        targets.set(id, available[index]);
        return { id, label: available[index].label };
      }
    } finally {
      operating = false;
    }
  });
  async function imagePath(image) {
    for (const root of directories) {
      if (path.basename(root) !== image.directory) continue;
      const candidate = path.join(root, ...image.parts);
      try {
        const [canonical, parent, info] = await Promise.all([
          fs.realpath(candidate),
          fs.realpath(root),
          fs.stat(candidate),
        ]);
        if (
          canonical === path.join(parent, ...image.parts) &&
          info.isFile() &&
          info.size === image.size
        )
          return canonical;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const filename = image.parts.at(-1);
    const { filePaths } = await dialog.showOpenDialog(win, {
      title: `${words('选择解包后的镜像', 'Select the extracted image', 'Entpacktes Abbild auswählen')} · ${filename}`,
      properties: ['openFile'],
    });
    if (!filePaths.length) throw Error(cancel());
    if (path.basename(filePaths[0]) !== filename)
      throw Error(`Expected ${filename}`);
    return filePaths[0];
  }
  ipcMain.handle('disk:write', async (event, token, image) => {
    verify(event);
    const target = targets.get(token);
    if (
      !target ||
      operating ||
      !validImage(image) ||
      image.size > target.capacity
    )
      throw Error('Invalid disk or image');
    operating = true;
    try {
      const source = await imagePath(image);
      await fs.access(source, require('node:fs').constants.R_OK);
      verify(event);
      const accepted = await pick(
        `${words('覆盖整盘数据？', 'Overwrite all data on this disk?', 'Alle Daten auf diesem Laufwerk überschreiben?')}\n\n${source}\n→ ${target.label}`,
        [words('写入并校验', 'Write and verify', 'Schreiben und prüfen')],
      );
      if (accepted < 0) throw Error(cancel());
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
  function navigate(route) {
    if (busy()) return;
    const current = new URL(contents.getURL() || site);
    const prefix = /^\/(en|de)\//.exec(current.pathname)?.[0] || '/';
    void loadPage(`${site}${prefix}tryruyi/${route}`);
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      {
        label: 'Ruyi Imager',
        submenu: [
          { label: 'Imager', click: () => navigate('imager') },
          { label: 'Device Provision', click: () => navigate('device') },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
    ]),
  );
  await loadPage(`${site}/tryruyi/imager`);
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
