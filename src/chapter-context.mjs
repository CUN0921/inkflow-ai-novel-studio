import { createHash } from 'node:crypto';

// Story time is determined by chapter number, never by the date a memory was added.
export const ENDING_EXCERPT_LIMIT = 1600;

export function excerptTail(content, limit = ENDING_EXCERPT_LIMIT) {
  const text = String(content || '');
  return text.length <= limit ? text : text.slice(-limit);
}

function text(value) {
  return String(value ?? '').trim();
}

function textList(value) {
  if (Array.isArray(value)) return value.map(item => {
    if (item && typeof item === 'object') return Object.entries(item).map(([key, itemValue]) => `${key}：${text(itemValue)}`).join('，');
    return text(item);
  }).filter(Boolean).slice(0, 12);
  if (value && typeof value === 'object') return Object.entries(value).map(([key, itemValue]) => `${key}：${text(itemValue)}`).filter(Boolean).slice(0, 12);
  const valueText = text(value);
  return valueText ? [valueText] : [];
}

function lastLine(content) {
  return String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || '';
}

// The handoff is deliberately compact: it carries the immediate scene state,
// while the ending excerpt keeps the next writer grounded in the actual prose.
export function normalizeHandoff(value, { chapterNumber = 0, sourceVersion = 0, content = '', summary = '' } = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    sourceChapter: Number(input.sourceChapter) || chapterNumber || 0,
    sourceVersion: Number(input.sourceVersion) || sourceVersion || 0,
    location: text(input.location),
    time: text(input.time),
    characterStates: textList(input.characterStates ?? input.characters),
    lastAction: text(input.lastAction ?? input.endingAction),
    emotionalState: text(input.emotionalState ?? input.emotion),
    newKnowledge: textList(input.newKnowledge ?? input.knownChanges ?? input.knowledge),
    carriedItems: textList(input.carriedItems ?? input.items),
    unresolved: textList(input.unresolved ?? input.openThreads),
    nextOpening: text(input.nextOpening ?? input.opening),
    lastLine: text(input.lastLine) || lastLine(content),
    endingExcerpt: text(input.endingExcerpt) || excerptTail(content),
    summary: text(input.summary) || text(summary)
  };
}

export function buildChapterHandoff(value, { chapterNumber = 0, sourceVersion = 0, content = '', summary = '' } = {}) {
  return {
    ...normalizeHandoff(value, {chapterNumber, sourceVersion, content, summary}),
    sourceChapter: chapterNumber,
    sourceVersion,
    endingExcerpt: excerptTail(content),
    summary: text(summary)
  };
}

export function chapterContext(project, chapter) {
  const ordered = [...project.chapters].sort((a,b) => a.number - b.number);
  const reliable = item => item.status === 'completed' && !item.context_stale;
  const relevanceText = [chapter.title,chapter.outline,chapter.writing_instructions,JSON.stringify(chapter.plan || {})].join(' ');
  const facts = project.memories.filter(item => {
    if (item.source_chapter >= chapter.number || item.status !== 'active') return false;
    if (!item.source_chapter) return true;
    const source = ordered.find(ch => ch.number === item.source_chapter);
    return source && reliable(source) && (item.source_version == null || item.source_version === source.version);
  }).map(item => ({
    ...item,
    relevance:(item.pinned ? 1000 : 0) + (Number(item.importance) || 1) * 100
      + (relevanceText.includes(item.subject) ? 250 : 0)
      + Math.max(0, 80 - (chapter.number - item.source_chapter))
  })).sort((a,b) => b.relevance - a.relevance || b.source_chapter - a.source_chapter).slice(0,60);
  const previous = ordered.filter(item => item.number < chapter.number && reliable(item) && item.summary).slice(-3);
  const next = ordered.filter(item => item.number > chapter.number && reliable(item) && item.summary).slice(0,2);
  const volumeDigest = ordered.filter(item => item.volume_id === chapter.volume_id && item.number < chapter.number && reliable(item) && item.summary)
    .slice(-12).map(item => `第${item.number}章：${item.summary}`).join('\n');
  const previousChapter = ordered.find(item => item.number === chapter.number - 1);
  const previousEnding = previousChapter && previousChapter.content?.trim() ? {
    number: previousChapter.number,
    title: previousChapter.title,
    version: previousChapter.version,
    reliable: reliable(previousChapter),
    excerpt: excerptTail(previousChapter.content),
    handoff: previousChapter.handoff?.sourceVersion === previousChapter.version
      ? normalizeHandoff(previousChapter.handoff, {chapterNumber:previousChapter.number, sourceVersion:previousChapter.version, content:previousChapter.content, summary:previousChapter.summary})
      : null
  } : null;
  const summarize = item => ({id:item.id,number:item.number,version:item.version,summary:item.summary});
  return {
    project:{id:project.id,premise:project.premise,tone:project.tone,outline:project.outline,world:project.world,storyDigest:volumeDigest || project.story_digest || '',
      characters:(project.characters || []).filter(item => item.status !== 'needs_review' && (!item.firstChapter || item.firstChapter < chapter.number))},
    chapter:{id:chapter.id,number:chapter.number,title:chapter.title,outline:chapter.outline,plan:chapter.plan || {},writing_instructions:chapter.writing_instructions || '',opening_instructions:chapter.opening_instructions || '',target_words:chapter.target_words || 3000,version:chapter.version,revision:chapter.revision,content:chapter.content || ''},
    volumeGoal:project.volumes.find(item => item.id === chapter.volume_id)?.goal || '未设定',
    previous:previous.map(summarize),
    previousEnding,
    facts:facts.map(({id,source_chapter,source_version,kind,subject,fact,importance,pinned}) => ({id,source_chapter,source_version,kind,subject,fact,importance,pinned})),
    // The reveal state may have changed later. Only the visible planned clue is shared.
    clues:project.foreshadows.filter(item => item.planted_chapter <= chapter.number && item.status !== 'resolved')
      .map(({title,visible_clue,planted_chapter,status,actual_chapter,progress_note}) => ({title,visible_clue,planted_chapter,status,actual_chapter,progress_note})),
    next:next.map(summarize),
    missingPrevious:ordered.filter(item => item.number < chapter.number && (!reliable(item) || !item.summary)).map(item => item.number)
  };
}

export function contextFingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function writerContext(snapshot) {
  const {project,chapter,previous,facts,clues} = snapshot;
  const ending = snapshot.previousEnding;
  const handoff = ending?.handoff;
  const handoffLines = handoff ? [
    `地点：${handoff.location || '未明确'}`,
    `时间：${handoff.time || '未明确'}`,
    `人物状态：${handoff.characterStates.join('；') || '未明确'}`,
    `刚刚发生：${handoff.lastAction || '未明确'}`,
    `情绪状态：${handoff.emotionalState || '未明确'}`,
    `新信息：${handoff.newKnowledge.join('；') || '无'}`,
    `携带物品：${handoff.carriedItems.join('；') || '无'}`,
    `未解决冲突：${handoff.unresolved.join('；') || '无'}`,
    `建议开场：${handoff.nextOpening || '从上一章结尾动作的直接后果开始'}`,
    `上一章最后一句：${handoff.lastLine || '未提取'}`
  ].join('\n') : ending ? '上一章尚无结构化交接卡，请以结尾正文片段为准，先完成场景和人物状态的直接承接。' : '无上一章可承接，本章从全书设定和本章章纲开始。';
  const endingText = ending ? `上一章第${ending.number}章《${ending.title}》的结尾衔接资料（高优先级${ending.reliable ? '' : '；结构化资料待复核，请至少承接正文片段'}）：\n${handoffLines}\n\n上一章结尾正文片段（仅用于承接语气、动作和现场状态）：\n${ending.excerpt}`
    : (chapter.number === 1 ? '上一章结尾衔接资料：无（这是开篇章节）。' : `上一章结尾衔接资料：缺少第${chapter.number-1}章正文，禁止把本章当作开篇；按章纲写作并避免虚构前章经历。`);
  const plan = chapter.plan || {};
  const structuredPlan = `结构化章纲：开场状态=${plan.openingState || '未指定'}；出场人物=${(plan.cast || []).join('、') || '未指定'}；本章目标=${plan.goal || '未指定'}；关键转折=${plan.turn || '未指定'}；必须发生=${plan.mustHappen || '未指定'}；结束状态=${plan.endingState || '未指定'}`;
  return [
    `作者创作计划（不是人物已知事实）：\n核心创意：${project.premise || ''}\n全书主线：${project.outline}\n世界规则：${project.world}\n分卷进展摘要：${project.storyDigest || '暂无'}\n主要人物设定：${JSON.stringify(project.characters)}\n当前分卷目标：${snapshot.volumeGoal}`,
    `当前章：第${chapter.number}章《${chapter.title}》\n本章章纲：${chapter.outline}\n${structuredPlan}\n用户单章写作要求：${chapter.writing_instructions || '遵循章纲和全书文风'}\n开篇衔接要求：${chapter.opening_instructions || '承接上一章结尾，先处理上一章留下的动作、地点和人物状态'}\n目标字数：约${chapter.target_words}字`,
    endingText,
    `衔接规则：如果不是第一章，正文开头必须从上一章结尾的直接后果写起；不得重新概括上一章，不得无理由更换地点、时间、人物状态或丢失关键物品。若本章章纲要求跳转，必须用清晰的过渡交代跳转。`,
    `知识截止：只允许使用第${chapter.number}章之前已确认的正文事实。人物不能凭作者计划预知未来。`,
    `前三章摘要：\n${previous.map(item => `第${item.number}章（第${item.version || 1}版）：${item.summary}`).join('\n') || '无可用摘要'}`,
    `本章之前已经发生的事实：\n${facts.map(item => `[${item.kind}] ${item.subject}：${item.fact}（第${item.source_chapter}章）`).join('\n') || '暂无'}`,
    `本章可用的计划线索（需在正文中合理呈现，不代表人物已经得知）：\n${clues.map(item => `${item.title}：${item.visible_clue}`).join('\n') || '暂无'}`,
    snapshot.missingPrevious.length ? `前文第${snapshot.missingPrevious.join('、')}章未写或摘要待复核。不要虚构这些章节已经发生的经历。` : ''
  ].filter(Boolean).join('\n\n');
}

export function reviewerContinuity(snapshot) {
  return `仅供审稿的后续衔接约束（这些事件在本章尚未发生，不得写入本章事实或人物认知）：\n${snapshot.next.map(item => `第${item.number}章：${item.summary}`).join('\n') || '无可用后续摘要'}`;
}
