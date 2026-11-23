import { diskCommand } from './disk.js';
import { packageFastboot } from './spacemit.js';
import { prepareImages } from './storage.js';

export async function flashPackages(selected, catalog, { runtime, usb, ui, signal, locale }) {
  const t = (zh, en) => (locale === 'zh_CN' ? zh : en);
  const { log, confirm } = ui;
  const usesFastboot = selected.some(
    (pkg) => pkg.data.provisionable.strategy !== 'dd-v1',
  );
  const root = await navigator.storage.getDirectory();
  const plans = [];
  const disks = new Map();
  const host = window.ruyiImager;
  const prepared = [];
  for (const pkg of selected) {
    const description = `${pkg.package} ${pkg.version} (${pkg.data.provisionable.strategy})`;
    log(description);
    const files = await prepareImages(pkg, {
      root,
      runtime,
      signal,
      log,
      localFile: ui.localFile,
      progress: ui.progress,
    });
    prepared.push({ pkg, files, description });
  }
  for (const { pkg, files, description } of prepared) {
    const { strategy, partition_map: paths } = pkg.data.provisionable;
    const targets = Object.create(null);
    if (strategy === 'dd-v1') {
      for (const slot of Object.keys(paths)) {
        if (!disks.has(slot)) {
          signal.throwIfAborted();
          const target = await ui.selectDisk(slot);
          disks.set(slot, target);
        }
        targets[slot] = disks.get(slot);
      }
    }
    const args = {
      strategy,
      paths,
      blockDevices: Object.fromEntries(
        Object.entries(targets).map(([key, target]) => [key, target.label]),
      ),
      modules: catalog.modules,
      messages: catalog.messages,
      locale,
    };
    const plan = await runtime.run({ kind: 'preview', ...args });
    const execute =
      strategy === 'dd-v1'
        ? diskCommand({
            paths,
            targets,
            files,
            host,
            runtime,
            signal,
            log,
          })
        : await packageFastboot(usb, runtime, strategy, paths, files);
    plans.push({ ...plan, args, execute, description });
  }
  plans.sort((left, right) => right.priority - left.priority);
  const steps = plans.flatMap((plan) => plan.steps);
  log(t('请核对目标设备和以下刷写步骤：', 'Review the target and the flashing steps:'));
  for (const step of steps) log(`  • ${step}`);
  if (usesFastboot) {
    await ui.device();
    log(`${t('目标', 'Target')}: ${usb.label}`);
  }
  const target = usb.device;
  if (
    !(await confirm(
      t(
        '执行上述刷写操作？此操作会覆盖目标设备上的数据。',
        'Proceed with flashing? This overwrites data on the selected device.',
      ),
    ))
  )
    return;
  if (
    usesFastboot &&
    !(await confirm(
      t(
        '确认 fastboot 识别的是要刷写的这块开发板？',
        'Is the selected fastboot device the correct board?',
      ),
    ))
  )
    return;
  if (usesFastboot) {
    usb.acceptSelection = false;
    usb.confirmTarget(target, (label) =>
      confirm(
        t(
          `重连后检测到新的 USB 设备 ${label}。确认这是同一块开发板，并继续写入？`,
          `USB reconnected as ${label}. Confirm this is the same board and resume flashing?`,
        ),
      ),
    );
    usb.changed();
  }
  ui.flashing();
  await host.setFlashing(true);
  try {
    for (const plan of plans) {
      log(plan.description);
      await runtime.run(
        { kind: 'flash', ...plan.args, snapshot: plan.snapshot },
        plan.execute,
      );
    }
  } finally {
    await host.setFlashing(false);
  }
  log(t('刷写步骤成功完成。', 'Flashing finished successfully.'));
  return true;
}
