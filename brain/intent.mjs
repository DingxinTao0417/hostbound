// 不用问模型就能判断的几种话：让系统待机、明显的指令、授权框的「授权 / 拒绝」
const strip = (t) => String(t || '').replace(/[\s，,。.!！?？、~～…:：;；"“”'‘’]/g, '').toLowerCase();

// 整句话只由这些词组成，才算让系统待机（避免「把没事了那个文件删了」之类误判）
const DISMISS_CORE = ['没事了', '没事儿', '没事', '没别的了', '没别的', '没有了', '不用了', '去睡吧', '去睡', '睡吧', '睡觉吧', '回去吧', '退下吧', '退下', '你先睡吧', '你先睡', '你去睡吧', '你去睡', '你可以走了', '拜拜', '再见', '先这样吧', '先这样', '就这样吧', '下去吧', '再躺会儿', '躺会儿', '躺着', '歇着', '歇会儿', '待机吧', '待机', '进入待机', '系统待机', '退出吧', '关闭吧', '收起来', '收起'];
const DISMISS_FILLER = ['好了', '好的', '好', '行了', '行', '嗯', '那就', '那你', '那', '你', '去', 'ok', '谢谢你', '谢谢', '谢啦', '系统', '了', '啦', '吧', '哈', '呀'];

export function isDismiss(text) {
  let t = strip(text);
  if (!t || t.length > 16) return false;
  let core = false;
  const words = [...DISMISS_CORE.map((w) => [w, true]), ...DISMISS_FILLER.map((w) => [w, false])].sort((a, b) => b[0].length - a[0].length);
  outer: while (t) {
    for (const [w, isCore] of words) {
      if (t.startsWith(w)) {
        t = t.slice(w.length);
        core ||= isCore;
        continue outer;
      }
    }
    return false;
  }
  return core;
}

// 一听就是在给系统下指令的话，不用再问模型
const COMMAND_START = /^(帮我|帮忙|麻烦|请你?|给我|把|打开|开一下|关掉|关闭|关了|搜一?下?|搜索|查一?下?|找一?下?|看看|看一下|再|还有|然后|顺便|接着|继续|写|发|播放|放一?下|暂停|下载|新建|创建|整理|删|删除|打包|复制|移动|重命名|告诉我|你(?!们))/;
const COMMAND_ANY = /(帮我|帮忙|给我|你帮|你把|你给|你再|你去|你看|你能|你可以)/;

export function looksLikeCommand(text) {
  const t = strip(text);
  return COMMAND_START.test(t) || COMMAND_ANY.test(t);
}

// 确认框：返回 all | deny | allow | null（没听懂）。
// 放行要求更严：句子要短、要有明确的同意词，单个「好」「嗯」不算，免得把闲聊当成同意
export function parseConfirm(text) {
  const t = strip(text);
  if (!t) return null;
  if (/都允许|全部允许|全都允许|都可以|全都可以|都行|这次都|全部同意|都同意|全部授权|都授权|全都授权/.test(t)) return 'all';
  if (/不行|不可以|不能|不要|不用|别|拒绝|算了|取消|不同意|停|不准|不许|不授权|no|nope/.test(t)) return 'deny';
  if (t.length <= 10 && /授权|允许|可以|同意|确定|确认|批准|没问题|好的|行吧|执行|做吧|干吧|删吧|关吧|去吧|搞吧|来吧|ok|okay|yes/.test(t)) return 'allow';
  return null;
}

// 申请接管前台时的语音回答：allow 允许 / later 稍后 / deny 拒绝 / null 没听懂
export function parseTakeover(text) {
  const t = strip(text);
  if (!t) return null;
  if (/等一?下|稍后|待会|等会|一会儿?|先别|晚点|过会/.test(t)) return 'later';
  const c = parseConfirm(t);
  if (c === 'deny') return 'deny';
  if (c === 'allow' || c === 'all') return 'allow';
  return null;
}

// 翻面板：「系统，打开设置」「看看日志」「回到对话」「打开快捷键设置」。整句只是这个意思才算，免得把「打开记录本」当成翻页
const NAV_PAGE = { 设置: 'set', 设定: 'set', 系统设置: 'set', 任务记录: 'rec', 记录: 'rec', 历史记录: 'rec', 历史: 'rec', 系统日志: 'log', 日志: 'log', 操作日志: 'log', 对话: 'chat', 聊天: 'chat', 技能: 'skill', 系统技能: 'skill', 技能列表: 'skill', 项目: 'proj', 系统项目: 'proj', 项目列表: 'proj', 所有项目: 'proj' };
const NAV_SUB = { 听觉: 'ear', 声音: 'voice', 大脑: 'brain', 模型: 'brain', 操作: 'hand', 安全: 'safe', 安全中心: 'safe', 直播: 'live', 直播模式: 'live', 快捷键: 'keys', 外观: 'look', 关于: 'about' };
const NAV_RE = new RegExp(
  `^(系统)?(帮我)?(打开|看看|看一下|查看|进入|切到|切换到|去|翻到|回到|返回|跳到)?(一下)?(系统的?)?(?:(${Object.keys(NAV_SUB).join('|')})的?(?:设置|页)?|(${Object.keys(NAV_PAGE).sort((a, b) => b.length - a.length).join('|')}))(页|页面|界面)?(吧|了|呀)?$`,
);
export function parseNav(text) {
  const m = strip(text).match(NAV_RE);
  if (!m) return null;
  if (m[6]) {
    // 只说「声音」「操作」这种单个词不算，得有「打开」或「设置」
    if (!m[3] && !/设置|页/.test(text)) return null;
    return { page: 'set', sub: NAV_SUB[m[6]] };
  }
  if (!m[3] && (m[7] === '对话' || m[7] === '聊天' || m[7] === '历史' || m[7] === '记录' || m[7] === '技能' || m[7] === '项目')) return null;
  return { page: NAV_PAGE[m[7]] };
}

// 到点提醒弹出来以后的回答：「知道了」→ ack；「过十分钟再提醒」「半小时后再叫我」→ { snooze: 分钟 }；别的话返回 null（当普通的话处理）
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十五: 15, 二十: 20, 三十: 30, 四十: 40, 五十: 50 };
export function parseReminderAnswer(text) {
  const t = strip(text);
  if (!t) return null;
  if (/^(好的?|好了|知道了?|知道啦|收到|行|行了|嗯|嗯嗯|ok|明白|明白了|了解|了解了|谢谢|已经喝了|做完了|关掉|关了|不用了)(了|啦|吧)?$/.test(t)) return 'ack';
  if (!/(提醒|叫我|喊我|再说)/.test(t) || !/(再|过|等会|等一会|一会|待会|稍后|晚点|晚些)/.test(t)) return null;
  let m = t.match(/(\d+|半|[一两二三四五六七八九十]+)(个)?(分钟|分|小时|钟头)/);
  let minutes = 10;
  if (m) {
    const n = m[1] === '半' ? 0.5 : /^\d+$/.test(m[1]) ? +m[1] : CN_NUM[m[1]] ?? (m[1].length === 2 && m[1][0] === '十' ? 10 + (CN_NUM[m[1][1]] || 0) : m[1].length === 2 && m[1][1] === '十' ? (CN_NUM[m[1][0]] || 1) * 10 : 10);
    minutes = /小时|钟头/.test(m[3]) ? n * 60 : n;
  } else if ((m = t.match(/半小时|半个小时/))) minutes = 30;
  return { snooze: Math.max(1, Math.round(minutes)) };
}

// 技能卡片（草稿、改进、安装检查）弹着的时候，宿主直接说的「保存」「不要了」「安装」「不装」。
// 整句只是这个意思才算；「改一下……」这种带了要求的交给大脑。返回 save | discard | null
export function parseSkillAnswer(text, kind = 'new') {
  const t = strip(text).replace(/^(系统|那就|那|好的?|行|嗯|可以)+/, '').replace(/(吧|了|啦|呀|一下)+$/, '');
  if (!t) return null;
  if (kind === 'install') {
    if (/^(不装|别装|不要装|不安装|不用装|算了不装|不要了|不要)$/.test(t)) return 'discard';
    if (/^(安装|装|装上|装上去|装好|就装|可以装|确认安装|那就装)$/.test(t)) return 'save';
    return null;
  }
  if (kind === 'improve') {
    if (/^(不改|别改|不用改|不要改|算了不改|不要了|不要)$/.test(t)) return 'discard';
    if (/^(改|改吧|就改|可以改|就这么改|按你说的改|同意|行改)$/.test(t)) return 'save';
    return null;
  }
  if (/^(不要了?|不要这个|不存|别存|不用存|不保存|算了不存|丢掉|扔了|删了)$/.test(t)) return 'discard';
  if (/^(保存|存|存上|存起来|存下来|保存下来|就这样保存|就这么存|可以保存|存成技能|确认保存)$/.test(t)) return 'save';
  return null;
}

// 鉴定术：「我要鉴定」「开启鉴定模式」→ select；「鉴定一下这个窗口」→ window；「扫描全屏」→ screen。整句只是这个意思才算
export function parseAppraise(text) {
  const t = strip(text).replace(/^(系统|宿主系统)+/, '').replace(/(吧|呀|啊|一下下)+$/, '');
  if (!t) return null;
  if (/^(帮我|给我|请)?(扫描|鉴定|扫)(一下)?(全屏|整个屏幕|全部屏幕|所有屏幕|所有窗口)$|^(全屏扫描|全屏鉴定|开始全屏扫描)$/.test(t)) return 'screen';
  if (/^(帮我|给我|请)?鉴定(一下)?(这个|当前|我的?|现在的?|眼前的?)?窗口$/.test(t)) return 'window';
  if (/^(我要|我想|帮我|给我|请|开启|打开|进入|开始)?(鉴定|鉴定模式|鉴定术|鉴定一下|鉴定一下这个|鉴定这个)$|^(开启|打开|进入)鉴定模式$/.test(t)) return 'select';
  return null;
}
// 鉴定卡开着的时候：「关掉」「收起来」「不看了」
export function parseAppraiseClose(text) {
  return /^(关掉|关了|关闭|收起来?|不看了|可以关了|关掉卡片|关掉鉴定)(吧|了)?$/.test(strip(text).replace(/^(系统)+/, ''));
}

// 项目计划卡弹着时的「开工」「就按这个做」（不用问大脑，直接开工）
export function parseProjectGo(text) {
  return /^(那就|那|好|好的|行|可以|没问题|嗯)*(就)?(开工|开干|开始吧|开始做吧?|动手吧?|就这么做|就按这个做|按这个做|按这个来|按计划来|照这个做)(吧|了|呀)?$/.test(strip(text).replace(/^(系统)+/, ''));
}
