import { parseJsonText } from './ai.mjs';
import { buildChapterHandoff, chapterContext, writerContext, reviewerContinuity } from './chapter-context.mjs';

export class RewriteService {
  constructor(db, models) {
    this.db = db;
    this.models = models;
  }

  start(chapterId, instruction='') {
    const chapter = this.db.getChapter(chapterId);
    if (!chapter) throw new Error('章节不存在');
    if (!(chapter.content || '').trim()) throw new Error('本章还没有正文，无法重写');
    const active = this.db.latestRewriteJob(chapterId);
    if (active?.status === 'running') throw new Error('本章已有重写任务正在运行');
    const snapshot = chapterContext(this.db.getProject(chapter.project_id), chapter);
    const job = this.db.createRewriteJob(chapter, String(instruction || '').trim(), snapshot);
    this.execute(job.id).catch(error => {
      this.db.updateRewriteJob(job.id, {status:'failed', message:error.message});
    });
    return job;
  }

  async execute(jobId) {
    const job = this.db.getRewriteJob(jobId);
    const project = this.db.getProject(job.project_id);
    const chapter = project?.chapters.find(item => item.id === job.chapter_id);
    if (!project || !chapter) throw new Error('作品或章节不存在');
    const writer = this.models.for('writer');
    if (!writer.enabled) throw new Error('正文写作模型尚未配置');

    const snapshot = job.context_snapshot?.chapter ? job.context_snapshot : chapterContext(project, chapter);
    const context = writerContext(snapshot);
    const reviewEnabled = this.models.reviewEnabled !== false;
    const shortStory = project.mode === 'short';
    this.db.updateRewriteJob(jobId, {message:shortStory ? '正在重写完整短故事' : `正在重写第 ${chapter.number} 章《${chapter.title}》`});
    let draft;
    try {
      draft = await writer.generate({
      instructions:shortStory
        ? `你是职业中文短故事作者。文风要求：${snapshot.project.tone || '叙事清晰、节奏紧凑、情绪有层次'}。把原稿重写为一篇独立完结的完整故事，强化开篇钩子、核心冲突、递进反转、高潮和结局闭环，保持既定叙事视角。原稿与用户要求冲突时以用户要求为准。`
        : `你是职业中文长篇小说作者。文风要求：${snapshot.project.tone || '叙事清晰，场景具体'}。依据本章之前的事实和用户章纲重写，采用新的场景组织、表达和对话。原稿若与用户要求冲突，以用户要求为准。作者计划不得直接变成人物已知信息。`,
      input:`${context}\n\n用户对本次重写的要求：${job.instruction || (shortStory ? '改善开篇吸引力、冲突递进、情绪张力和结局回收。' : '改善节奏、场景表现和章节钩子，保留本章核心剧情作用。')}\n\n原${shortStory ? '短故事' : '章节'}正文：\n${snapshot.chapter.content}\n\n请直接返回完整重写正文，约${snapshot.chapter.target_words}字，不要标题、解释或修改说明。`,
      maxOutputTokens:this.models.outputTokens?.('writer', 24000) ?? 24000,
      streamProgress:true,
      meta:{task:'rewrite',projectId:project.id,chapterId:chapter.id,jobId}
      });
    } catch (error) {
      if (String(error.responseText || '').trim()) {
        this.db.updateRewriteJob(jobId,{candidateContent:error.responseText,message:'模型返回被截断，部分候选稿已经保留'});
        error.message = `${error.message}；部分候选稿已经保留`;
      }
      throw error;
    }

    if (!reviewEnabled) {
      let extracted = null;
      try { extracted = await this.extractCandidate(snapshot,draft.text,{projectId:project.id,chapterId:chapter.id,jobId}); }
      catch {}
      return this.db.updateRewriteJob(jobId, {
        status:'completed', candidateContent:draft.text, candidateSummary:extracted?.summary || '',
        candidateMemories:extracted?.memories || [],candidateCharacters:extracted?.characters || [],
        candidateForeshadows:extracted?.foreshadows || [],candidatePlanResult:extracted?.planCheck || {},score:null,
        candidateHandoff:buildChapterHandoff(extracted?.handoff || {}, {chapterNumber:chapter.number, sourceVersion:0, content:draft.text,summary:extracted?.summary || ''}),
        message:extracted ? '候选稿和故事资料已生成，请对照后决定是否采用' : '候选稿已生成；故事资料整理暂未完成'
      });
    }
    const reviewer = this.models.for('reviewer');
    this.db.updateRewriteJob(jobId, {candidateContent:draft.text, message:'候选稿已生成，正在检查前后文衔接'});
    let review = null;
    let reviewError = null;
    try {
      if (!reviewer.enabled) throw new Error('审稿整理模型尚未配置');
      const checked = await reviewer.generate({
        instructions:shortStory ? '你是中文短故事责任编辑。检查候选稿是否在一篇内完成核心冲突、递进反转、高潮和情绪闭环，开篇是否快速进入事件，叙事视角是否统一，并提取最终事实。不要复述或重写正文。' : '你是长篇小说责任编辑。简洁检查候选稿是否完成章纲、遵守既有事实、没有提前泄露未来剧情，并提取最终确定的故事记忆。不要复述或重写正文。',
        input:`${context}\n\n${reviewerContinuity(snapshot)}\n\n用户重写要求：${job.instruction}\n\n重写候选稿：\n${draft.text}\n\n${rewriteReviewRequest()}`,
        maxOutputTokens:this.models.outputTokens?.('reviewer', 6000) ?? 6000,
        validate:text => validateRewriteReview(parseJsonText(text)),
        meta:{task:'rewrite-review',projectId:project.id,chapterId:chapter.id,jobId}
      });
      review = checked.value ?? validateRewriteReview(parseJsonText(checked.text));
    } catch (error) {
      reviewError = error;
    }

    const reviewed = review && !reviewError;
    return this.db.updateRewriteJob(jobId, {
      status:'completed', candidateContent:draft.text,
      candidateSummary:reviewed ? review.summary : '',
      candidateMemories:reviewed ? review.memories : [],
      candidateCharacters:reviewed ? review.characters : [],
      candidateForeshadows:reviewed ? review.foreshadows : [],
      candidatePlanResult:reviewed ? review.planCheck : {},
      candidateHandoff:buildChapterHandoff(reviewed ? review.handoff : {}, {chapterNumber:chapter.number, sourceVersion:0, content:draft.text, summary:reviewed ? review.summary : ''}),
      score:reviewed ? review.score : null,
      message:reviewError
        ? `候选稿已生成；自动审稿暂未完成（${friendlyReviewError(reviewError)}），你仍可对照后决定是否采用`
        : '候选稿已完成，可以对照原文后决定是否采用'
    });
  }

  async extractCandidate(snapshot,content,meta) {
    const reviewer = this.models.for('reviewer');
    if (!reviewer.enabled) throw new Error('资料整理模型尚未配置');
    const result = await reviewer.generate({
      instructions:'你是小说资料整理员。不要评分或修改正文，只整理后续写作所需事实。',
      input:`${writerContext(snapshot)}\n\n候选正文：\n${content}\n\n只返回 JSON：{"summary":"100字内事实摘要","planCheck":{"goal":"done|partial|missing","turn":"done|partial|missing","mustHappen":"done|partial|missing","endingState":"done|partial|missing","note":"说明"},"memories":[{"kind":"character|event|item|knowledge|relationship|timeline","subject":"主体","fact":"确定事实","importance":1}],"characters":[{"name":"人物","role":"身份","aliases":[],"relationship":"当前关系","goal":"当前目标","location":"结尾位置","state":"结尾状态","importance":"major|minor"}],"foreshadows":[{"title":"线索名","status":"planted|advanced|resolved","evidence":"进展"}],"handoff":{"location":"结尾地点","time":"结尾时间","characterStates":[],"lastAction":"最后动作","emotionalState":"结尾情绪","newKnowledge":[],"carriedItems":[],"unresolved":[],"nextOpening":"下一章承接点","lastLine":"正文最后一句"}}。`,
      maxOutputTokens:this.models.outputTokens?.('reviewer',6000) ?? 6000,
      validate:text => {
        const value=parseJsonText(text);
        if (!value || !value.summary || !Array.isArray(value.memories)) throw new Error('故事资料不完整');
        value.characters=Array.isArray(value.characters)?value.characters:[];
        value.foreshadows=Array.isArray(value.foreshadows)?value.foreshadows:[];
        value.planCheck=value.planCheck && typeof value.planCheck==='object'?value.planCheck:{};
        return value;
      },
      meta:{task:'extract',...meta}
    });
    return result.value ?? parseJsonText(result.text);
  }

  async retryReview(jobId) {
    if (this.models.reviewEnabled === false) throw new Error('自动审稿已关闭，请先在设置中启用');
    const job = this.db.getRewriteJob(jobId);
    if (!job || !(job.candidate_content || '').trim()) throw new Error('没有可重新审稿的候选稿');
    if (job.status === 'running') throw new Error('候选稿任务仍在运行');
    const project = this.db.getProject(job.project_id);
    const chapter = project?.chapters.find(item => item.id === job.chapter_id);
    if (!project || !chapter || chapter.version !== job.original_version || chapter.revision !== job.original_revision) throw new Error('原章节或创作依据已经变化，请重新生成候选稿');
    const snapshot = job.context_snapshot?.chapter ? job.context_snapshot : chapterContext(project,chapter);
    this.db.updateRewriteJob(jobId,{status:'running',message:'正在重新检查候选稿的前后文衔接'});
    try {
      const checked = await this.models.for('reviewer').generate({
        instructions:'你是长篇小说责任编辑。检查候选稿是否完成章纲、遵守既有事实、没有提前泄露未来剧情，并提取最终确定的故事记忆。不要复述或重写正文。',
        input:`${writerContext(snapshot)}\n\n${reviewerContinuity(snapshot)}\n\n用户重写要求：${job.instruction}\n\n重写候选稿：\n${job.candidate_content}\n\n${rewriteReviewRequest()}`,
        maxOutputTokens:this.models.outputTokens?.('reviewer', 6000) ?? 6000, validate:text=>validateRewriteReview(parseJsonText(text)),
        meta:{task:'rewrite-review',projectId:project.id,chapterId:chapter.id,jobId}
      });
      const review = checked.value ?? validateRewriteReview(parseJsonText(checked.text));
      return this.db.updateRewriteJob(jobId,{status:'completed',candidateSummary:review.summary,candidateMemories:review.memories,
        candidateCharacters:review.characters,candidateForeshadows:review.foreshadows,candidatePlanResult:review.planCheck,
        candidateHandoff:buildChapterHandoff(review.handoff, {chapterNumber:chapter.number, sourceVersion:0, content:job.candidate_content, summary:review.summary}),
        score:review.score,message:'候选稿重新审稿完成，可以对照原文后决定是否采用'});
    } catch(error) {
      this.db.updateRewriteJob(jobId,{status:'completed',message:`候选稿仍已保留；自动审稿再次失败（${friendlyReviewError(error)}）`});
      throw error;
    }
  }
}

function validateRewriteReview(value) {
  if (!value || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.memories) || typeof value.score !== 'number' || value.score < 0 || value.score > 100) throw new Error('审稿结果不完整');
  value.characters=Array.isArray(value.characters)?value.characters:[];
  value.foreshadows=Array.isArray(value.foreshadows)?value.foreshadows:[];
  value.planCheck=value.planCheck && typeof value.planCheck==='object'?value.planCheck:{};
  value.handoff = value.handoff && typeof value.handoff === 'object' && !Array.isArray(value.handoff) ? value.handoff : {};
  return value;
}

function rewriteReviewRequest() {
  return '只返回紧凑 JSON：{"score":0到100,"summary":"100字内事实摘要","planCheck":{"goal":"done|partial|missing","turn":"done|partial|missing","mustHappen":"done|partial|missing","endingState":"done|partial|missing","note":"说明"},"memories":[{"kind":"character|event|item|knowledge|relationship|timeline","subject":"主体","fact":"仅本章确定事实","importance":1}],"characters":[{"name":"人物","role":"身份","aliases":[],"relationship":"当前关系","goal":"目标","location":"结尾位置","state":"结尾状态","importance":"major|minor"}],"foreshadows":[{"title":"线索名","status":"planted|advanced|resolved","evidence":"进展"}],"handoff":{"location":"结尾地点","time":"结尾时间","characterStates":[],"lastAction":"最后动作","emotionalState":"结尾情绪","newKnowledge":[],"carriedItems":[],"unresolved":[],"nextOpening":"下一章承接点","lastLine":"正文最后一句"}}。只依据候选正文，不得提取后续摘要为事实。';
}

function friendlyReviewError(error) {
  const message = String(error?.message || '模型暂时不可用');
  if (message.includes('没有返回文本')) return '模型未返回审稿结果';
  if (message.includes('不是有效的 JSON')) return '审稿结果格式异常';
  if (/\(429\)/.test(message)) return '模型请求过于频繁';
  if (/\(5\d\d\)/.test(message)) return '模型服务暂时异常';
  return message.slice(0, 120);
}

export function buildRewriteContext(project, chapter) {
  return writerContext(chapterContext(project, chapter));
}
