// 项目模式的 git：项目文件夹是一个 git 仓库，主线（main）只由总指挥动。
// 每个干活的在 .hostbound\worktrees\名字 里一份副本（git worktree，分支 hb/任务）；做完由系统提交，
// 在 .hostbound\worktrees\_merge 里合并、检查，检查过了主线才往前走（fast-forward），所以主线上永远是检查过的。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 系统替宿主提交时用的身份（不改宿主的 git 配置）
const ID = ['-c', 'user.name=Hostbound', '-c', 'user.email=hostbound@localhost', '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true'];
const IGNORE = ['.hostbound/', 'node_modules/', 'dist/', '.env', '.env.*', '*.log'];

export function git(cwd, args, { timeoutMs = 120_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...ID, ...args], { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = { ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      if (err && !allowFail) {
        const e = new Error(`git ${args.join(' ')} 失败：${(out.stderr || out.stdout || err.message).trim().split('\n').slice(-3).join(' ')}`);
        e.result = out;
        return reject(e);
      }
      resolve(out);
    });
  });
}

const slug = (s) => String(s || 'x').replace(/[^\w一-鿿-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
export const branchOf = (taskId) => `hb/${slug(taskId)}`;
export const worktreesDir = (dir) => path.join(dir, '.hostbound', 'worktrees');

// 项目文件夹变成 git 仓库（已经是就不动），.hostbound 等加进 .gitignore，第一次提交
export async function ensureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const isRepo = fs.existsSync(path.join(dir, '.git'));
  if (!isRepo) await git(dir, ['init', '-b', 'main']);
  const gi = path.join(dir, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = IGNORE.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (missing.length) fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  await git(dir, ['add', '-A']);
  const head = await git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (!head.ok) await git(dir, ['commit', '-m', '项目开始', '--allow-empty']);
  else {
    const st = await git(dir, ['status', '--porcelain']);
    if (st.stdout.trim()) await git(dir, ['commit', '-m', '开工前的文件']);
  }
  const main = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  return { main, head: (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim() };
}

export async function headOf(dir, ref = 'HEAD') {
  return (await git(dir, ['rev-parse', ref])).stdout.trim();
}

// 给一个任务开一份副本：从主线当前的样子开分支
export async function addWorktree(dir, name, taskId, base = 'HEAD') {
  const wt = path.join(worktreesDir(dir), slug(name));
  const branch = branchOf(taskId);
  if (fs.existsSync(wt)) await removeWorktree(dir, wt, null);
  await git(dir, ['worktree', 'prune'], { allowFail: true });
  await git(dir, ['branch', '-D', branch], { allowFail: true });
  await git(dir, ['worktree', 'add', '-b', branch, wt, base]);
  return { wt, branch };
}

// 副本里改了的都提交（系统替它提交）；返回有没有改东西
export async function commitAll(wt, message) {
  await git(wt, ['add', '-A']);
  const st = await git(wt, ['status', '--porcelain']);
  if (!st.stdout.trim()) return false;
  await git(wt, ['commit', '-m', message]);
  return true;
}

// 这个分支比主线多改了哪些文件
export async function changedFiles(dir, branch, base = 'HEAD') {
  const r = await git(dir, ['diff', '--name-only', `${base}...${branch}`], { allowFail: true });
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// 在合并用的副本里试着把分支合进主线：成功返回合好的 commit（主线还没动）；冲突就放弃这次合并
export async function tryMerge(dir, branch, message) {
  const mw = path.join(worktreesDir(dir), '_merge');
  const main = await headOf(dir);
  if (!fs.existsSync(path.join(mw, '.git'))) {
    await git(dir, ['worktree', 'prune'], { allowFail: true });
    if (fs.existsSync(mw)) fs.rmSync(mw, { recursive: true, force: true });
    await git(dir, ['worktree', 'add', '--detach', mw, main]);
  } else {
    await git(mw, ['merge', '--abort'], { allowFail: true });
    await git(mw, ['checkout', '--detach', main]);
    await git(mw, ['reset', '--hard', main]);
    // 合并副本里检查留下的东西（编译结果之类）清掉，但留着装好的依赖
    await git(mw, ['clean', '-fd', '-e', 'node_modules'], { allowFail: true });
  }
  const r = await git(mw, ['merge', '--no-ff', '-m', message, branch], { allowFail: true });
  if (!r.ok) {
    const conflicts = (await git(mw, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    await git(mw, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflict: conflicts.length > 0, files: conflicts, output: (r.stdout + r.stderr).trim().slice(-1500), mw };
  }
  return { ok: true, commit: await headOf(mw), mw };
}

// 检查过了：主线往前走到合好的 commit（宿主自己在主线上改了东西、走不了就报错）
export async function advanceMain(dir, commit) {
  const r = await git(dir, ['merge', '--ff-only', commit], { allowFail: true });
  if (!r.ok) throw new Error(`主线没法直接往前走（可能宿主在项目文件夹里改了东西）：${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  return headOf(dir);
}

// 收掉一份副本（先 git worktree remove，不行再删文件夹；不跟着目录链接删到别处）
export async function removeWorktree(dir, wt, branch) {
  const r = await git(dir, ['worktree', 'remove', '--force', wt], { allowFail: true });
  if (!r.ok && fs.existsSync(wt)) {
    // node_modules 里可能有目录链接（pnpm）：先把链接本身删掉，不进去
    const unlinkJunctions = (d, depth = 0) => {
      if (depth > 6) return;
      let es = [];
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) {
          try {
            fs.unlinkSync(p);
          } catch {
            try {
              fs.rmdirSync(p);
            } catch {}
          }
        } else if (e.isDirectory()) unlinkJunctions(p, depth + 1);
      }
    };
    unlinkJunctions(wt);
    fs.rmSync(wt, { recursive: true, force: true });
    await git(dir, ['worktree', 'prune'], { allowFail: true });
  }
  if (branch) await git(dir, ['branch', '-D', branch], { allowFail: true });
}

// 从某个 commit 到现在一共改了多少（完成卡、评审用）
export async function diffStat(dir, from, to = 'HEAD') {
  const r = await git(dir, ['diff', '--shortstat', from, to], { allowFail: true });
  return r.stdout.trim();
}
export async function diffText(dir, from, to = 'HEAD', max = 60_000) {
  const r = await git(dir, ['diff', from, to, '--', '.', ':(exclude)package-lock.json', ':(exclude)pnpm-lock.yaml', ':(exclude)yarn.lock'], { allowFail: true });
  return r.stdout.length > max ? r.stdout.slice(0, max) + '\n…（太长，后面省略）' : r.stdout;
}
export async function fileTree(dir, max = 300) {
  const r = await git(dir, ['ls-files'], { allowFail: true });
  const files = r.stdout.split('\n').filter(Boolean);
  return files.length > max ? [...files.slice(0, max), `…还有 ${files.length - max} 个文件`] : files;
}
