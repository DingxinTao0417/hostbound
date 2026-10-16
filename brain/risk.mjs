// 危险操作识别：系统的大脑、项目模式里干活的智能体、Claude Code 的钩子都用这一份
import fs from 'node:fs';
import path from 'node:path';

// ---- 危险操作识别 ----
// 只匹配出现在“命令位置”的词（行首、空格、; | & ( { 或引号之后），这样 Get-Date -Format 里的 -Format 不会被当成 format 命令。
// 这是一道提醒用的网，不是沙箱：绕得过去的写法肯定有。
const cmd = (names, rest = '') => new RegExp(`(?:^|[\\s;|&({'"])(?:cmd(?:\\.exe)?\\s+/c\\s+)?(?:${names})(?:\\.exe)?${rest}(?=$|[\\s;|&)}'"])`, 'im');
const DANGER = [
  [cmd('Remove-Item|rm|rmdir|rd|del|erase|ri|Clear-RecycleBin'), '删除文件'],
  [cmd('Format-Volume|format\\s+[a-z]:|diskpart|Clear-Disk|Initialize-Disk|Remove-Partition'), '格式化磁盘'],
  [cmd('Stop-Computer|Restart-Computer|shutdown|logoff'), '关机或重启'],
  [cmd('Stop-Process|taskkill|kill|spps'), '结束程序'],
  [cmd('reg', '\\s+(?:add|delete|import)'), '修改注册表'],
  [cmd('Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|sp'), '修改注册表或文件属性'],
  [cmd('Set-ExecutionPolicy|bcdedit|netsh|schtasks|Set-Service|New-Service|Set-MpPreference|Add-MpPreference|(?:Enable|Disable)-\\w+'), '修改系统设置'],
  [cmd('sc', '\\s+(?:config|delete|stop|create)'), '修改系统服务'],
  [/-Verb\s+RunAs|(?:^|[\s;|&])g?sudo\s/im, '用管理员权限运行'],
  [cmd('git', '\\s+(?:push|reset\\s+--hard|clean|checkout\\s+--|branch\\s+-D)'), 'git 危险操作'],
  [cmd('winget|choco|scoop|npm|pnpm|yarn|pip3?|uv|cargo|Install-Module|Install-Package', '(?:\\s+(?:install|uninstall|i|add|remove|publish))?'), '安装或卸载软件'],
  [cmd('Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|Start-BitsTransfer'), '联网下载或上传'],
  [cmd('Move-Item|mv|move|mi|Rename-Item|ren|rni|Copy-Item|cp|copy|cpi|robocopy|xcopy'), '移动、复制或改名文件'],
  [cmd('Set-Content|sc|Clear-Content|clc|Out-File|Add-Content|ac'), '写入文件'],
  [cmd('New-Item|ni', '[^;|\\n]*-Force'), '强制新建（可能覆盖）文件'],
  [/(?:^|[^\d*-])>{1,2}(?!\s*\$null)/m, '把输出写进文件'],
  [cmd('Send-MailMessage'), '发邮件'],
  [/-(?:EncodedCommand|enc|ec)\s|(?:^|[\s;|&({'"])(?:iex|Invoke-Expression)(?=$|[\s;|&)(])/im, '执行看不清内容的命令'],
  [/(?:^|[\s;|&({'"])[^\s'";|&]*\.(?:ps1|bat|cmd|vbs|wsf)(?=$|[\s'";|&)])/im, '运行脚本文件'],
];

export function isInside(p, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assessRisk(event, workdir) {
  const input = event.input || {};
  if (event.toolName === 'powershell' || event.toolName === 'bash') {
    const cmd = String(input.command || '');
    for (const [re, label] of DANGER) if (re.test(cmd)) return { label, detail: cmd };
    return null;
  }
  if (event.toolName === 'write' || event.toolName === 'edit') {
    const file = path.resolve(workdir, String(input.path || input.file_path || ''));
    if (event.toolName === 'write' && fs.existsSync(file)) return { label: '覆盖已有文件', detail: file };
    if (event.toolName === 'edit' && !isInside(file, workdir)) return { label: '修改文件', detail: file };
  }
  return null;
}
