// 读取 hostbound.config.json，没写的项用默认值
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = {
  // 系统的大脑。provider/id 见 README 里的模型表；对应的 API key 用环境变量提供
  model: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'low' },
  // 系统干活时的默认目录
  workdir: path.join(os.homedir(), 'Desktop'),
  // 系统报时用的时区，例如 "Asia/Shanghai"；留空就用电脑的系统时区
  timezone: '',
  voice: {
    wakeEnabled: true,
    // tokens：每个字拆成“声母 + 带声调的韵母”，空格隔开（零声母的字只写韵母）
    wakeWords: [{ text: '系统启动', tokens: 'x ì t ǒng q ǐ d òng' }],
    stopWords: [{ text: '系统停止', tokens: 'x ì t ǒng t íng zh ǐ' }],
    kwsThreshold: 0.25,
    kwsScore: 1.5,
    // 说完话后静音多久算一句结束（秒）
    endSilence: 0.8,
    // 叫醒后多久没开口就算了（毫秒）
    listenTimeoutMs: 7000,
    // 用哪个麦克风（设备名）；留空用系统默认的
    mic: '',
  },
  // 连续对话：叫醒一次后，醒着就一直听，不用每句都喊名字
  conversation: {
    enabled: true,
    // 多久没人说话就收起面板（毫秒）
    windowMs: 30000,
    // 醒着时听到的话先判断是不是对系统说的，不是就忽略
    filter: true,
    // 一直是同一段对话（重启后接着聊）。发给大脑的上下文超过这么多 token 时，把前面的压缩成摘要（原文留在存盘里，大脑能翻）
    contextBudget: 120000,
  },
  // 危险操作的确认框也能用嘴回答：「允许」「拒绝」「都允许」
  voiceConfirm: true,
  // 禁止系统操作的软件（窗口标题或程序名里包含这些词就不读、不点）
  safety: { blockedApps: [] },
  // 系统日志保留几天
  logKeepDays: 30,
  // 长期记忆（阶段 5）：enabled 关掉就暂停记新的（已经记下的照样用）；autoReview 自动整理（每 reviewEvery 轮对话、对话压缩前）；
  // embed 向量检索：硅基流动的 BAAI/bge-m3（密钥在设置里填，存 data/secrets.json；或者环境变量 SILICONFLOW_API_KEY），chat 以前的对话也算向量
  memory: { enabled: true, autoReview: true, reviewEvery: 10, embed: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', chat: true } },
  // 技能（阶段 6）：enabled 关掉就不用技能（口令不认、大脑看不到目录）；suggest 一条指令用了 minActions 个以上动作、或者宿主中途纠正过，对话里冒一行「要存成技能吗」
  skills: { enabled: true, suggest: true, minActions: 5 },
  // 自带的监测（阶段 4）：downloads 下载完成（downloadsDir 留空就是「下载」文件夹）、battery 电量低、
  // live 自动检测直播（liveApps 里的程序开着、或者 OBS 开始推流，就自动开直播模式）
  watch: { downloads: true, downloadsDir: '', battery: true, live: true, liveApps: ['livehime.exe', '直播伴侣.exe'] },
  // 操作软件界面，全部在后台进行（不抢鼠标键盘、不抢焦点）。两个引擎，对大脑只露出一套工具：
  // - cua：Cua Driver（trycua/cua，MIT），主引擎。读界面快、读得全；需要另外下载，放在 tools/cua-driver/
  // - command：Open Computer Use（npm 包 open-computer-use 自带），Cua 读不出东西或没装时自动换它
  computerUse: {
    enabled: true,
    cua: 'tools/cua-driver/cua-driver.exe',
    command: `node_modules/open-computer-use/dist/windows/${process.arch === 'arm64' ? 'arm64' : 'amd64'}/open-computer-use.exe`,
  },
  // 操作网页：agent-browser，用电脑上的 Chrome，但开系统专用的配置目录（登录状态单独保存，碰不到你日常 Chrome 里的账号）
  browser: {
    enabled: true,
    chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    profile: 'browser-profile',
    headed: true,
  },
  // 系统的声音。mode：gpu 用显卡上的 Qwen3-TTS（音质好、出声快，约占 4.6GB 显存，要另外装，见 README），cpu 用 ZipVoice（不占显卡、稍慢），off 不说话。
  // gpu 起不来（显存不够、Qwen3-TTS 配音工具正开着、没装）时自动换成 cpu，之后每分钟再试一次显卡。托盘菜单里也能切换。
  speech: {
    mode: 'cpu',
    // 系统音效强度：0 是原声，1 很重
    fx: 0.6,
    volume: 0.9,
    // 一条回复最多念多少字，后面的只显示在面板里
    maxChars: 60,
    // 戴耳机时可以打开：系统说话时也照样听你说话（外放时别开，麦克风会听到系统自己的声音）
    headphones: false,
    // url：已经单独跑着的声音服务地址（不填就由系统自己启动）
    // qwenHome：Qwen3-TTS 装在哪（模型在它的 models 下面），留空就是 voice/qwen3-tts
    gpu: { python: 'voice/.venv/Scripts/python.exe', qwenHome: '', port: 5181, url: '' },
    cpu: { port: 5182, threads: 4, url: '' },
  },
  // 操作看得见：扫描框、系统光标、输入字幕、全屏通知。enabled 总开关；cursor 系统光标（关掉后点击不再等光标飞过去，更快）；
  // notice 干完活弹的全屏通知（直播模式或有全屏程序时只弹角落小提示）
  fx: { enabled: true, cursor: true, notice: true },
  // 讲东西（画图讲解、就地讲解、手把手教学）。selfCheck：画完截图让模型看一眼有没有画歪、字挤在一起；
  // model：画图用的模型，写成 "provider/id"，留空就跟聊天用同一个
  explain: { selfCheck: true, model: '' },
  // pushToTalk：按住说话，松开就发。Mouse4 / Mouse5 是鼠标侧键（Mouse5 一般是靠前的「前进」键），也可以写 RightCtrl、RightAlt、F8 这类键名
  hotkeys: { wake: 'Control+Alt+T', stop: 'Control+Alt+X', appraise: 'Control+Alt+J', pushToTalk: ['Mouse5', 'RightCtrl'] },
  // 系统核心图标多大、系统面板默认多大，单位像素。拖动和 Ctrl+滚轮改过的大小会记住，优先于这里。
  // sound：唤醒、完成、需要授权时的提示音
  // panelOpacity：面板底板的不透明度，1 是完全不透明，越小越透（默认 0.78，叠上内框后约 0.82）
  // boot：开机时放一遍自检动画
  ui: { petSize: 76, chatWidth: 440, chatHeight: 540, sound: true, panelOpacity: 0.78, boot: true },
  // 麦克风不可用、只能打字时，空闲多久后收起面板（毫秒）
  sleepAfterMs: 45000,
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(root) {
  const file = process.env.HOSTBOUND_CONFIG || path.join(root, 'hostbound.config.json');
  let user = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    user = JSON.parse(raw);
  }
  return { ...merge(DEFAULTS, user), root };
}

// 设置页改一项：只把跟默认值不一样的写进 hostbound.config.json，宿主手写的其他项原样保留
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const getPath = (o, keys) => keys.reduce((a, k) => (a == null ? undefined : a[k]), o);
export function saveConfig(root, key, value) {
  const file = process.env.HOSTBOUND_CONFIG || path.join(root, 'hostbound.config.json');
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '') || '{}');
  const keys = key.split('.');
  const same = JSON.stringify(getPath(DEFAULTS, keys)) === JSON.stringify(value);
  let o = user;
  const chain = [];
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) {
      if (same) break;
      o[k] = {};
    }
    chain.push([o, k]);
    o = o[k];
  }
  const last = keys.at(-1);
  if (chain.length === keys.length - 1) {
    if (same) delete o[last];
    else o[last] = value;
    // 删空了的上一层也去掉
    for (let i = chain.length - 1; i >= 0; i--) {
      const [parent, k] = chain[i];
      if (isObj(parent[k]) && !Object.keys(parent[k]).length) delete parent[k];
    }
  }
  fs.writeFileSync(file, JSON.stringify(user, null, 2) + '\n');
  return loadConfig(root);
}
