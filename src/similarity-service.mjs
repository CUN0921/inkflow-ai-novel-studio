import { parseJsonText } from './ai.mjs';

export class SimilarityService {
  constructor(db, models) {
    this.db = db;
    this.models = models;
  }

  start(chapterId) {
    const chapter = this.db.getChapter(chapterId);
    if (!chapter) throw new Error('章节不存在');
    if ((chapter.content || '').trim().length < 120) throw new Error('正文至少需要 120 个字符才能查重');
    const active = this.db.latestSimilarityCheck(chapterId);
    if (active?.status === 'running') throw new Error('本章已有查重任务正在运行');
    const check = this.db.createSimilarityCheck(chapter);
    this.execute(check.id, chapter).catch(error => {
      this.db.updateSimilarityCheck(check.id, {status:'failed', risk:'unknown', message:error.message});
    });
    return check;
  }

  async execute(checkId, chapter) {
    const snippets = extractSearchSnippets(chapter.content, 6);
    this.db.updateSimilarityCheck(checkId, {
      searchedSegments:snippets.length, message:`正在搜索 ${snippets.length} 组特征句段`
    });

    const localMatches = this.findLocalMatches(chapter);
    let webMatches = [];
    const checker = this.models.for('checker');
    if (!checker.enabled) throw new Error('网络查重模型尚未配置');
    if (checker.protocol !== 'responses') throw new Error('请在“模型与审稿”中把网络查重协议设置为 Responses');

    const result = await checker.generate({
      instructions:'你是中文网文相似内容检索员。只报告搜索结果中有实际文本依据的匹配，不要仅凭题材、人物类型或常见表达判断相似。',
      input:`请在公开网络中逐一搜索下面这些来自待检测章节的特征句段，优先使用精确短语搜索。忽略只有相同题材、套路或通用短语的页面。\n\n${snippets.map((text,index)=>`${index+1}. ${text}`).join('\n')}\n\n最后只返回 JSON：{"results":[{"title":"网页或作品标题","url":"https://来源地址","similarity":0到100的整数,"matchedText":"待检测章节中的命中句段","sourceExcerpt":"搜索结果中支持判断的简短片段"}]}。找不到可靠匹配时 results 返回空数组。禁止编造网址和原文。`,
      maxOutputTokens:this.models.outputTokens?.('checker', 6000) ?? 6000,
      tools:[{type:'web_search'}],
      toolChoice:{type:'web_search'},
      validate:text => validateSearchResult(parseJsonText(text)),
      meta:{task:'similarity',projectId:chapter.project_id,chapterId:chapter.id,checkId}
    });
    const parsed = result.value ?? validateSearchResult(parseJsonText(result.text));
    webMatches = (Array.isArray(parsed.results) ? parsed.results : []).filter(validWebMatch).slice(0, 12).map(item => ({
      sourceType:'web', title:item.title, url:item.url, similarity:Math.round(Number(item.similarity) || 0),
      matchedText:item.matchedText || '', sourceExcerpt:item.sourceExcerpt || ''
    }));

    const matches = [...webMatches, ...localMatches].sort((a,b) => b.similarity - a.similarity);
    for (const match of matches) this.db.addSimilarityMatch(checkId, match);
    const score = matches[0]?.similarity || 0;
    const risk = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
    const message = matches.length
      ? `检测完成，发现 ${matches.length} 个需要人工核对的相似来源`
      : '检测完成，在本次公开网络搜索范围内未发现明显相似内容';
    return this.db.updateSimilarityCheck(checkId, {
      status:'completed', score, risk, searchedSegments:snippets.length,
      resultCount:matches.length, message
    });
  }

  findLocalMatches(chapter) {
    const project = this.db.getProject(chapter.project_id);
    return project.chapters.filter(item => item.id !== chapter.id && item.content)
      .map(item => ({item, similarity:ngramContainment(chapter.content, item.content)}))
      .filter(result => result.similarity >= 25)
      .map(({item, similarity}) => ({
        sourceType:'local', title:`本作品 · 第${item.number}章《${item.title}》`, url:'', similarity,
        matchedText:'检测到较多重复的连续文字组合', sourceExcerpt:item.summary || item.content.slice(0, 100)
      })).slice(0, 6);
  }
}

function validateSearchResult(value) {
  if (!value || !Array.isArray(value.results)) throw new Error('查重结果缺少 results 列表');
  return value;
}

export function extractSearchSnippets(content, limit=6) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const sentences = text.split(/[。！？!?；;]/).map(item => item.trim().replace(/^[“”‘’"']+|[“”‘’"']+$/g, ''))
    .filter(item => item.length >= 18 && item.length <= 90);
  const scored = sentences.map((value,index) => {
    const unique = new Set(value).size / value.length;
    const dialoguePenalty = /^[“「『]/.test(value) ? .7 : 1;
    return {value, index, score:Math.min(value.length, 55) * unique * dialoguePenalty};
  }).sort((a,b) => b.score - a.score);
  const picked = [];
  for (const item of scored) {
    if (picked.some(other => Math.abs(other.index - item.index) < 2)) continue;
    picked.push(item);
    if (picked.length === limit) break;
  }
  if (picked.length < limit) {
    for (const item of scored) {
      if (picked.includes(item)) continue;
      picked.push(item);
      if (picked.length === limit) break;
    }
  }
  return picked.sort((a,b) => a.index - b.index).map(item => item.value.slice(0, 70));
}

export function ngramContainment(first, second, size=8) {
  const a = grams(normalize(first), size), b = grams(normalize(second), size);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const gram of a) if (b.has(gram)) common++;
  return Math.round(common / Math.min(a.size, b.size) * 100);
}

function normalize(text) { return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase(); }
function grams(text, size) {
  const result = new Set();
  for (let i=0; i<=text.length-size; i++) result.add(text.slice(i,i+size));
  return result;
}
function validWebMatch(item) {
  return item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url) && Number(item.similarity) >= 20;
}
