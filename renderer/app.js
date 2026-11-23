import { FastbootSession } from './device/fastboot.js';
import { flashPackages } from './device/provision.js';
import { ProvisionRuntime } from './device/runtime.js';

const byId = (id) => document.getElementById(id);
const chinese = navigator.language.toLowerCase().startsWith('zh');
const text = (zh, en) => chinese ? zh : en;
const locale = chinese ? 'zh_CN' : 'en_US';
if (chinese) {
  document.documentElement.lang = 'zh-Hans';
  for (const item of document.querySelectorAll('[data-zh]')) item.textContent = item.dataset.zh;
}

function log(message) {
  const output = byId('log');
  const plain = String(message).replace(/\[(?:\/|(?:bold )?(?:green|yellow|red|cyan|blue)|bold)\]/g, '');
  output.append(document.createTextNode(`${plain}\n`));
  output.scrollTop = output.scrollHeight;
}

function options(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
}

function prompt(title, signal, actions, controls = []) {
  signal.throwIfAborted();
  const panel = byId('prompt');
  const heading = document.createElement('p');
  heading.textContent = title;
  panel.replaceChildren(heading, ...controls);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      panel.replaceChildren();
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    for (const [label, action] of actions) {
      const button = document.createElement('button');
      button.textContent = label;
      button.onclick = async () => {
        for (const item of panel.querySelectorAll('button')) item.disabled = true;
        try {
          const result = await action();
          signal.throwIfAborted();
          cleanup();
          resolve(result);
        } catch (error) {
          if (signal.aborted) return;
          if (error.name !== 'AbortError') log(error.message);
          for (const item of panel.querySelectorAll('button')) item.disabled = false;
        }
      };
      panel.append(button);
    }
  });
}

async function run(catalog, combo, selected) {
  const controller = new AbortController();
  const { signal } = controller;
  const reconnect = byId('reconnect');
  const cancel = byId('cancel');
  const ask = (...args) => prompt(args[0], signal, ...args.slice(1));
  let writing = false;
  const usb = new FastbootSession(() => {
    reconnect.hidden = !(writing && usb.acceptSelection && !usb.device?.opened);
    reconnect.disabled = usb.selecting;
  }, log, signal);
  const runtime = new ProvisionRuntime('/static/', log, signal);
  cancel.hidden = false;
  cancel.onclick = () => controller.abort(new DOMException(text('已取消', 'Cancelled'), 'AbortError'));
  reconnect.onclick = () => usb.select().catch(error => log(error.message));
  const ui = {
    log,
    confirm: title => ask(title, [
      [text('取消', 'Cancel'), () => false], [text('确认', 'Confirm'), () => true],
    ]),
    localFile: (spec, archiveURL) => {
      const links = spec.resolved_urls.flatMap(value => {
        const url = URL.parse(value);
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = url.host;
        return [link];
      });
      return ask(`${text('选择本地文件', 'Choose a local file')} · ${spec.name}`, [
        [text('选择文件', 'Choose file'), async () => {
          if (!await window.ruyiImager.importArchive(archiveURL)) throw new DOMException('Cancelled', 'AbortError');
        }],
      ], links);
    },
    progress: value => {
      byId('transfer').textContent = value ? `${value.phase} · ${value.name} · ${value.percent !== undefined ? `${value.percent}%` : `${value.bytes} / ${value.total} B`}` : '';
    },
    device: () => ask(text('连接目标 Fastboot 开发板。', 'Connect the target Fastboot board.'), [
      [text('连接开发板', 'Connect board'), () => usb.select()],
    ]),
    selectDisk: async slot => {
      for (;;) {
        const disks = await window.ruyiImager.listDisks();
        const select = document.createElement('select');
        select.setAttribute('aria-label', slot);
        options(select, disks.map(disk => [disk.id, disk.label]));
        const actions = [[text('刷新', 'Refresh'), () => null]];
        if (disks.length) actions.push([text('选择磁盘', 'Select disk'), () => window.ruyiImager.chooseDisk(slot, select.value)]);
        const disk = await ask(`${text('目标磁盘', 'Target disk')} · ${slot}`, actions, [select]);
        if (disk) return disk;
      }
    },
    flashing: () => { writing = true; cancel.hidden = true; },
  };
  try {
    await runtime.warmup();
    signal.throwIfAborted();
    if (selected.length && !await flashPackages(selected, catalog, { runtime, usb, ui, signal, locale })) {
      log(text('已取消', 'Cancelled'));
      return;
    }
    if (combo.postinst_msgid) log(await runtime.run({ kind: 'message', id: combo.postinst_msgid, text: catalog.messages, locale }));
  } finally {
    runtime.dispose();
    await usb.dispose();
    reconnect.hidden = cancel.hidden = true;
    byId('transfer').textContent = '';
    byId('prompt').replaceChildren();
  }
}

async function start() {
  const response = await fetch('./static/catalog.json');
  if (!response.ok) throw Error(`Catalog: ${response.status}`);
  const catalog = await response.json();
  if (!window.ruyiImager) throw Error('Desktop bridge unavailable');
  const { device: boards, 'device-variant': variants, 'image-combo': images } = catalog.entities;
  const board = byId('board'), variant = byId('variant'), image = byId('image');
  const prepare = byId('prepare'), versions = byId('versions');
  const sorted = entries => entries.sort((left, right) => left[1].localeCompare(right[1]));
  byId('release').textContent = `packages-index · ${catalog.release}`;
  options(board, sorted(Object.entries(boards).map(([id, row]) => [id, row.display_name])));
  function updateVersions() {
    versions.replaceChildren();
    const combo = images[image.value];
    prepare.disabled = !combo;
    for (const atom of combo?.package_atoms ?? []) {
      const label = document.createElement('label');
      label.textContent = atom;
      const select = document.createElement('select');
      const group = catalog.packages[atom] ?? [];
      options(select, group.map((pkg, index) => [index, pkg.version]));
      select.selectedIndex = Math.max(0, group.findIndex(pkg => !pkg.version.split('+')[0].includes('-')));
      if (!group.length) prepare.disabled = true;
      label.append(select);
      versions.append(label);
    }
    prepare.textContent = combo && !combo.package_atoms.length ? text('查看说明', 'View instructions') : text('准备镜像', 'Prepare image');
  }
  function updateImages() {
    options(image, sorted(Object.entries(images).filter(([, row]) => row.related.includes(`device-variant:${variant.value}`)).map(([id, row]) => [id, row.display_name])));
    updateVersions();
  }
  function updateVariants() {
    options(variant, sorted(Object.entries(variants).filter(([id]) => boards[board.value].related.includes(`device-variant:${id}`)).map(([id, row]) => [id, row.variant_name ?? row.display_name ?? id])));
    updateImages();
  }
  board.onchange = updateVariants;
  variant.onchange = updateImages;
  image.onchange = updateVersions;
  updateVariants();
  byId('selection').disabled = false;
  prepare.onclick = async () => {
    const combo = images[image.value];
    const selected = [...versions.querySelectorAll('select')].map((select, index) => catalog.packages[combo.package_atoms[index]][select.value]);
    byId('selection').disabled = true;
    byId('log').replaceChildren();
    log([boards[board.value].display_name, variants[variant.value].variant_name, combo.display_name].join(' · '));
    try { await run(catalog, combo, selected); }
    catch (error) { log(error.message ?? String(error)); }
    finally { byId('selection').disabled = false; }
  };
}

start().catch(error => log(error.message));
