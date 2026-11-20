const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const execute = promisify(execFile);

async function list(writer) {
  const { stdout } = await execute(writer, ['list'], {
    timeout: 30000,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function write(writer, request) {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64url');
  if (process.platform === 'linux') {
    await execute('/usr/bin/pkexec', [writer, 'write', encoded]);
  } else if (process.platform === 'darwin') {
    const script =
      'on run argv\n do shell script ((quoted form of item 1 of argv) & " write " & (quoted form of item 2 of argv)) with administrator privileges\nend run';
    await execute('/usr/bin/osascript', ['-e', script, writer, encoded]);
  } else {
    const shell = path.join(
      process.env.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const script =
      "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:RUYI_WRITER -ArgumentList @('write',$env:RUYI_REQUEST) -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
    await execute(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        env: { ...process.env, RUYI_WRITER: writer, RUYI_REQUEST: encoded },
      },
    );
  }
}
module.exports = { list, write };
