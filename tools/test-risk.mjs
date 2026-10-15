// 危险命令识别的正反例：node tools/test-risk.mjs
import { assessRisk } from '../brain/agent.mjs';

const ps = (command) => assessRisk({ toolName: 'powershell', input: { command } }, 'C:/tmp');
const SAFE = [
  "Get-Date -Format 'yyyy-MM-dd'",
  'Start-Process notepad',
  'Start-Process "https://www.bilibili.com"',
  'Get-ChildItem $env:USERPROFILE\\Desktop -Filter *.png',
  "Get-ChildItem | Where-Object Name -like 'del*'",
  'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-ChildItem "D:\\workspace"',
  'Get-Content C:\\a.txt 2>$null',
  'Get-Item x *>$null',
  "Start-Process 'C:\\Program Files\\rm\\app.exe'",
  'Get-ChildItem | Where-Object { $_.Length -gt 1MB }',
  'Test-Path C:\\x; Resolve-Path .',
];
const DANGER = [
  'Remove-Item C:\\x.txt',
  'Get-ChildItem *.tmp | ForEach-Object { Remove-Item $_ }',
  'rm -r -fo C:\\junk',
  'cmd /c del /q C:\\x',
  'Start-Process powershell -ArgumentList "Remove-Item C:\\x"',
  'format d: /q',
  'Stop-Computer',
  'shutdown /s /t 0',
  'taskkill /im obs64.exe /f',
  'reg add HKCU\\Software\\X /v a /d 1',
  'Set-ExecutionPolicy Bypass',
  'Start-Process cmd -Verb RunAs',
  'git push origin main',
  'winget install OBSProject.OBSStudio',
  'Invoke-WebRequest https://x/y.exe -OutFile y.exe',
  'Move-Item a.txt b.txt',
  'Set-Content C:\\a.txt hi',
  'Get-Process > C:\\procs.txt',
  'New-Item C:\\a.txt -Force',
  'powershell -enc ZQBjAGgAbwA=',
  '& "C:\\tools\\do.ps1"',
  '.\\setup.bat',
];

let bad = 0;
for (const c of SAFE) {
  const r = ps(c);
  if (r) {
    bad++;
    console.log('误报  ', c, '→', r.label);
  }
}
for (const c of DANGER) {
  const r = ps(c);
  if (!r) {
    bad++;
    console.log('漏报  ', c);
  } else console.log('拦下  ', r.label.padEnd(12), c);
}
console.log(bad ? `\n${bad} 个不对` : '\n全部正确');
process.exit(bad ? 1 : 0);
