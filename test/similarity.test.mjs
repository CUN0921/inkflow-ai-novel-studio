import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSearchSnippets, ngramContainment } from '../src/similarity-service.mjs';

test('查重句段提取会选择足够长且分散的句子', () => {
  const text = [
    '清晨很冷。',
    '潮水沿着十二级石阶缓慢上涨，水面漂着一枚刻有陌生名字的铜牌。',
    '他没有说话，只把那封来自十年后的信折成四折放进口袋。',
    '钟声响了。',
    '灯塔顶端的玻璃忽然由内向外裂开，裂纹组成一幅从未见过的航海图。',
    '所有人都在向港口奔跑，只有穿红雨衣的女孩逆着人群走向海边。'
  ].join('');
  const snippets = extractSearchSnippets(text, 3);
  assert.equal(snippets.length, 3);
  assert.ok(snippets.every(item => item.length >= 18));
});

test('连续文字组合能识别高度重复并忽略无关文本', () => {
  const original = '潮水沿着十二级石阶缓慢上涨，水面漂着一枚刻有陌生名字的铜牌。主人公弯腰捡起它。';
  assert.ok(ngramContainment(original, original) >= 95);
  assert.ok(ngramContainment(original, '午后的山谷很安静，猎人收好弓箭准备回家。') < 10);
});
