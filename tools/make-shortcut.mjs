// 生成「启动 Hostbound」快捷方式（双击就能启动，图标是系统核心）。
// 用法：npm run shortcut（放在项目文件夹里）；加 --desktop 放到桌面；加 --startup 放进开机启动
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) {
  console.error('还没装依赖：先运行 npm install');
  process.exit(1);
}
const places = [root];
if (process.argv.includes('--desktop')) places.push(path.join(os.homedir(), 'Desktop'));
if (process.argv.includes('--startup')) places.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'));
for (const dir of places) {
  const lnk = path.join(dir, '启动 Hostbound.lnk');
  // 路径从环境变量传进去，免得引号、中文出问题
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:HB_LNK); $s.TargetPath = $env:HB_EXE; $s.Arguments = \'"\' + $env:HB_ROOT + \'"\'; $s.WorkingDirectory = $env:HB_ROOT; $s.IconLocation = $env:HB_ICON + \',0\'; $s.Save()',
    ],
    { env: { ...process.env, HB_LNK: lnk, HB_EXE: electron, HB_ROOT: root, HB_ICON: path.join(root, 'app', 'icon.ico') }, stdio: 'inherit' },
  );
  console.log(`✓ ${lnk}`);
}
