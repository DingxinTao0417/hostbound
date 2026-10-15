// 唤醒词的汉字 → 唤醒词模型要的拼音：每个字拆成「声母 + 带声调的韵母」，空格隔开（系统启动 → x ì t ǒng q ǐ d òng）。
// 模型把 y、w 也当声母（我 → w ǒ，月 → y uè），跟标准拼音的拆法不一样，所以这里自己拆。多音字交给 pinyin-pro 按上下文判断
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const INITIALS = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/;

export function kwsTokens(text) {
  const { pinyin } = require('pinyin-pro');
  const chars = [...String(text || '').replace(/[\s，,。.!！?？、]/g, '')];
  if (!chars.length) return '';
  if (chars.some((c) => !/[一-鿿]/.test(c))) throw new Error('唤醒词只能是汉字');
  const syllables = pinyin(chars.join(''), { toneType: 'symbol', type: 'array', v: false });
  return syllables
    .map((s) => {
      const m = s.match(INITIALS);
      return m ? `${m[1]} ${s.slice(m[1].length)}` : s;
    })
    .join(' ');
}
