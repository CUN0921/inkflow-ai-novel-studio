import { parseJsonText } from './ai.mjs';
import { buildChapterHandoff, chapterContext, writerContext, contextFingerprint } from './chapter-context.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class WritingEngine {
  constructor(db, models) {
    this.db = db;
    this.models = models;
    this.controls = new Map();
  }

  async createPlan(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error('作品不存在');
    if (project.mode === 'short') return this.createShortStoryPlan(project);
    const ai = this.models.for('planner');
    if (!ai.enabled) return this.db.planDemo(projectId);

    const brief = `标题：${project.title}\n类型：${project.genre}\n核心创意：${project.premise}\n文风：${project.tone}\n目标字数：${project.target_words}\n模式：${project.mode}`;
    const foundation = await ai.generate({
      instructions: '你是长篇小说总编剧，擅长设计可持续推进的故事结构。保证人物目标、主线冲突与伏笔能够跨卷发展。',
      input: `${brief}\n\n先设计全书骨架，不生成章节。只返回紧凑 JSON：{"outline":"全书主线","world":"世界规则","characters":[{"name":"","role":"","desire":"","conflict":""}],"volumes":[{"number":1,"title":"","goal":""}],"foreshadows":[{"title":"","plantedChapter":1,"targetVolume":2,"visibleClue":"","truth":""}]}。至少3卷。`,
      maxOutputTokens: this.models.outputTokens?.('planner', 8000) ?? 8000,
      validate: text => validateFoundation(parseJsonText(text)),
      meta:{task:'plan-foundation',projectId}
    });
    const foundationValue = foundation.value ?? validateFoundation(parseJsonText(foundation.text));
    const recent = await ai.generate({
      instructions:'你是长篇小说章节策划。根据已经确定的全书骨架，输出短而具体、可以直接写作的近期章纲。',
      input:`${brief}\n全书骨架：${JSON.stringify(foundationValue)}\n\n只返回紧凑 JSON：{"chapters":[{"number":1,"title":"","outline":"核心行动、转折和结尾钩子","plan":{"openingState":"开场地点与人物状态","cast":["出场人物"],"goal":"本章目标","turn":"关键转折","mustHappen":"必须发生的事件","endingState":"结尾状态与钩子"}}]}。必须恰好10章，章号1到10连续，每章放入第1卷。`,
      maxOutputTokens:this.models.outputTokens?.('planner', 8000) ?? 8000,
      validate:text => validateChapters(parseJsonText(text),1,10),
      meta:{task:'plan-chapters',projectId}
    });
    const recentValue = recent.value ?? validateChapters(parseJsonText(recent.text),1,10);
    const plan = {...foundationValue, volumes:foundationValue.volumes.map((volume,index) => ({...volume,chapters:index===0 ? recentValue.chapters : []}))};
    return this.db.replacePlan(projectId, plan);
  }

  async createShortStoryPlan(project) {
    const ai = this.models.for('planner');
    if (!ai.enabled) return this.db.planDemo(project.id);
    const perspective = project.short_config?.perspective === 'third' ? '第三人称限知' : '第一人称';
    const result = await ai.generate({
      instructions:'你是中文短故事主编。设计一篇一次完结、可以直接写成全文的故事，不套用长篇分卷结构。开篇尽快建立异常、损失或冲突；情节持续升级，反转必须改变人物判断或处境；高潮同时兑现核心冲突和情绪压力；结尾回收悬念并完成情绪闭环。',
      input:`标题：${project.title}\n题材：${project.genre}\n核心创意：${project.premise}\n文风：${project.tone}\n目标字数：${project.target_words}\n叙事视角：${perspective}\n\n番茄短故事边界：全文6000–80000字，10000–30000字最佳，一篇文章完结，节奏紧凑、剧情起伏明显、情绪张力强。请只返回 JSON：{"outline":"完整故事主线","world":"只保留本故事必要的背景规则","characters":[{"name":"","role":"","desire":"","conflict":""}],"storyOutline":"可以直接写作的完整剧情，包含开篇、升级、至少两次有效反转、高潮和结局","plan":{"openingState":"开篇立即发生的事件","cast":["人物"],"goal":"核心行动目标","turn":"最大认知或处境反转","mustHappen":"必须兑现的冲突、反转和高潮","endingState":"最终结果与情绪余韵"},"shortStory":{"recommendedTitle":"推荐标题","titleOptions":["备选标题"],"category":"准确分类","perspective":"first或third","hook":"前三段钩子","coreConflict":"核心冲突","emotionalArc":"情绪曲线","reversals":["递进反转"],"climax":"高潮设计","ending":"结局闭环","trialHook":"适合在试读结束前形成解锁期待的情节点"}}。人物控制在2–5个，反转2–4次，不得把未解决悬念留给续集。`,
      maxOutputTokens:this.models.outputTokens?.('planner',8000) ?? 8000,
      validate:text=>validateShortStoryPlan(parseJsonText(text),project),
      meta:{task:'short-plan',projectId:project.id}
    });
    return this.db.replacePlan(project.id,result.value ?? validateShortStoryPlan(parseJsonText(result.text),project));
  }

  async extendPlan(projectId, options={}) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error('作品不存在');
    if (project.mode === 'short') throw new Error('短故事是一篇完结的完整稿件，不使用扩展章纲');
    const nextNumber = Math.max(0, ...project.chapters.map(ch => ch.number)) + 1;
    const desiredVolume = Math.min(project.volumes.length, Math.floor((nextNumber - 1) / 30) + 1);
    const volume = options.volumeNumber !== undefined ? project.volumes.find(v => v.number === Number(options.volumeNumber))
      : project.volumes.find(v => v.number === desiredVolume) || project.volumes.at(-1);
    if (!volume) throw new Error('请先生成全书方案');
    const count = options.count === undefined ? 10 : Number(options.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('每次扩展章纲数量需在 1 到 10 之间');
    const pending = project.chapters.filter(ch => ch.status !== 'completed');
    let chapters;
    const ai = this.models.for('planner');
    if (ai.enabled) {
      const result = await ai.generate({
        instructions:'你是长篇小说总编剧。根据已经完成的正文事实和分卷目标，设计紧接着发生的近期剧情，保持因果关系并推进主线。',
        input:`${this.buildContext(project, {number:nextNumber,title:'下一章',outline:'待规划',plan:{},volume_id:volume.id})}\n全部分卷目标：${JSON.stringify(project.volumes.map(({number,title,goal}) => ({number,title,goal})))}\n已有待写章纲（未来计划，不是已发生事实；承接这些计划之后展开，不得重复规划）：\n${pending.map(ch => `第${ch.number}章《${ch.title}》：${ch.outline}；结构：${JSON.stringify(ch.plan || {})}；用户要求：${ch.writing_instructions || '无'}`).join('\n') || '无'}\n用户对本次扩展的要求：${String(options.instruction || '').trim() || '承接已有剧情，推进本卷目标'}\n当前分卷目标：${volume.goal}\n请规划第${nextNumber}章到第${nextNumber+count-1}章。只返回 JSON：{"chapters":[{"number":${nextNumber},"title":"","outline":"核心行动、转折和结尾钩子","plan":{"openingState":"","cast":[],"goal":"","turn":"","mustHappen":"","endingState":""}}]}。必须恰好${count}章，章号连续。`,
        maxOutputTokens:this.models.outputTokens?.('planner', 8000) ?? 8000,
        validate:text => validateChapters(parseJsonText(text),nextNumber,count),
        meta:{task:'extend-plan',projectId}
      });
      chapters = (result.value ?? validateChapters(parseJsonText(result.text),nextNumber,count)).chapters;
    } else {
      const actions = ['旧线索的新解释','意外的同行者','被打破的约定','规则背后的规则','对手留下的空位','一次失败的试探','不能公开的证词','选择造成的裂痕','第二把钥匙','更深处的门'];
      chapters = actions.slice(0,count).map((title,index) => ({
        number:nextNumber+index,
        title,
        outline:`围绕“${volume.goal}”继续推进：承接前章结果，让人物通过具体行动获得新信息，并以新的选择或风险结束本章。`
      }));
    }
    if (!Array.isArray(chapters) || chapters.length !== count || chapters.some((ch,i) => ch.number !== nextNumber+i || typeof ch.title !== 'string' || !ch.title.trim() || typeof ch.outline !== 'string' || !ch.outline.trim())) throw new Error(`模型没有返回连续且完整的${count}章规划，请重试`);
    if (Math.max(0, ...this.db.getProject(projectId).chapters.map(ch => ch.number)) + 1 !== nextNumber) throw new Error('章纲已由另一个请求扩展，请刷新后重试');
    return this.db.appendChapters(projectId, volume.number, chapters);
  }

  start(projectId, options = {}) {
    const active = [...this.controls.entries()].find(([,ctl]) => ctl.projectId === projectId);
    if (active) throw new Error('该作品已有写作任务正在运行');
    const project = this.db.getProject(projectId);
    if (!project) throw new Error('作品不存在');
    const normalized = typeof options === 'number' ? {count:options} : options;
    const requested = normalized.chapterIds ?? project.chapters.filter(ch => ch.status !== 'completed' && !ch.content.trim()).slice(0, Math.max(1,Math.min(10,Number(normalized.count) || 1))).map(ch => ch.id);
    if (!Array.isArray(requested) || !requested.length || requested.length > 10 || new Set(requested).size !== requested.length) throw new Error('请选择 1 到 10 个不重复的章节');
    const selected = requested.map(id => project.chapters.find(ch => ch.id === id));
    if (selected.some(ch => !ch)) throw new Error('所选章节不属于当前作品');
    if (normalized.continueDraft) {
      if (selected.length !== 1 || selected[0].status !== 'draft' || !selected[0].content.trim()) throw new Error('只能续写一章尚未完成的草稿');
    } else if (selected.some(ch => ch.status === 'completed' || ch.content.trim())) {
      throw new Error('所选章节已有正文，请使用“重写本章”生成候选稿');
    }
    if (selected.some(ch => !ch.outline.trim())) throw new Error('请先填写并保存所选章节的章纲');
    selected.sort((a,b) => a.number - b.number);
    const run = this.db.createRun(projectId, selected.length, selected.map(ch => ch.id), normalized.continueDraft ? 'continue' : 'write', normalized);
    const control = { projectId, stopped:false };
    this.controls.set(run.id, control);
    this.execute(run.id, control).catch(error => {
      this.db.updateRun(run.id, { status:'failed', currentStep:'failed', message:error.message });
    }).finally(() => this.controls.delete(run.id));
    return run;
  }

  resume(runId) {
    const run = this.db.getRun(runId);
    if (!run || !['running','paused','failed'].includes(run.status)) return null;
    if ([...this.controls.values()].some(control => control.projectId === run.project_id)) return null;
    const control = {projectId:run.project_id, stopped:false, resumeStep:run.current_step};
    this.controls.set(run.id, control);
    this.db.updateRun(run.id, {status:'running',currentStep:'resuming', message:'服务已恢复，正在从最近安全保存的步骤继续'});
    const execution = run.task_type === 'review' ? this.executeReviewOnly(run.id, control) : this.execute(run.id, control);
    execution.catch(error => {
      this.db.updateRun(run.id, {status:'failed', currentStep:'failed', message:error.message});
    }).finally(() => this.controls.delete(run.id));
    return run;
  }

  stop(runId) {
    const control = this.controls.get(runId);
    if (control) control.stopped = true;
    const run = this.db.getRun(runId);
    if (run?.status === 'running') return this.db.updateRun(runId, { currentStep:'pausing', message:'正在完成当前步骤并安全保存…' });
    return run;
  }

  stopProject(projectId) {
    for (const [runId, control] of this.controls) {
      if (control.projectId === projectId) this.stop(runId);
    }
  }

  startReview(chapterId) {
    const chapter = this.db.getChapter(chapterId);
    if (!chapter || !(chapter.content || '').trim()) throw new Error('没有可审稿的正文');
    const active = [...this.controls.values()].find(control => control.projectId === chapter.project_id);
    if (active) throw new Error('该作品已有任务正在运行');
    const run = this.db.createRun(chapter.project_id, 1, [chapter.id], 'review');
    const control = {projectId:chapter.project_id,stopped:false};
    this.controls.set(run.id,control);
    this.executeReviewOnly(run.id,control).catch(error => {
      this.db.updateRun(run.id,{status:'failed',currentStep:'failed',message:error.message});
    }).finally(()=>this.controls.delete(run.id));
    return run;
  }

  async executeReviewOnly(runId, control) {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.project_id);
    const chapter = project?.chapters.find(item => item.id === run.chapter_ids[0]);
    if (!project || !chapter || !chapter.content.trim()) throw new Error('待审稿正文不存在');
    const qualityReview = this.models.reviewEnabled !== false;
    this.db.updateRun(runId,{currentStep:qualityReview ? 'reviewing' : 'extracting',activeChapterId:chapter.id,
      message:qualityReview ? `正在重新审稿第 ${chapter.number} 章` : `正在更新第 ${chapter.number} 章的故事资料`});
    const review = qualityReview ? await this.reviewChapter(project,chapter,chapter.content) : await this.extractChapterState(project,chapter,chapter.content);
    const current = this.db.getChapter(chapter.id);
    if (!current || current.revision !== chapter.revision || current.content !== chapter.content) throw new Error('正文或参考资料已变更，请重新发起审稿');
    const critical = this.saveReviewedChapter(project,current,review,runId,1,qualityReview);
    if (critical) return this.db.updateRun(runId,{status:'paused',currentStep:'needs-attention',message:`第 ${chapter.number} 章仍有严重一致性问题，后续写作已暂停`});
    if (control.stopped) return this.db.updateRun(runId,{status:'paused',currentStep:'paused',message:'本章资料已保存，任务已暂停'});
    return this.db.updateRun(runId,{status:'completed',completedChapters:1,currentStep:'completed',activeChapterId:null,
      message:qualityReview ? `第 ${chapter.number} 章重新审稿并保存完成` : `第 ${chapter.number} 章故事资料更新完成`});
  }

  async execute(runId, control) {
    const run = this.db.getRun(runId);
    // Existing runs from earlier versions receive an explicit remaining queue once.
    if (!run.chapter_ids?.length) {
      const ids = this.db.getProject(run.project_id).chapters.filter(ch => ch.status !== 'completed' && !ch.content.trim()).slice(0,run.requested_chapters-run.completed_chapters).map(ch => ch.id);
      run.chapter_ids = [...Array(run.completed_chapters).fill(null), ...ids];
      this.db.run('UPDATE runs SET chapter_ids=? WHERE id=?', JSON.stringify(run.chapter_ids), runId);
    }
    let completed = run.completed_chapters;
    for (let i = completed; i < run.requested_chapters; i++) {
      if (control.stopped) break;
      let project = this.db.getProject(run.project_id);
      let chapter = project.chapters.find(ch => ch.id === run.chapter_ids[i]);
      if (!chapter) {
        this.db.updateRun(runId, { status:'paused', completedChapters:completed, currentStep:'planning-needed', message:'近期章纲已经写完，请先扩展下一批章纲' });
        return;
      }
      if (chapter.status === 'completed') throw new Error(`第${chapter.number}章已经完成，任务停止以保留你的正文`);
      const reviewEnabled = this.models.reviewEnabled !== false;
      let savedDraft = chapter;
      if (!chapter.content.trim()) {
        const snapshot = chapterContext(project,chapter);
        const basis = contextFingerprint(snapshot);
        this.db.updateRun(runId, { completedChapters:completed, currentStep:'writing',activeChapterId:chapter.id, message:`正在写第 ${chapter.number} 章《${chapter.title}》` });
        let draft;
        try {
          draft = await this.writeChapter(project, chapter, runId);
        } catch (error) {
          if (String(error.responseText || '').trim()) {
            this.db.saveChapter(chapter.id,{content:error.responseText,summary:'',status:'draft',reviewScore:null,contextStale:1,contextSnapshot:snapshot,expectedRevision:chapter.revision});
            error.message = `${error.message}；已保存模型返回的部分正文，可点击“续写草稿”继续`;
          }
          throw error;
        }
        const beforeDraft = this.db.getProject(project.id);
        const currentBeforeDraft = beforeDraft?.chapters.find(ch => ch.id === chapter.id);
        if (!currentBeforeDraft || basis !== contextFingerprint(chapterContext(beforeDraft,currentBeforeDraft))) throw new Error(`第${chapter.number}章的计划、正文或参考资料已变更，请重新选择本章写作`);
        savedDraft = this.db.saveChapter(chapter.id,{content:draft.content,summary:'',status:'draft',reviewScore:null,contextStale:1,contextSnapshot:snapshot,expectedRevision:chapter.revision});
      } else if (chapter.status !== 'draft') {
        throw new Error(`第${chapter.number}章已有正文，任务停止以保留你的修改`);
      } else if (run.task_type === 'continue' && !['reviewing','extracting','saving'].includes(control.resumeStep || '')) {
        const snapshot = chapterContext(project,chapter);
        this.db.updateRun(runId,{completedChapters:completed,currentStep:'continuing',activeChapterId:chapter.id,message:`正在续写第 ${chapter.number} 章`});
        const addition = await this.continueChapter(project,chapter,runId);
        const current = this.db.getChapter(chapter.id);
        if (!current || current.revision !== chapter.revision || current.content !== chapter.content) throw new Error('续写期间正文或章纲已变化，请重新发起');
        savedDraft = this.db.saveChapter(chapter.id,{content:`${chapter.content.trimEnd()}\\n\\n${addition}`,status:'draft',contextStale:1,contextSnapshot:snapshot,expectedRevision:chapter.revision});
      }

      if (control.stopped) {
        this.db.updateRun(runId,{status:'paused',completedChapters:completed,currentStep:'paused',message:'当前正文已安全保存，任务已暂停'});
        return;
      }
      project = this.db.getProject(project.id);
      chapter = project.chapters.find(item => item.id === savedDraft.id);
      this.db.updateRun(runId, { completedChapters:completed, currentStep:reviewEnabled ? 'reviewing' : 'extracting',activeChapterId:chapter.id,
        message:reviewEnabled ? `正在检查第 ${chapter.number} 章` : `正在整理第 ${chapter.number} 章的摘要、人物和衔接资料` });
      const review = reviewEnabled ? await this.reviewChapter(project, chapter, savedDraft.content) : await this.extractChapterState(project,chapter,savedDraft.content);
      const currentChapter = this.db.getChapter(chapter.id);
      if (!currentChapter || currentChapter.revision !== savedDraft.revision || currentChapter.content !== savedDraft.content) throw new Error(`第${chapter.number}章正文已变更，请重新发起审稿`);
      this.db.db.exec('BEGIN IMMEDIATE');
      let critical = false;
      try {
      const finalContent = review.revisedContent || savedDraft.content;
      const finalSummary = review.summary || '';
      const finalVersion = savedDraft.version + (finalContent !== savedDraft.content ? 1 : 0);
      critical = reviewEnabled && review.issues.some(issue => issue.severity === 'critical');
      this.db.saveChapter(chapter.id, {
        content: finalContent, summary: finalSummary,
        status:critical ? 'draft' : 'completed', reviewScore:reviewEnabled ? (review.score ?? 80) : null, contextStale:critical ? 1 : 0,
        planResult:review.planCheck || {},
        handoff:buildChapterHandoff(review.handoff, {chapterNumber:chapter.number, sourceVersion:finalVersion, content:finalContent, summary:finalSummary}),
        expectedRevision:savedDraft.revision
      });
      this.db.run('DELETE FROM memories WHERE project_id=? AND source_chapter=?',project.id,chapter.number);
      for (const memory of review.memories || []) {
        this.db.addMemory(project.id, { ...memory, sourceChapter:chapter.number });
      }
      this.db.mergeCharacters(project.id,review.characters,chapter.number);
      this.db.updateForeshadows(project.id,review.foreshadows,chapter.number);
      for (const issue of review.issues || []) {
        if (issue.severity === 'critical') this.db.addIssue(project.id, { ...issue, chapterNumber:chapter.number });
      }
      if (!critical) completed++;
      const projectStatus = project.mode === 'short' && !critical ? 'completed' : 'writing';
      this.db.run('UPDATE projects SET current_chapter=MAX(current_chapter,?),status=?,updated_at=? WHERE id=?', chapter.number, projectStatus, new Date().toISOString(), project.id);
      this.db.updateRun(runId, { completedChapters:completed, currentStep:critical ? 'needs-attention' : 'saved',
        message:critical ? `第 ${chapter.number} 章仍有严重一致性问题` : `第 ${chapter.number} 章已保存，故事资料已更新` });
      this.db.db.exec('COMMIT');
      } catch (error) { this.db.db.exec('ROLLBACK'); throw error; }
      if (critical) {
        this.db.updateRun(runId,{status:'paused',completedChapters:completed,currentStep:'needs-attention',message:`第 ${chapter.number} 章仍有严重一致性问题，后续写作已暂停`});
        return;
      }
      if (control.stopped) break;
      await wait(this.models.enabledFor('writer') ? 300 : 450);
    }
    if (control.stopped) {
      this.db.updateRun(runId, { status:'paused', completedChapters:completed, currentStep:'paused', message:'任务已暂停，可随时继续' });
    } else {
      this.db.updateRun(runId, { status:'completed', completedChapters:completed, currentStep:'completed',activeChapterId:null, message:`已完成 ${completed} 章` });
    }
  }

  saveReviewedChapter(project, chapter, review, runId, completed, qualityReview=true) {
    this.db.db.exec('BEGIN IMMEDIATE');
    let critical = false;
    try {
      const finalContent = review.revisedContent || chapter.content;
      const finalVersion = chapter.version + (finalContent !== chapter.content ? 1 : 0);
      critical = qualityReview && review.issues.some(issue => issue.severity === 'critical');
      this.db.saveChapter(chapter.id,{content:finalContent,summary:review.summary,status:critical ? 'draft' : 'completed',reviewScore:qualityReview ? review.score : null,contextStale:critical ? 1 : 0,planResult:review.planCheck || {},
        handoff:buildChapterHandoff(review.handoff, {chapterNumber:chapter.number, sourceVersion:finalVersion, content:finalContent, summary:review.summary}), expectedRevision:chapter.revision});
      this.db.run('DELETE FROM memories WHERE project_id=? AND source_chapter=?',project.id,chapter.number);
      for (const memory of review.memories) this.db.addMemory(project.id,{...memory,sourceChapter:chapter.number});
      this.db.mergeCharacters(project.id,review.characters,chapter.number);
      this.db.updateForeshadows(project.id,review.foreshadows,chapter.number);
      for (const issue of review.issues) if (issue.severity === 'critical') this.db.addIssue(project.id,{...issue,chapterNumber:chapter.number});
      const projectStatus = project.mode === 'short' && !critical ? 'completed' : 'writing';
      this.db.run('UPDATE projects SET current_chapter=MAX(current_chapter,?),status=?,updated_at=? WHERE id=?',chapter.number,projectStatus,new Date().toISOString(),project.id);
      this.db.updateRun(runId,{completedChapters:completed,currentStep:'saved',message:`第 ${chapter.number} 章已保存，故事记忆已更新`});
      this.db.db.exec('COMMIT');
    } catch(error) { this.db.db.exec('ROLLBACK'); throw error; }
    return critical;
  }

  buildContext(project, chapter) {
    return writerContext(chapterContext(project, chapter));
  }

  async writeChapter(project, chapter, runId=null) {
    const ai = this.models.for('writer');
    if (!ai.enabled) return mockChapter(project, chapter);
    const shortStory = project.mode === 'short';
    const perspective = project.short_config?.perspective === 'third' ? '第三人称限知' : '第一人称';
      const result = await ai.generate({
      instructions: shortStory
        ? `你是职业中文短故事作者。使用${perspective}，文风要求：${project.tone || '叙事清晰、节奏紧凑、情绪有层次'}。全文必须在一篇内完结：开篇前三段进入事件，围绕一个核心冲突持续升级，用2–4次有效反转改变人物处境，在高潮兑现最大压力，结尾回收核心悬念并完成情绪闭环。避免背景堆砌、重复冲突、无关作者话语和续集式悬而不决。`
        : `你是职业中文小说作者。写作风格：${project.tone || '叙事清晰，场景具体'}。严格依据已发生事实，不把未来计划写成过去。正文要有场景、动作、对话、感官细节与章节钩子。`,
      input: `${this.buildContext(project, chapter)}\n\n${shortStory ? `短故事专项规划：${JSON.stringify(project.short_config || {})}\n\n请直接写完整短故事正文，目标约${chapter.target_words || project.target_words || 15000}字。正文可以使用自然分段和少量文内分隔，但不要输出创作说明、JSON或“第X章”标题。` : `请按用户章纲和单章要求直接写本章正文，约${chapter.target_words || 3000}字，不要解释，不要标题。`}`,
      maxOutputTokens: this.models.outputTokens?.('writer', 24000) ?? 24000,
      streamProgress:true,
      meta:{task:'write',projectId:project.id,chapterId:chapter.id,runId:runId || project.latest_run?.id}
    });
    return { content:result.text, summary:`第${chapter.number}章推进了“${chapter.outline}”`, memories:[] };
  }

  async continueChapter(project, chapter, runId=null) {
    const ai = this.models.for('writer');
    if (!ai.enabled) return mockChapter(project,chapter).content;
    const remaining = Math.max(500,(chapter.target_words || 3000) - Number(chapter.word_count || 0));
    const shortStory = project.mode === 'short';
    const result = await ai.generate({
      instructions:shortStory ? '你是中文短故事作者。续写必须紧接草稿最后一句，保持叙事视角、语气、人物状态和场景连续，不复述前文；继续升级核心冲突，并在本篇内完成高潮、真相回收和情绪闭环。' : '你是职业中文小说作者。续写必须紧接已有草稿最后一句，保持视角、语气、人物状态和场景连续，不重复前文。',
      input:`${this.buildContext(project,chapter)}\n\n已有草稿：\n${chapter.content}\n\n请从最后一句之后继续写约${remaining}字，${shortStory ? '完成整篇短故事，不要留下依赖续集解决的核心悬念' : '完成本章章纲和结尾钩子'}。只返回新增正文，不要重复已有草稿，不要解释。`,
      maxOutputTokens:this.models.outputTokens?.('writer',24000) ?? 24000,
      streamProgress:true,
      meta:{task:'continue',projectId:project.id,chapterId:chapter.id,runId}
    });
    return result.text.trim();
  }

  async reviewChapter(project, chapter, content) {
    const ai = this.models.for('reviewer');
    if (!ai.enabled) return mockReview(project, chapter, content);
    const result = await ai.generate({
      instructions: project.mode === 'short' ? '你是中文短故事责任编辑。检查开篇是否迅速进入事件、核心冲突是否集中、反转是否真正改变处境、情绪是否递进、视角是否统一、高潮和结局是否闭环，以及是否存在重复、无关内容或不规范分段。只在确有必要时修订正文。' : '你是长篇小说责任编辑。检查设定一致性、时间线、人物知识边界、场景推进、重复与拖沓。只在确有必要时修订正文。',
      input: `${this.buildContext(project, chapter)}\n\n待检查正文：\n${content}\n\n只返回 JSON：{"score":0到100,"summary":"100字内事实摘要","revisedContent":"若需修改则返回完整修订正文，否则空字符串","planCheck":{"goal":"done|partial|missing","turn":"done|partial|missing","mustHappen":"done|partial|missing","endingState":"done|partial|missing","note":"简短说明"},"memories":[{"kind":"character|event|item|knowledge|relationship|timeline","subject":"主体","fact":"确定事实","importance":1}],"characters":[{"name":"人物","role":"身份","aliases":[],"relationship":"当前关系","goal":"当前目标","location":"结尾位置","state":"结尾状态","importance":"major|minor"}],"foreshadows":[{"title":"线索名","status":"planted|advanced|resolved","evidence":"本章实际进展"}],"issues":[{"severity":"notice|critical","category":"continuity|pacing|character|timeline","message":"问题"}],"handoff":{"location":"结尾地点","time":"结尾时间","characterStates":[],"lastAction":"最后动作","emotionalState":"结尾情绪","newKnowledge":[],"carriedItems":[],"unresolved":[],"nextOpening":"下一章承接点","lastLine":"正文最后一句"}}。先在 revisedContent 中修正能够安全修正的问题；critical 只保留修订后仍会导致后文错误的问题。所有资料只依据最终正文，不得记录未来计划。${project.mode === 'short' ? ' 短故事的核心冲突、关键反转、高潮或结局仍未完成时必须标记 critical。' : ''}`,
      maxOutputTokens: this.models.outputTokens?.('reviewer', 6000) ?? 6000,
      validate:text => validateReview(parseJsonText(text)),
      meta:{task:'review',projectId:project.id,chapterId:chapter.id}
    });
    return result.value ?? validateReview(parseJsonText(result.text));
  }

  async extractChapterState(project,chapter,content) {
    const ai = this.models.for('reviewer');
    if (!ai.enabled) return mockExtraction(project,chapter,content);
    const result = await ai.generate({
      instructions:'你是小说资料整理员。不要评价文笔，不要修改正文，只提取后续写作需要的已发生事实。',
      input:`${this.buildContext(project,chapter)}\n\n本章正文：\n${content}\n\n只返回 JSON：{"summary":"100字内事实摘要","planCheck":{"goal":"done|partial|missing","turn":"done|partial|missing","mustHappen":"done|partial|missing","endingState":"done|partial|missing","note":"简短说明"},"memories":[{"kind":"character|event|item|knowledge|relationship|timeline","subject":"主体","fact":"确定事实","importance":1}],"characters":[{"name":"实际出现的人物","role":"身份","aliases":[],"relationship":"当前关系","goal":"当前目标","location":"结尾位置","state":"结尾状态","importance":"major|minor"}],"foreshadows":[{"title":"线索名","status":"planted|advanced|resolved","evidence":"实际进展"}],"handoff":{"location":"结尾地点","time":"结尾时间","characterStates":[],"lastAction":"最后动作","emotionalState":"结尾情绪","newKnowledge":[],"carriedItems":[],"unresolved":[],"nextOpening":"下一章承接点","lastLine":"正文最后一句"}}。不得评分、审稿或改写正文。`,
      maxOutputTokens:this.models.outputTokens?.('reviewer',6000) ?? 6000,
      validate:text => validateExtraction(parseJsonText(text)),
      meta:{task:'extract',projectId:project.id,chapterId:chapter.id}
    });
    return result.value ?? validateExtraction(parseJsonText(result.text));
  }
}

function validateShortStoryPlan(value,project) {
  if (!value || typeof value.outline !== 'string' || !value.outline.trim() || typeof value.world !== 'string' || !value.world.trim()) throw new Error('短故事主线或必要背景缺失');
  if (!Array.isArray(value.characters) || value.characters.length < 2 || value.characters.length > 5 || value.characters.some(item=>!item?.name || !item?.role)) throw new Error('短故事需要 2 到 5 个完整人物设定');
  if (typeof value.storyOutline !== 'string' || !value.storyOutline.trim() || !value.plan || typeof value.plan !== 'object') throw new Error('短故事完整剧情或结构计划缺失');
  const short = value.shortStory;
  if (!short || typeof short !== 'object' || !short.recommendedTitle || !short.hook || !short.coreConflict || !short.emotionalArc || !short.climax || !short.ending) throw new Error('短故事钩子、冲突、情绪、高潮或结局规划不完整');
  if (!Array.isArray(short.reversals) || short.reversals.length < 2) throw new Error('短故事至少需要两个递进反转');
  const perspective = project.short_config?.perspective === 'third' ? 'third' : 'first';
  return {
    outline:value.outline.trim(), world:value.world.trim(), characters:value.characters,
    volumes:[{number:1,title:'完整故事',goal:String(short.coreConflict),chapters:[{
      number:1,title:'完整故事',outline:value.storyOutline.trim(),targetWords:Number(project.target_words) || 15000,plan:value.plan
    }]}],
    foreshadows:[],
    shortConfig:{
      perspective,recommendedTitle:String(short.recommendedTitle),titleOptions:Array.isArray(short.titleOptions) ? short.titleOptions : [],
      category:String(short.category || project.genre || ''),hook:String(short.hook),coreConflict:String(short.coreConflict),
      emotionalArc:String(short.emotionalArc),reversals:short.reversals,climax:String(short.climax),ending:String(short.ending),trialHook:String(short.trialHook || '')
    }
  };
}

function validateFoundation(value) {
  if (!value || typeof value.outline !== 'string' || !value.outline.trim() || typeof value.world !== 'string' || !value.world.trim()) throw new Error('全书主线或世界规则缺失');
  if (!Array.isArray(value.characters) || !value.characters.length || value.characters.some(item => !item?.name || !item?.role)) throw new Error('主要人物不完整');
  if (!Array.isArray(value.volumes) || value.volumes.length < 3 || value.volumes.some((item,index) => item?.number !== index+1 || !item?.title || !item?.goal)) throw new Error('分卷结构不完整或卷号不连续');
  if (!Array.isArray(value.foreshadows)) value.foreshadows = [];
  return value;
}

function validateChapters(value, start, count) {
  if (!value || !Array.isArray(value.chapters) || value.chapters.length !== count || value.chapters.some((item,index) => item?.number !== start+index || typeof item.title !== 'string' || !item.title.trim() || typeof item.outline !== 'string' || !item.outline.trim())) throw new Error(`需要返回第${start}章起连续且完整的${count}章章纲`);
  for (const chapter of value.chapters) if (!chapter.plan || typeof chapter.plan !== 'object') chapter.plan = {};
  return value;
}

function validateReview(value) {
  if (!value || typeof value.score !== 'number' || value.score < 0 || value.score > 100) throw new Error('审稿评分无效');
  if (typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('本章事实摘要缺失');
  if (!Array.isArray(value.memories) || !Array.isArray(value.issues)) throw new Error('故事记忆或问题列表缺失');
  value.characters = Array.isArray(value.characters) ? value.characters : [];
  value.foreshadows = Array.isArray(value.foreshadows) ? value.foreshadows : [];
  value.planCheck = normalizePlanCheck(value.planCheck);
  value.revisedContent = typeof value.revisedContent === 'string' ? value.revisedContent : '';
  value.handoff = value.handoff && typeof value.handoff === 'object' && !Array.isArray(value.handoff) ? value.handoff : {};
  return value;
}

function validateExtraction(value) {
  if (!value || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.memories)) throw new Error('故事资料整理结果不完整');
  value.revisedContent = '';
  value.score = null;
  value.issues = [];
  value.characters = Array.isArray(value.characters) ? value.characters : [];
  value.foreshadows = Array.isArray(value.foreshadows) ? value.foreshadows : [];
  value.planCheck = normalizePlanCheck(value.planCheck);
  value.handoff = value.handoff && typeof value.handoff === 'object' && !Array.isArray(value.handoff) ? value.handoff : {};
  return value;
}

function normalizePlanCheck(value={}) {
  const input=value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state=key => ['done','partial','missing'].includes(input[key]) ? input[key] : 'partial';
  return {goal:state('goal'),turn:state('turn'),mustHappen:state('mustHappen'),endingState:state('endingState'),note:String(input.note || '')};
}

function mockChapter(project, chapter) {
  const hero = project.characters[0]?.name || '主人公';
  const chapterScenes = [
    `事情发生在一个看似寻常的清晨。${hero}原本以为，关于“${project.premise}”的传闻只是人们用来打发漫长时间的故事。直到一个不该出现的细节摆在眼前，周围熟悉的一切才显出微妙的裂缝。`,
    `他没有立刻行动，而是把眼前所见与记忆逐一比对。章纲中的目标——${chapter.outline}——像一根看不见的线，牵着那些零散迹象渐渐靠拢。最令人不安的并非未知，而是其中一处细节，他分明曾经见过，却无论如何想不起是在何时。`,
    `“如果你现在离开，还能假装什么都没发生。”来人站在门边说。\n\n${hero}看了对方片刻：“你特意来告诉我这句话，就说明已经来不及了。”`,
    `短暂的沉默改变了两人之间的距离。对方交出的线索只能证明一半事实，另一半则指向更危险的方向。${hero}知道这可能是圈套，但也知道继续等待只会把选择交给别人。他把线索收好，第一次主动跨进了冲突之中。`,
    `行动并不顺利。原先的判断在关键处出了偏差，迫使他用更直接的方式解决眼前危机。当混乱终于平息，留下的痕迹却表明有人早已预料到他的每一步。`,
    `夜色落下时，${hero}重新整理今天发生的事。表面的问题暂时解决，真正的疑问却第一次有了清晰轮廓。他在纸上写下一个名字，笔尖停了很久，又在旁边添了一句话：这不是第一次。`
  ];
  const content = chapterScenes.join('\n\n');
  return {
    content,
    summary:`${hero}依据神秘来信阻止了一场事故，发现此前还有十二封被遗忘的信，并获得一张与十年前有关的照片。`,
    memories:[
      {kind:'event',subject:hero,fact:`在第${chapter.number}章依据神秘来信采取行动，并发现信件与过去有关。`},
      {kind:'item',subject:'神秘来信',fact:`第${chapter.number}章出现，能够预告尚未发生的事件。`}
    ]
  };
}

function mockReview(project, chapter, content) {
  const hero = project.characters[0]?.name || '主人公';
  return {
    score:86,
    summary:`${hero}在第${chapter.number}章沿着“${chapter.outline}”行动，获得一条指向过去的新线索，故事主线继续推进。`,
    revisedContent:'',
    memories:[
      {kind:'event',subject:hero,fact:`完成第${chapter.number}章的核心行动，并获得新的过去线索。`},
      {kind:'knowledge',subject:hero,fact:`截至第${chapter.number}章，已确认预告事件的信件真实存在。`}
    ],
    issues:[]
  };
}

function mockExtraction(project,chapter,content) {
  const result = mockReview(project,chapter,content);
  return {...result,score:null,issues:[],characters:[],foreshadows:[],revisedContent:'',
    handoff:buildChapterHandoff({}, {chapterNumber:chapter.number,sourceVersion:chapter.version,content,summary:result.summary})};
}
