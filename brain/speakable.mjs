// 把系统要说的话变成「念得出来的话」：哪些念、怎么念、在哪断句。
// 显示在面板里的文字不变；这里只决定声音。

// 回复开头的 [sleep] [ignore] 是给程序看的标记，跟面板一样去掉（面板 app.js 的 stripTag 用同一个规则）
const TAG = /^\s*\[([a-z-]+)\]\s*/i;
export function stripTag(raw) {
  const m = raw.match(TAG);
  if (m) return raw.slice(m[0].length);
  if (/^\s*\[[a-z-]*$/i.test(raw)) return ''; // 标记还没传完
  return raw;
}

const shortName = (p) => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.replace(/^[A-Za-z]:$/, (d) => d[0] + '盘') || '';
};

// 一段显示文字 → 念出来的文字（空字符串表示这段不念）
export function toSpeech(text) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?(?:```|$)/g, ' '); // 代码块不念
  t = t.replace(/`([^`\n]*)`/g, (_, c) => (/[\\/]/.test(c) ? shortName(c) : /[(){};=<>$]/.test(c) ? '' : c));
  t = t.replace(/https?:\/\/[^\s，。；！？、）)】]+/gi, '链接');
  // Windows 路径只念最后一段（文件名或文件夹名）
  t = t.replace(/(?:[A-Za-z]:\\|\\\\)[^\s，。；：！？、"'“”‘’（）()<>|【】]*/g, (p) => shortName(p));
  t = t.replace(/(?:^|(?<=\s))(?:~|\.{1,2})?\/[\w\-.~/]+/g, (p) => shortName(p));
  t = t.replace(/^\s*\|.*$/gm, ' '); // 表格不念
  t = t.replace(/【([^】]*)】/g, '$1，');
  t = t.replace(/^\s*(?:[-*•·]|\d+[.)、])\s+/gm, ''); // 列表符号
  t = t.replace(/[*_#>`~|]+/g, ' ');
  // 常见符号念法
  t = t.replace(/(\d)\s*\+\s*(?=\d)/g, '$1加');
  t = t.replace(/(\d)\s*[=＝]\s*(?=\d)/g, '$1等于');
  t = t.replace(/(\d+(?:\.\d+)?)\s*[%％]/g, '百分之$1');
  t = t.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, '$1年$2月$3日');
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${+h}点${m === '00' ? '' : `${+m}分`}`);
  t = t.replace(/(\d)\s*(?:~|～|-|—)\s*(?=\d)/g, '$1到');
  t = t.replace(/(\d+(?:\.\d+)?)\s*(?:GB|G)\b/gi, '$1G').replace(/(\d+(?:\.\d+)?)\s*MB\b/gi, '$1兆');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  t = t.replace(/[ \t\r\n]+/g, ' ').replace(/\s*([，。！？；：、])\s*/g, '$1').trim();
  t = t.replace(/^[，。！？；：、\s]+/, '').replace(/，$/, '。');
  // 只剩标点、符号，没有能念的字
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

const HARD = /[。！？!?；;\n]/; // 句子结束
const SOFT = /[，,：:、]/; // 句子太长时可以在这里切
const LONG = 42;

// 流式断句：模型一边吐字，一边切出完整的句子。偏移量都基于去掉标记后的显示文字（跟面板一致）
export class SpeechSplitter {
  constructor() {
    this.raw = '';
    this.done = 0; // 已经切出去的位置（显示文字里的下标）
    this.inFence = false;
  }

  get text() {
    return stripTag(this.raw);
  }

  // 返回新切出的段：[{ start, end, text, speak }]，speak 是念出来的文字（空表示不念）
  push(delta) {
    this.raw += delta;
    return this.#cut(false);
  }

  flush() {
    return this.#cut(true);
  }

  #cut(final) {
    const text = this.text;
    const segs = [];
    let i = this.done;
    while (i < text.length) {
      // 代码块整块跳过（不念，但面板要显示）。开头的 ``` 在 i 处，从它后面找结尾的 ```
      if (this.inFence || text.startsWith('```', i)) {
        const close = text.indexOf('```', i + 3);
        if (close < 0) {
          this.inFence = true;
          if (!final) break;
          segs.push(this.#seg(text, i, text.length, false));
          i = text.length;
          break;
        }
        this.inFence = false;
        segs.push(this.#seg(text, i, close + 3, false));
        i = close + 3;
        continue;
      }
      let end = -1;
      for (let j = i; j < text.length; j++) {
        if (text.startsWith('```', j)) {
          end = j;
          break;
        }
        if (HARD.test(text[j])) {
          end = j + 1;
          // 连着的标点、右括号算在这一句里
          while (end < text.length && /[。！？!?；;”’」』）)\]】\s]/.test(text[end]) && text[end] !== '\n') end++;
          if (text[end] === '\n') end++;
          break;
        }
      }
      if (end < 0) {
        // 还没遇到句号：太长就在最后一个逗号处先切一段，免得等太久
        if (text.length - i > LONG) {
          let k = -1;
          for (let j = i + LONG; j > i + 8; j--) if (SOFT.test(text[j])) {
            k = j + 1;
            break;
          }
          if (k > 0) {
            segs.push(this.#seg(text, i, k, true));
            i = k;
            continue;
          }
        }
        if (!final) break;
        end = text.length;
      }
      if (end > i) segs.push(this.#seg(text, i, end, true));
      i = end;
    }
    this.done = i;
    return segs;
  }

  #seg(text, start, end, speakable) {
    const body = text.slice(start, end);
    return { start, end, text: body, speak: speakable ? toSpeech(body) : '' };
  }
}

// 一整段固定的话（授权提示、报错、待机……）切成句子
export function splitForSpeech(text) {
  const s = new SpeechSplitter();
  return [...s.push(text), ...s.flush()].filter((x) => x.speak);
}
