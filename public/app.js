const state = { dashboard:null, project:null, chapter:null, context:null, run:null, poll:null, modelPoll:null, modelEvents:[], memoryFilter:'all', similarityPoll:null, rewritePoll:null, rewrite:null, health:null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(path, options={}) {
  const response = await fetch(path, { headers:{'Content-Type':'application/json'}, ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('json') ? response.json() : response.text();
}

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const fmt = value => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
const statusText = status => ({planning:'规划中',ready:'待开篇',writing:'创作中',completed:'已完成'}[status] || status);
const kindText = kind => ({character:'人物',event:'事件',item:'物品',knowledge:'认知',relationship:'关系',timeline:'时间线'}[kind] || kind);

async function init() {
  bindEvents();
  try {
    [state.dashboard, state.health] = await Promise.all([api('/api/dashboard'), api('/api/health')]);
    renderDashboard(); renderHealth();
  } catch (error) { toast(error.message, true); }
}

function bindEvents() {
  $('#newProjectBtn').onclick = $('#heroNewBtn').onclick = () => $('#newProjectDialog').showModal();
  $('#settingsBtn').onclick = openSettings;
  $('#settingsForm').onsubmit = saveSettings;
  $('#testModelsBtn').onclick = testModels;
  $$('.close-dialog').forEach(btn => btn.onclick = () => btn.closest('dialog').close());
  $$('.nav-item').forEach(btn => btn.onclick = () => showView(btn.dataset.view));
  $('#newProjectForm').onsubmit = createProject;
  $('#planBtn').onclick = createPlan;
  $('#writeBtn').onclick = openWriteDialog;
  $('#writeForm').onsubmit = startWriting;
  $('#extendPlanForm').onsubmit = extendPlan;
  $('#exportBtn').onclick = () => { if (state.project) location.href = `/api/projects/${state.project.id}/export`; };
  $$('#workspaceTabs button').forEach(btn => btn.onclick = () => selectTab(btn.dataset.tab));
  $$('.memory-filters button').forEach(btn => btn.onclick = () => { state.memoryFilter = btn.dataset.memoryFilter || 'all'; renderMemories(); });
}

function renderHealth() {
  const models = state.health?.models || [];
  const active = models.filter(item => item.enabled);
  const live = active.length > 0;
  $('#aiDot').classList.toggle('live', live);
  $('#aiLabel').textContent = active.length === models.length && active.length ? '多模型已配置' : (live ? '部分模型已配置' : '演示模式');
  $('#aiModel').textContent = live ? `${active.length} 个任务模型已配置` : '无需密钥即可体验';
  $('#settingsMode').textContent = live ? `已配置 ${active.length} / ${models.length} 个任务模型` : '当前为演示模式';
  $('#modelProfiles').innerHTML = models.map(item => `<div class="model-profile"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.model)}</span><small class="${item.enabled?'':'off'}">${item.enabled?'已连接':'演示'}</small><span class="model-endpoint">${item.protocol === 'chat' ? 'Chat Completions' : 'Responses'} · ${escapeHtml(item.endpoint)}</span></div>`).join('');
}

async function testModels() {
  const btn = $('#testModelsBtn');
  btn.disabled = true; btn.textContent = '正在测试…';
  try {
    const data = await api('/api/models/test', {method:'POST', body:'{}'});
    const failed = data.results.filter(item => !item.ok && item.enabled);
    const passed = data.results.filter(item => item.ok);
    $('#settingsFeedback').textContent = data.results.map(item => `${item.label}：${item.ok?'连接通过':item.enabled?'连接失败':'未配置'}${item.ok?'':`（${item.message}）`}`).join('\n');
    await refreshHealth();
    toast(failed.length ? `${passed.length} 项可用，${failed.length} 项失败：${failed[0].message}` : `${passed.length} 个任务模型连接正常`, failed.length > 0);
  } catch(error) { toast(error.message, true); }
  finally { btn.disabled = false; btn.textContent = '测试已保存的连接'; }
}

async function refreshHealth() { state.health = await api('/api/health'); renderHealth(); }

async function openSettings() {
  $('#settingsDialog').showModal();
  $('#settingsFeedback').textContent = '正在读取设置…';
  $('#modelSettingsFields').innerHTML = '';
  $('#saveSettingsBtn').disabled = true;
  try {
    const data = await api('/api/settings');
    $('#reviewEnabled').checked = data.reviewEnabled;
    $('#modelSettingsFields').innerHTML = data.profiles.map(p => `<fieldset class="model-setting" data-role="${escapeHtml(p.role)}"><legend>${escapeHtml(p.label)}</legend><label>API 地址<input name="baseUrl" type="url" required value="${escapeHtml(p.baseUrl)}" placeholder="https://…/v1"></label><div class="form-row"><label>模型名称<input name="model" required value="${escapeHtml(p.model)}"></label><label>接口协议<select name="protocol"><option value="responses" ${p.protocol==='responses'?'selected':''}>Responses</option><option value="chat" ${p.protocol==='chat'?'selected':''}>Chat Completions</option></select></label></div><div class="form-row"><label>输出 Token 预算<input name="outputTokens" type="number" min="256" max="32768" step="1" required value="${p.outputTokens}"></label><label>推理模式<select name="reasoningEffort"><option value="auto" ${p.reasoningEffort==='auto'?'selected':''}>自动</option><option value="none" ${p.reasoningEffort==='none'?'selected':''}>关闭思考</option><option value="minimal" ${p.reasoningEffort==='minimal'?'selected':''}>最低</option><option value="low" ${p.reasoningEffort==='low'?'selected':''}>低</option><option value="medium" ${p.reasoningEffort==='medium'?'selected':''}>中</option><option value="high" ${p.reasoningEffort==='high'?'selected':''}>高</option><option value="xhigh" ${p.reasoningEffort==='xhigh'?'selected':''}>更高</option><option value="max" ${p.reasoningEffort==='max'?'selected':''}>最大</option></select></label></div><small class="field-hint">输出预算包含模型思考 Token；审稿整理建议“关闭思考”以确保返回 JSON。</small><label>API 密钥<input name="apiKey" type="password" autocomplete="new-password" placeholder="${p.hasApiKey?'已配置，留空保留':'尚未配置，请填写'}"></label><label class="key-clear"><input name="clearApiKey" type="checkbox">清除已保存的密钥</label></fieldset>`).join('');
    $('#settingsFeedback').textContent = '';
    $('#saveSettingsBtn').disabled = false;
  } catch (error) { $('#settingsFeedback').textContent = error.message; }
}

async function saveSettings(event) {
  event.preventDefault();
  const btn = $('#saveSettingsBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  const profiles = $$('#modelSettingsFields fieldset').map(field => ({role:field.dataset.role,
    model:field.querySelector('[name=model]').value, baseUrl:field.querySelector('[name=baseUrl]').value,
    protocol:field.querySelector('[name=protocol]').value, outputTokens:Number(field.querySelector('[name=outputTokens]').value), reasoningEffort:field.querySelector('[name=reasoningEffort]').value, apiKey:field.querySelector('[name=apiKey]').value,
    clearApiKey:field.querySelector('[name=clearApiKey]').checked
  }));
  try {
    await api('/api/settings', {method:'PUT',body:JSON.stringify({reviewEnabled:$('#reviewEnabled').checked,profiles})});
    await openSettings();
    await refreshHealth();
    $('#settingsFeedback').classList.remove('error');
    $('#settingsFeedback').textContent = '设置已保存，后续请求将使用新配置。连接是否可用请点击“测试已保存的连接”。';
  } catch(error) {
    $('#settingsFeedback').classList.add('error');
    $('#settingsFeedback').textContent = error.message;
  } finally { btn.disabled = false; }
}

function showView(view) {
  if (view === 'workspace' && !state.project) {
    const first = state.dashboard?.projects?.[0];
    if (first) return openProject(first.id);
    return $('#newProjectDialog').showModal();
  }
  $('#dashboardView').hidden = view !== 'dashboard';
  $('#workspaceView').hidden = view !== 'workspace';
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#crumbCurrent').textContent = view === 'dashboard' ? '总览' : state.project?.title || '创作工作台';
  $('#exportBtn').hidden = view !== 'workspace';
}

function renderDashboard() {
  const totals = state.dashboard.totals;
  const items = [
    ['作品', totals.projects, '本地保存', '#ede4da'],
    ['已完成字数', fmt(totals.words), '持续积累', '#e3e9e2'],
    ['完成章节', totals.chapters, '章', '#e8e4ed'],
    ['待处理问题', totals.openIssues, totals.openIssues ? '需留意' : '状态良好', '#eee6d8']
  ];
  $('#stats').innerHTML = items.map(([label,value,note,wash]) => `<article class="stat-card" style="--wash:${wash}"><small>${label}</small><strong>${value}</strong><em>${note}</em></article>`).join('');
  const colors = ['#895044','#536d66','#746176','#8d7956'];
  $('#projectGrid').innerHTML = state.dashboard.projects.map((p,index) => {
    const pct = Math.min(100, Math.round(Number(p.written_words) / p.target_words * 100));
    return `<article class="project-card" data-project="${p.id}"><div class="card-top"><div class="book-mark" style="--book:${colors[index%colors.length]}">卷</div><div class="card-top-actions"><span class="status-pill ${p.status}">${statusText(p.status)}</span><button class="project-delete" type="button" data-delete-project="${p.id}" title="删除作品" aria-label="删除《${escapeHtml(p.title)}》">×</button></div></div><h3>${escapeHtml(p.title)}</h3><span class="genre">${escapeHtml(p.genre || '未设定题材')}</span><p>${escapeHtml(p.premise || '等待写下故事的核心创意。')}</p><div class="card-progress"><div class="mini-progress"><i style="width:${pct}%"></i></div><div><span>${fmt(p.written_words)} / ${fmt(p.target_words)} 字</span><span>${pct}%</span></div></div></article>`;
  }).join('') || '<div class="empty-state"><h3>还没有作品</h3><p>创建你的第一个故事吧。</p></div>';
  $$('.project-card').forEach(card => card.onclick = event => {
    if (event.target.closest('[data-delete-project]')) return;
    openProject(card.dataset.project);
  });
  $$('[data-delete-project]').forEach(button => button.onclick = () => deleteProject(button.dataset.deleteProject));
  $('#recentProjects').innerHTML = state.dashboard.projects.slice(0,4).map(p => `<button class="recent-project" data-project="${p.id}">${escapeHtml(p.title)}</button>`).join('');
  $$('.recent-project').forEach(btn => btn.onclick = () => openProject(btn.dataset.project));
}

async function openProject(id, preserveChapter=false) {
  if (!preserveChapter && editorDirty()) return toast('当前章节有未保存的修改，请先保存', true);
  try {
    clearInterval(state.poll); clearInterval(state.rewritePoll); clearInterval(state.similarityPoll);
    state.context = null; state.modelEvents = [];
    if (!preserveChapter) state.memoryFilter = 'all';
    state.project = await api(`/api/projects/${id}`);
    if (preserveChapter && state.chapter) state.chapter = state.project.chapters.find(c => c.id === state.chapter.id) || null;
    else state.chapter = null;
    renderWorkspace(); showView('workspace');
    const run = state.project.latest_run;
    if (run?.status === 'running') watchRun(run.id);
  } catch(error) { toast(error.message, true); }
}

function renderWorkspace() {
  const p = state.project;
  $('#projectTitle').textContent = p.title;
  $('#projectPremise').textContent = p.premise;
  renderProgress(p);
  $('#planBtn').textContent = p.chapters.length ? '扩展近期章纲' : '生成创作方案';
  setRunningUI(p.latest_run);
  renderChapters(); renderOutline(); renderFramework(); renderMemories(); renderIssues();
  renderModelMonitor(); loadModelEvents(); watchModelEvents();
  if (state.chapter && p.chapters.some(ch => ch.id === state.chapter.id)) selectChapter(state.chapter.id);
  else {
    state.chapter = null; state.context = null;
    $('#editorPanel').innerHTML = '<div class="empty-state"><h3>选择一个章节</h3><p>生成创作方案后，在左侧选择章节。</p></div>';
    $('#chapterContext').innerHTML = '<p class="muted">选择章节后显示本章参考资料。</p>';
  }
}

function renderProgress(project) {
  const target = Math.max(1, Number(project.target_words) || 1);
  const written = Math.max(0, Number(project.written_words) || 0);
  const pct = Math.min(100, written / target * 100);
  $('#projectStatus').textContent = statusText(project.status);
  $('#projectStatus').className = `status-pill ${project.status}`;
  $('#progressLabel').textContent = `${fmt(written)} / ${fmt(target)} 字`;
  $('#progressBar').style.width = `${pct}%`;
  const complete = project.chapters.filter(c => c.status === 'completed').length;
  $('#chapterProgress').textContent = complete ? `已完成 ${complete} 章 · ${pct.toFixed(1)}%` : (written ? `已生成 ${fmt(written)} 字` : '尚未开始正文');
  $('#chapterCount').textContent = `${project.chapters.length} 章`;
}

function renderChapters() {
  const p = state.project;
  $('#volumeList').innerHTML = p.volumes.map(volume => {
    const chapters = p.chapters.filter(ch => ch.volume_id === volume.id);
    return `<div class="volume-heading">第${volume.number}卷 · ${escapeHtml(volume.title)}</div>${chapters.length ? chapters.map(ch => `<button class="chapter-item ${state.chapter?.id===ch.id?'active':''}" data-chapter="${ch.id}"><b>${String(ch.number).padStart(2,'0')}</b><span>${escapeHtml(ch.title)}</span><i>${ch.status==='completed'?'●':ch.status==='draft'?'◐':'○'}</i></button>`).join('') : '<p class="muted" style="padding:0 14px 8px">等待滚动规划</p>'}`;
  }).join('') || '<div class="empty-state" style="padding:90px 20px"><p>还没有章纲，先生成创作方案。</p></div>';
  $$('.chapter-item').forEach(btn => btn.onclick = () => selectChapter(btn.dataset.chapter));
}

function selectChapter(id) {
  if (!state.project.chapters.some(ch => ch.id === id)) return;
  if (state.chapter?.id !== id && editorDirty()) {
    toast('当前章节有未保存的修改，请先点击“保存章纲和正文”', true); return;
  }
  state.chapter = state.project.chapters.find(ch => ch.id === id);
  state.context = null;
  $$('.chapter-item').forEach(btn => btn.classList.toggle('active', btn.dataset.chapter === id));
  const ch = state.chapter;
  const plan = ch.plan || {};
  const writerBudget = state.health?.models?.find(item => item.role === 'writer')?.outputTokens || 24000;
  const chapterMeta = ch.status === 'draft' ? `第 ${ch.version} 版 · ${fmt(ch.word_count)} 字 · 待审稿` : ch.status==='completed' ? `第 ${ch.version} 版 · ${fmt(ch.word_count)} 字 · ${ch.review_score == null?'未审稿':`评分 ${ch.review_score}`}` : '等待创作';
  $('#editorPanel').innerHTML = `<div class="editor-head"><input id="chapterTitleInput" value="${escapeHtml(ch.title)}" aria-label="章节标题"><span class="editor-meta">${chapterMeta}</span></div>${ch.status==='draft'?'<p class="draft-notice">草稿已经安全保存。可以续写到目标字数，或更新故事资料后继续后续章节。</p>':''}<div class="chapter-plan-editor"><label>本章章纲 · 可自由修改<textarea id="chapterOutline" rows="3" placeholder="本章的关键行动、转折和结尾钩子">${escapeHtml(ch.outline)}</textarea></label><label>本章写作要求<textarea id="chapterInstructions" rows="2" placeholder="视角、必写情节、禁止提前揭露的信息……">${escapeHtml(ch.writing_instructions)}</textarea></label><label>开篇衔接要求 · 可选<textarea id="chapterOpeningInstructions" rows="2" placeholder="留空时自动承接上一章的动作、地点和人物状态">${escapeHtml(ch.opening_instructions || '')}</textarea></label><details class="plan-details"><summary>详细章纲（可选）</summary><div class="plan-fields"><label>开场状态<input id="planOpeningState" value="${escapeHtml(plan.openingState || '')}" placeholder="地点、时间和人物状态"></label><label>出场人物<input id="planCast" value="${escapeHtml((plan.cast || []).join('、'))}" placeholder="用顿号分隔"></label><label>本章目标<input id="planGoal" value="${escapeHtml(plan.goal || '')}"></label><label>关键转折<input id="planTurn" value="${escapeHtml(plan.turn || '')}"></label><label>必须发生<input id="planMustHappen" value="${escapeHtml(plan.mustHappen || '')}"></label><label>结束状态<input id="planEndingState" value="${escapeHtml(plan.endingState || '')}"></label></div></details><label>目标字数 · AI 尽量遵循<input id="chapterTargetWords" type="number" min="500" max="6000" step="100" value="${ch.target_words || 3000}"><small class="field-hint">实际正文输出预算：${fmt(writerBudget)} token；截断时会保留部分正文。</small></label></div><textarea id="chapterContent" class="chapter-content" aria-label="章节正文" placeholder="可以在这里自行写作，也可以让 AI 按章纲完成。">${escapeHtml(ch.content)}</textarea><div class="editor-actions"><button class="ghost" id="writeCurrentChapterBtn" ${ch.content ? 'hidden' : ''}>✦ 自动写本章</button>${ch.status==='draft'?'<button class="ghost" id="continueDraftBtn">继续续写</button><button class="primary" id="reviewDraftBtn">更新故事资料</button>':ch.context_stale?'<button class="primary" id="reviewDraftBtn">重新整理资料</button>':''}<button class="ghost" id="rewriteChapterBtn">↻ 重写本章</button><button class="ghost" id="checkSimilarityBtn">⌕ 网络查重</button><button class="primary" id="saveChapterBtn">保存</button></div>`;
  const planCheck=ch.plan_result || {};
  if (Object.keys(planCheck).length && $('.plan-details')) {
    const stateLabel=value=>({done:'已完成',partial:'部分完成',missing:'未完成'}[value] || '待检查');
    $('.plan-details').insertAdjacentHTML('beforeend',`<div class="plan-check"><b>正文完成情况</b><span>目标：${stateLabel(planCheck.goal)}</span><span>转折：${stateLabel(planCheck.turn)}</span><span>必写事件：${stateLabel(planCheck.mustHappen)}</span><span>结尾：${stateLabel(planCheck.endingState)}</span>${planCheck.note?`<p>${escapeHtml(planCheck.note)}</p>`:''}</div>`);
  }
  $('#writeCurrentChapterBtn').onclick = () => openWriteDialog(ch.id);
  if ($('#reviewDraftBtn')) $('#reviewDraftBtn').onclick = () => reviewDraft(ch.id);
  if ($('#continueDraftBtn')) $('#continueDraftBtn').onclick = () => continueDraft(ch.id);
  if (ch.status === 'completed' && ch.review_score == null) $('#editorPanel .editor-meta').textContent = `第 ${ch.version} 版 · ${fmt(ch.word_count)} 字 · 未审稿`;
  $('#saveChapterBtn').onclick = saveChapter;
  $('#rewriteChapterBtn').onclick = openRewriteDialog;
  $('#checkSimilarityBtn').onclick = startSimilarityCheck;
  loadLatestSimilarity(ch.id);
  loadLatestRewrite(ch.id);
  $('#chapterContext').innerHTML = '<p class="muted">正在读取本章之前的有效事实…</p>';
  api(`/api/chapters/${id}/context`).then(context => {
    if (state.chapter?.id !== id) return;
    state.context = context; renderContext(ch); renderFramework();
  }).catch(error => toast(error.message,true));
  renderFramework();
}

function renderContext(ch) {
  const memories = (state.context?.facts || []).slice(0,4);
  const clues = (state.context?.clues || []).slice(0,3);
  const knownCharacters = state.context?.project?.characters || [];
  const plannedCast = ch.plan?.cast || [];
  const characters = (plannedCast.length ? knownCharacters.filter(item => plannedCast.includes(item.name) || (item.aliases || []).some(alias=>plannedCast.includes(alias))) : knownCharacters).slice(0,6);
  const ending = state.context?.previousEnding;
  const handoff = ending?.handoff;
  const endingDetails = ending ? `<div class="context-group"><label>上一章结尾衔接 ${ending.reliable ? '✓' : '· 待复核'}</label><div class="context-chip"><b>第${ending.number}章《${escapeHtml(ending.title)}》</b>${handoff ? `地点：${escapeHtml(handoff.location || '未明确')}<br>刚刚发生：${escapeHtml(handoff.lastAction || '未明确')}<br>人物状态：${escapeHtml((handoff.characterStates || []).join('；') || '未明确')}<br>未解决冲突：${escapeHtml((handoff.unresolved || []).join('；') || '无')}` : '<span class="muted">结构化交接卡缺失，写作仍会读取结尾片段。</span>'}<details><summary>查看结尾片段</summary><pre>${escapeHtml(ending.excerpt || '')}</pre></details></div></div>`
    : (ch.number > 1 ? `<div class="context-group"><label>上一章结尾衔接</label><p class="context-warning">缺少第${ch.number-1}章正文。本章不会被误当成开篇，但建议先补齐前章。</p></div>` : '');
  $('#chapterContext').innerHTML = `${endingDetails}<div class="context-group"><label>本章人物</label>${characters.map(c=>`<div class="context-chip"><b>${escapeHtml(c.name)}</b>${escapeHtml(c.role)}${c.state ? `<br>状态：${escapeHtml(c.state)}` : ''}</div>`).join('') || '<p class="muted">章纲未指定人物，将按剧情自动选择。</p>'}</div><div class="context-group"><label>相关事实 · 已按重要度选择</label>${memories.map(m=>`<div class="context-chip"><b>${escapeHtml(m.subject)}</b>${escapeHtml(m.fact)}</div>`).join('') || '<p class="muted">尚无已发生事实</p>'}</div><div class="context-group"><label>待推进伏笔</label>${clues.map(f=>`<div class="context-chip"><b>${escapeHtml(f.title)}</b>${escapeHtml(f.visible_clue)}${f.progress_note ? `<br>进展：${escapeHtml(f.progress_note)}` : ''}</div>`).join('') || '<p class="muted">本章暂无相关伏笔</p>'}</div>`;
}

function renderOutline() {
  const p = state.project;
  $('#outlineText').textContent = p.outline || '还没有全书主线。生成创作方案后会显示在这里。';
  $('#worldText').textContent = p.world || '还没有世界规则。';
  $('#characterCards').innerHTML = p.characters.map(c => `<div class="character-card"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.role)}</span><p>${c.desire?`<b>目标：</b>${escapeHtml(c.desire)}<br>`:''}${c.conflict?`<b>矛盾：</b>${escapeHtml(c.conflict)}<br>`:''}${c.relationship?`<b>关系：</b>${escapeHtml(c.relationship)}<br>`:''}${c.state?`<b>当前状态：</b>${escapeHtml(c.state)}${c.location?` · ${escapeHtml(c.location)}`:''}<br>`:''}${c.firstChapter?`<small>第 ${c.firstChapter} 章首次记录 · 更新至第 ${c.updatedChapter || c.firstChapter} 章</small>`:''}${c.status==='needs_review'?'<br><em class="memory-pending">待复核</em>':''}</p></div>`).join('') || '<p class="muted">尚未创建人物。</p>';
  $('#volumeCards').innerHTML = p.volumes.map(v => { const chapters=p.chapters.filter(c=>c.volume_id===v.id); return `<div class="volume-card"><div class="volume-no">${String(v.number).padStart(2,'0')}</div><div><strong>${escapeHtml(v.title)}</strong><p>${escapeHtml(v.goal)}</p></div><small>${chapters.length ? `${chapters.length} 章已规划` : '等待展开'}</small></div>`; }).join('') || '<p class="muted">尚未规划分卷。</p>';
}

function renderFramework() {
  const p = state.project;
  const ch = state.chapter || p.chapters.find(item => item.status !== 'completed') || p.chapters.at(-1);
  const volume = ch ? p.volumes.find(item => item.id === ch.volume_id) : null;
  const captured = ch?.context_snapshot?.chapter ? ch.context_snapshot : state.context;
  const prior = captured?.previous || [];
  const previousEnding = captured?.previousEnding;
  const facts = captured?.facts || [];
  const clues = captured?.clues || [];
  const models = state.health?.models || [];
  const steps = [
    ['01','创作种子','题材、核心创意、篇幅与文风'],['02','全书蓝图','主线、世界规则与人物成长'],
    ['03','分卷目标','每一卷必须完成的阶段变化'],['04','近期章纲','每批可扩展 1–10 章'],
    ['05','逐章正文','调取前文事实、伏笔与本章目标'],['06','审稿入库','检查一致性并更新故事记忆']
  ];
  $('#frameworkContent').innerHTML = `<div class="framework-flow">${steps.map(step=>`<article class="framework-step"><b>${step[0]}</b><strong>${step[1]}</strong><p>${step[2]}</p></article>`).join('')}</div><div class="basis-grid"><article class="basis-card"><h3>作品的固定方向</h3><p class="basis-value"><b>核心创意：</b>${escapeHtml(p.premise)}\n\n<b>文风：</b>${escapeHtml(p.tone || '未单独指定')}\n\n<b>全书主线：</b>${escapeHtml(p.outline || '尚未生成')}</p></article><article class="basis-card"><h3>${ch ? `第 ${ch.number} 章${ch.context_snapshot?.chapter?'生成时的实际依据':'当前依据'}` : '当前章节依据'}</h3><p class="basis-value"><b>分卷目标：</b>${escapeHtml(volume?.goal || '未设定')}\n\n<b>本章章纲：</b>${escapeHtml(ch?.outline || '未选择章节')}\n\n<b>详细章纲：</b>${escapeHtml(JSON.stringify(ch?.plan || {}))}\n\n<b>本章要求：</b>${escapeHtml(ch?.writing_instructions || '未指定')}\n\n<b>目标字数：</b>${fmt(ch?.target_words || 3000)} 字</p></article><article class="basis-card"><h3>实际调取的上下文</h3><ul><li>上一章结尾：${previousEnding ? (previousEnding.handoff ? `交接卡 + ${fmt(previousEnding.excerpt.length)} 字结尾片段` : `${fmt(previousEnding.excerpt.length)} 字结尾片段`) : (ch?.number===1?'开篇章节':'缺少前章正文')}</li><li>近期摘要：${prior.length ? prior.map(item=>`第${item.number}章`).join('、') : '暂无'}</li><li>有效事实：按置顶、重要度、人物相关性和时间距离选取，最多 60 条；本次 ${facts.length} 条</li><li>未回收可见线索：${clues.length} 条</li><li>人物档案会按章节知识截止过滤</li><li>重写时，后续摘要只交给审稿核对</li></ul></article><article class="basis-card"><h3>模型分工与质量检查</h3><ul>${models.map(item=>`<li>${escapeHtml(item.label)}：${escapeHtml(item.model)}（${item.enabled?'已连接':'演示'}）</li>`).join('')}<li>严重一致性问题会暂停后续章节；关闭质量审稿仍整理基础故事资料</li></ul></article></div>`;
}

function renderMemories() {
  const memories = state.project.memories || [];
  const filter = state.memoryFilter || 'all';
  const list = filter === 'all' ? memories : memories.filter(memory => memory.kind === filter);
  $$('.memory-filters button').forEach(btn => {
    const active = (btn.dataset.memoryFilter || 'all') === filter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const empty = memories.length && filter !== 'all'
    ? `<div class="empty-state"><div class="empty-icon">◎</div><h3>暂无${escapeHtml(kindText(filter))}记忆</h3><p>审稿整理模型确认该类事实后，会显示在这里。</p></div>`
    : '<div class="empty-state"><div class="empty-icon">◎</div><h3>故事还没有发生</h3><p>章节完成后，确定的事实会连同出处保存在这里。</p></div>';
  $('#memoryList').innerHTML = list.map(m => `<div class="memory-row"><span class="type-tag">${escapeHtml(kindText(m.kind))}</span><b>${escapeHtml(m.subject)}</b><p>${escapeHtml(m.fact)}</p><span class="source">第 ${m.source_chapter} 章<br><button class="memory-pin" data-memory-pin="${m.id}" aria-pressed="${m.pinned?'true':'false'}">${m.pinned?'★ 已置顶':'☆ 置顶'}</button>${m.status!=='active'?'<br><em class="memory-pending">待复核</em>':''}</span></div>`).join('') || empty;
  $$('[data-memory-pin]').forEach(button=>button.onclick=()=>toggleMemoryPin(button.dataset.memoryPin,button.getAttribute('aria-pressed')!=='true'));
}

async function toggleMemoryPin(id,pinned) {
  try {
    await api(`/api/memories/${id}`,{method:'PATCH',body:JSON.stringify({pinned})});
    state.project=await api(`/api/projects/${state.project.id}`); renderMemories();
  } catch(error) { toast(error.message,true); }
}

function renderIssues() {
  const list = state.project.issues;
  $('#issuesList').innerHTML = list.map(i => `<div class="issue-row"><strong class="severity-${i.severity}">${i.severity==='critical'?'需要处理':'提醒'}</strong><span>${escapeHtml(i.category)}</span><p>${escapeHtml(i.message)}</p></div>`).join('') || '<div class="empty-state"><div class="empty-icon">✓</div><h3>目前没有需要处理的问题</h3><p>时间线、人物行为和设定检查结果会显示在这里。</p></div>';
}

function selectTab(tab) {
  $$('#workspaceTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  for (const name of ['chapters','outline','framework','memory','issues','models']) $(`#${name}Tab`).hidden = name !== tab;
  if (tab === 'models') loadModelEvents();
}

async function reviewDraft(chapterId) {
  if (editorDirty()) return toast('请先保存当前修改，再重新审稿',true);
  try {
    const run = await api(`/api/chapters/${chapterId}/review`,{method:'POST',body:'{}'});
    state.run=run; state.project.latest_run=run; setRunningUI(run); watchRun(run.id);
    toast(state.health?.reviewEnabled === false ? '已经开始更新故事资料' : '已经开始审稿并更新故事资料');
  } catch(error) { toast(error.message,true); }
}

async function continueDraft(chapterId) {
  if (editorDirty()) return toast('请先保存当前修改，再继续续写',true);
  try {
    const run = await api(`/api/projects/${state.project.id}/run`,{method:'POST',body:JSON.stringify({chapterIds:[chapterId],continueDraft:true})});
    state.run=run; state.project.latest_run=run; setRunningUI(run); watchRun(run.id);
    toast('已经从草稿结尾继续写作');
  } catch(error) { toast(error.message,true); }
}

async function deleteProject(id) {
  const project = state.dashboard?.projects?.find(item => item.id === id);
  if (!project) return;
  if (!confirm(`确定删除《${project.title}》吗？作品正文、章节、记忆和模型记录都会被删除，且无法恢复。`)) return;
  try {
    await api(`/api/projects/${id}`, {method:'DELETE'});
    if (state.project?.id === id) {
      clearInterval(state.poll); clearInterval(state.modelPoll); clearInterval(state.rewritePoll); clearInterval(state.similarityPoll);
      state.project = null; state.chapter = null; state.context = null; state.run = null; state.rewrite = null; state.modelEvents = [];
      showView('dashboard');
    }
    await refreshDashboard();
    toast(`《${project.title}》已删除`);
  } catch (error) { toast(error.message, true); }
}

const taskText = task => ({plan:'全书规划','plan-foundation':'全书骨架','plan-chapters':'近期章纲','extend-plan':'扩展章纲',write:'正文写作',continue:'续写草稿',review:'正文审稿',extract:'故事资料整理',similarity:'网络查重',rewrite:'章节重写','rewrite-review':'重写审稿','connection-test':'连接测试'}[task] || task || '模型任务');
const modelStatusText = status => ({running:'进行中',completed:'已完成',failed:'失败'}[status] || status);
const eventTime = value => value ? new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';

function renderModelMonitor() {
  const events = state.modelEvents || [];
  const monitor = $('#modelMonitor');
  const pageScrollY = window.scrollY;
  const openDetails = new Set([...monitor.querySelectorAll('details[open]')].map(details => {
    const card = details.closest('.model-event-card');
    return card ? `${card.dataset.eventId || ''}:${details.className}` : '';
  }));
  const scrollPositions = new Map([...monitor.querySelectorAll('.model-event-card pre')].map(pre => {
    const card = pre.closest('.model-event-card');
    return [card ? `${card.dataset.eventId || ''}:${pre.parentElement.className}` : '', {top: pre.scrollTop, left: pre.scrollLeft}];
  }));
  const running = events.filter(item => item.status === 'running').length;
  const completed = events.filter(item => item.status === 'completed').length;
  const failed = events.filter(item => item.status === 'failed').length;
  monitor.innerHTML = `<div class="model-monitor-head"><div><span class="eyebrow">实时通讯</span><h2>模型返回与任务动态</h2><p>每次规划、写作、审稿、查重和重写都会在这里留下状态与返回摘要。页面会自动刷新。</p></div><button class="ghost" id="refreshModelEventsBtn">刷新</button></div><div class="model-event-stats"><article><strong>${running}</strong><span>进行中</span></article><article><strong>${completed}</strong><span>已完成</span></article><article><strong>${failed}</strong><span>失败</span></article><article><strong>${events.length}</strong><span>最近记录</span></article></div>${events.length ? `<div class="model-event-list">${events.map(renderModelEvent).join('')}</div>` : '<div class="empty-state model-empty"><div class="empty-icon">◌</div><h3>还没有模型动态</h3><p>开始规划或写作后，模型请求和返回结果会显示在这里。</p></div>'}`;
  monitor.querySelectorAll('details').forEach(details => {
    const card = details.closest('.model-event-card');
    if (card && openDetails.has(`${card.dataset.eventId || ''}:${details.className}`)) details.open = true;
  });
  monitor.querySelectorAll('.model-event-card pre').forEach(pre => {
    const card = pre.closest('.model-event-card');
    const position = scrollPositions.get(card ? `${card.dataset.eventId || ''}:${pre.parentElement.className}` : '');
    if (position) { pre.scrollTop = position.top; pre.scrollLeft = position.left; }
  });
  requestAnimationFrame(() => window.scrollTo({top: pageScrollY, behavior: 'auto'}));
  $('#refreshModelEventsBtn').onclick = loadModelEvents;
}

function renderModelEvent(item) {
  const target = item.chapter_id ? (state.project.chapters.find(ch=>ch.id===item.chapter_id) || null) : null;
  const targetText = target ? `第${target.number}章《${target.title}》` : (item.task === 'plan' ? '全书' : '—');
  const usage = parseUsage(item.usage);
  const response = item.response_text || item.response_preview || '';
  const request = item.request_text || item.request_preview || '';
  const responseLength = Number(item.response_length) || response.length;
  const storedRequestLength = Number(item.request_length) || 0;
  const requestLengthKnown = storedRequestLength > 0;
  const requestLength = requestLengthKnown ? storedRequestLength : request.length;
  const responseTruncated = responseLength > response.length;
  const requestTruncated = requestLengthKnown && requestLength > request.length;
  const requestMeta = requestLength ? `<span>${requestLengthKnown ? `请求 ${fmt(requestLength)} 字符` : `请求预览 ${fmt(requestLength)} 字符`}</span>` : '';
  const requestNotice = requestLengthKnown ? (requestTruncated ? `（已显示前 ${fmt(request.length)} 字符）` : '') : '（旧记录仅保存摘要）';
  const outputBudget = Number(item.output_budget) || 0;
  return `<article class="model-event-card ${escapeHtml(item.status)}" data-event-id="${escapeHtml(item.id)}"><div class="model-event-top"><div><span class="model-event-role">${escapeHtml(item.role)}</span><strong>${escapeHtml(taskText(item.task))}</strong><span class="model-event-target">${escapeHtml(targetText)}</span></div><div class="model-event-status ${escapeHtml(item.status)}"><i></i>${escapeHtml(modelStatusText(item.status))}</div></div><div class="model-event-meta"><span>${escapeHtml(item.model || '未指定模型')}</span><span>${item.protocol === 'chat' ? 'Chat Completions' : 'Responses'}</span><span>${eventTime(item.updated_at)}</span>${item.duration_ms != null ? `<span>${formatDuration(item.duration_ms)}</span>` : ''}${outputBudget ? `<span>预算 ${fmt(outputBudget)} token</span>` : ''}${requestMeta}${responseLength ? `<span>返回 ${fmt(responseLength)} 字符</span>` : ''}</div><p class="model-event-message">${escapeHtml(item.error || item.message || '')}</p>${usage ? `<div class="model-usage">输入 ${escapeHtml(String(usage.input_tokens ?? usage.prompt_tokens ?? '—'))} · 输出 ${escapeHtml(String(usage.output_tokens ?? usage.completion_tokens ?? '—'))} · 总计 ${escapeHtml(String(usage.total_tokens ?? '—'))}</div>` : ''}${response ? `<details class="model-event-response"><summary>查看返回内容${responseTruncated ? `（已显示前 ${fmt(response.length)} 字符）` : ''}</summary><pre>${escapeHtml(response)}</pre></details>` : ''}${request ? `<details class="model-event-request"><summary>查看请求内容${requestNotice}</summary><pre>${escapeHtml(request)}</pre></details>` : ''}</article>`;
}

function parseUsage(value) { try { const usage = typeof value === 'string' ? JSON.parse(value || '{}') : value; return usage && Object.keys(usage).length ? usage : null; } catch { return null; } }
function formatDuration(ms) { return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`; }
async function loadModelEvents() {
  if (!state.project) return;
  const projectId = state.project.id;
  try {
    const events = await api(`/api/projects/${projectId}/model-events?limit=80`);
    if (state.project?.id !== projectId) return;
    state.modelEvents = events; renderModelMonitor();
  }
  catch (error) { if ($('#modelMonitor')) toast(error.message,true); }
}
function watchModelEvents() {
  clearInterval(state.modelPoll);
  if (!state.project) return;
  state.modelPoll = setInterval(loadModelEvents, 1800);
}

async function createProject(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = formElement.querySelector('[type=submit]');
  if (submit.disabled) return;
  if (editorDirty()) return toast('请先保存当前作品的修改，再新建作品', true);
  const form = new FormData(formElement);
  submit.disabled = true;
  try {
    const project = await api('/api/projects', { method:'POST', body:JSON.stringify(Object.fromEntries(form)) });
    $('#newProjectDialog').close(); formElement.reset();
    clearInterval(state.poll); clearInterval(state.rewritePoll); clearInterval(state.similarityPoll); clearInterval(state.modelPoll);
    state.chapter = null; state.context = null; state.run = null; state.rewrite = null; state.modelEvents = [];
    toast('作品已创建，正在生成第一版方案');
    state.project = project; showView('workspace'); renderWorkspace();
    await refreshDashboard();
    await createPlan();
    await refreshDashboard();
  } catch(error) { toast(error.message, true); }
  finally { submit.disabled = false; }
}

async function createPlan() {
  if (!state.project) return;
  const extending = state.project.chapters.length > 0;
  if (extending) {
    if (editorDirty()) return toast('请先保存当前章纲和正文再扩展', true);
    const next = Math.max(...state.project.chapters.map(ch => ch.number)) + 1;
    const volumeNumber = Math.min(state.project.volumes.length, Math.floor((next-1)/30)+1);
    $('#extendPlanExplanation').textContent = `从第 ${next} 章开始追加。已有 ${state.project.chapters.filter(ch => ch.status !== 'completed').length} 章计划尚未写成正文，也会供模型衔接参考。`;
    $('#extendVolume').innerHTML = state.project.volumes.map(v => `<option value="${v.number}" ${v.number===volumeNumber?'selected':''}>第${v.number}卷 · ${escapeHtml(v.title)}</option>`).join('');
    $('#extendPlanDialog').showModal(); return;
  }
  const btn = $('#planBtn'); btn.disabled = true; btn.textContent = extending ? '正在扩展…' : '正在规划…';
  try {
    const action = extending ? 'extend-plan' : 'plan';
    state.project = await api(`/api/projects/${state.project.id}/${action}`, { method:'POST', body:'{}' });
    state.chapter = null; renderWorkspace();
    toast(extending ? '未来 10 章已经加入近期章纲' : (state.health?.aiEnabled ? '创作方案已经生成' : '演示方案已经生成，可立即试写'));
  } catch(error) { toast(error.message, true); }
  finally { btn.disabled = false; btn.textContent = state.project?.chapters?.length ? '扩展近期章纲' : '生成创作方案'; }
}

async function extendPlan(event) {
  event.preventDefault();
  const btn = event.currentTarget.querySelector('[type=submit]');
  const input = Object.fromEntries(new FormData(event.currentTarget));
  btn.disabled = true; btn.textContent = '正在扩展…';
  try {
    state.project = await api(`/api/projects/${state.project.id}/extend-plan`, {method:'POST',body:JSON.stringify(input)});
    $('#extendPlanDialog').close(); state.chapter = null;
    renderWorkspace(); selectChapter(state.project.chapters.at(-Number(input.count)).id);
    toast(`已新增 ${input.count} 章计划，可以逐章修改后再写正文`);
  } catch(error) { toast(error.message,true); }
  finally { btn.disabled=false; btn.textContent='生成并加入章纲'; }
}

async function openWriteDialog(chapterId) {
  if (!state.project?.chapters?.length) return toast('请先生成创作方案', true);
  const running = state.project.latest_run?.status === 'running';
  if (running) return stopWriting(state.project.latest_run.id);
  if (state.project.latest_run?.status === 'paused') return resumeWriting(state.project.latest_run.id);
  try { if (editorDirty()) await persistEditor(); } catch(error) { return toast(error.message,true); }
  const available = state.project.chapters.filter(ch => ch.status !== 'completed' && !ch.content.trim());
  if (!available.length) return toast('待写章节已写完，请先扩展章纲；修改已有正文请使用重写',true);
  const preferred = typeof chapterId === 'string' ? chapterId : (available.find(ch=>ch.id===state.chapter?.id)?.id || available[0].id);
  $('#writeChapterChoices').innerHTML = available.map(ch => `<label class="chapter-choice"><input type="checkbox" name="chapterIds" value="${ch.id}" ${ch.id===preferred?'checked':''}><span><strong>第 ${ch.number} 章 · ${escapeHtml(ch.title)} · 约 ${fmt(ch.target_words)} 字</strong><small>${escapeHtml(ch.outline || '请先填写本章章纲')}\n要求：${escapeHtml(ch.writing_instructions || '遵循章纲和全书文风')}</small></span></label>`).join('');
  $('#writeChapterChoices').onchange = updateWriteSelection;
  $('#selectNextChapters').onclick = () => { $$('#writeChapterChoices input').forEach((box,i)=>box.checked=i<10); updateWriteSelection(); };
  $('#clearChapterSelection').onclick = () => { $$('#writeChapterChoices input').forEach(box=>box.checked=false); updateWriteSelection(); };
  updateWriteSelection();
  $('#writeDialog').showModal();
}

function updateWriteSelection() {
  const ids = $$('#writeChapterChoices input:checked').map(box=>box.value);
  const selected = state.project.chapters.filter(ch=>ids.includes(ch.id));
  const gaps = selected.length ? state.project.chapters.filter(ch=>ch.number<selected.at(-1).number && ch.status!=='completed' && !ids.includes(ch.id)) : [];
  $('#writeSelectionSummary').textContent = selected.length ? `将依次写：${selected.map(ch=>`第${ch.number}章`).join(' → ')}。${gaps.length ? '前文存在未写章节，AI 不会把这些章纲当作已发生事实。' : ''}` : '尚未选择章节';
  $('#writeForm [type=submit]').disabled = !ids.length || ids.length>10;
}

async function startWriting(event) {
  event.preventDefault();
  const chapterIds = new FormData(event.currentTarget).getAll('chapterIds');
  const submit = event.currentTarget.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const run = await api(`/api/projects/${state.project.id}/run`, { method:'POST', body:JSON.stringify({chapterIds}) });
    $('#writeDialog').close(); state.run = run;
    state.project.latest_run = run;
    setRunningUI(run); watchRun(run.id); toast('自动写作已经开始');
  } catch(error) { toast(error.message, true); }
  finally { submit.disabled = false; }
}

async function stopWriting(runId) {
  try { await api(`/api/runs/${runId}/stop`, {method:'POST', body:'{}'}); toast('会在安全位置暂停'); }
  catch(error) { toast(error.message, true); }
}

async function resumeWriting(runId) {
  try {
    const run = await api(`/api/runs/${runId}/resume`,{method:'POST',body:'{}'});
    state.run=run; state.project.latest_run=run; setRunningUI(run); watchRun(run.id);
    toast('任务已从最近安全保存的位置继续');
  } catch(error) { toast(error.message,true); }
}

function setRunningUI(run) {
  const active = run?.status === 'running';
  $('#writeBtn').textContent = active ? (run.current_step === 'pausing' ? '正在暂停…' : '暂停写作') : (run?.status === 'paused' ? '▶ 继续任务' : '✦ 自动写作');
  $('#writeBtn').disabled = active && run.current_step === 'pausing';
  $('#runStatus').textContent = run?.message || '等待创作';
  $('#runStatus').classList.toggle('running', active);
}

function watchRun(runId) {
  clearInterval(state.poll);
  const check = async () => {
    try {
      const projectId = state.project?.id;
      if (!projectId) return;
      const run = await api(`/api/runs/${runId}`);
      if (state.project?.id !== projectId) return;
      state.run = run; setRunningUI(run);
      state.project.latest_run = run;
      const freshProject = await api(`/api/projects/${projectId}`);
      if (state.project?.id === projectId) {
        state.project = freshProject;
        state.project.latest_run = run;
        renderProgress(freshProject);
        // Refresh chapter markers without replacing the editor DOM. This keeps
        // unsaved text, selection and scroll position intact while a run writes.
        renderChapters();
        if (state.dashboard?.projects) {
          const dashboardProject = state.dashboard.projects.find(item => item.id === projectId);
          if (dashboardProject) {
            dashboardProject.written_words = freshProject.written_words;
            dashboardProject.status = freshProject.status;
            dashboardProject.completed_count = freshProject.chapters.filter(ch => ch.status === 'completed').length;
            renderDashboard();
          }
        }
      }
      if (run.status !== 'running') {
        clearInterval(state.poll); state.poll = null;
        if (!editorDirty()) await openProject(state.project.id, true);
        else toast('任务结束；当前编辑内容尚未保存，请保存后刷新章节', true);
        await refreshDashboard();
        toast(run.status === 'completed' ? run.message : `任务${run.status === 'paused' ? '已暂停' : '未完成'}：${run.message}`, run.status === 'failed');
      }
    } catch(error) { clearInterval(state.poll); toast(error.message, true); }
  };
  check(); state.poll = setInterval(check, 900);
}

function editorValues() {
  return {title:$('#chapterTitleInput').value.trim(),outline:$('#chapterOutline').value.trim(),
    plan:{openingState:$('#planOpeningState')?.value.trim() || '',cast:($('#planCast')?.value || '').split(/[、,，]/).map(item=>item.trim()).filter(Boolean),
      goal:$('#planGoal')?.value.trim() || '',turn:$('#planTurn')?.value.trim() || '',mustHappen:$('#planMustHappen')?.value.trim() || '',endingState:$('#planEndingState')?.value.trim() || ''},
    writingInstructions:$('#chapterInstructions').value.trim(),openingInstructions:$('#chapterOpeningInstructions').value.trim(),
    targetWords:Number($('#chapterTargetWords').value),content:$('#chapterContent').value,expectedRevision:state.chapter.revision};
}

function editorDirty() {
  if (!state.chapter || !$('#chapterOutline')) return false;
  const v = editorValues(), ch = state.chapter;
  return v.title!==ch.title || v.outline!==ch.outline || v.content!==ch.content || JSON.stringify(v.plan)!==JSON.stringify(ch.plan || {})
    || v.writingInstructions!==(ch.writing_instructions || '') || v.openingInstructions!==(ch.opening_instructions || '') || v.targetWords!==ch.target_words;
}

async function persistEditor() {
  const values = editorValues();
  if (!values.title) throw new Error('请填写章节标题');
  values.status = values.content.trim() ? (state.chapter.status === 'completed' ? 'completed' : 'draft') : 'planned';
  const saved = await api(`/api/chapters/${state.chapter.id}`, {method:'PATCH',body:JSON.stringify(values)});
  state.chapter = saved;
  state.project.chapters = state.project.chapters.map(ch => ch.id===saved.id ? saved : ch);
  return saved;
}

async function saveChapter() {
  try {
    await persistEditor();
    await openProject(state.project.id, true); await refreshDashboard(); toast('章纲、写作要求和正文已保存');
  } catch(error) { toast(error.message, true); }
}

function openRewriteDialog() {
  if (!state.chapter?.content) return toast('本章还没有正文，请先完成写作', true);
  const area = $('#rewriteContent');
  $('#rewriteDialogTitle').textContent = `重写第 ${state.chapter.number} 章《${state.chapter.title}》`;
  area.innerHTML = `<form id="rewriteForm" class="rewrite-form"><p class="rewrite-intro">新稿依据已保存的章纲和要求创作。写作模型只读取本章之前的有效记忆；后续摘要仅供审稿核对，不交给写作模型。生成后先给你对照，只有点击“采用候选稿”才会替换当前正文。</p><label>你希望怎样重写？</label><div class="rewrite-presets"><button type="button" class="rewrite-preset">加强冲突和节奏</button><button type="button" class="rewrite-preset">增加人物对话</button><button type="button" class="rewrite-preset">改善文笔和氛围</button><button type="button" class="rewrite-preset">更换场景展开方式</button><button type="button" class="rewrite-preset">重做结尾钩子</button></div><textarea id="rewriteInstruction" placeholder="例如：保留发现密室的情节，但减少解释性叙述，加强顾临舟和沈栖月之间的不信任。"></textarea><div class="dialog-actions"><button type="button" class="ghost" id="cancelRewriteBtn">取消</button><button class="primary" type="submit">生成重写候选稿</button></div></form>`;
  area.querySelectorAll('.rewrite-preset').forEach(btn => btn.onclick = () => {
    const input = $('#rewriteInstruction');
    input.value = input.value ? `${input.value}；${btn.textContent}` : btn.textContent;
  });
  $('#cancelRewriteBtn').onclick = () => $('#rewriteDialog').close();
  $('#rewriteForm').onsubmit = startRewrite;
  if (!$('#rewriteDialog').open) $('#rewriteDialog').showModal();
}

async function loadLatestRewrite(chapterId) {
  try {
    const job = await api(`/api/chapters/${chapterId}/rewrite`);
    if (!job || state.chapter?.id !== chapterId) return;
    const btn = $('#rewriteChapterBtn');
    if (!btn) return;
    if (job.status === 'running') {
      btn.textContent = '↻ 正在重写…';
      btn.onclick = () => showRewrite(job);
      watchRewrite(job.id);
    } else if (job.status === 'completed' && job.original_version === state.chapter.version && (job.original_revision == null || job.original_revision === state.chapter.revision)) {
      btn.textContent = '↻ 查看候选稿';
      btn.onclick = () => editorDirty() ? openRewriteDialog() : showRewrite(job);
    }
  } catch {}
}

async function startRewrite(event) {
  event.preventDefault();
  const instruction = $('#rewriteInstruction').value.trim();
  const chapterId = state.chapter.id;
  const submit = event.currentTarget.querySelector('[type=submit]'); submit.disabled = true;
  try {
    await persistEditor();
    const job = await api(`/api/chapters/${chapterId}/rewrite`, {method:'POST', body:JSON.stringify({instruction})});
    state.rewrite = job;
    showRewrite(job); watchRewrite(job.id);
  } catch(error) { toast(error.message, true); }
  finally { if (submit.isConnected) submit.disabled = false; }
}

function showRewrite(job) {
  state.rewrite = job;
  const chapter = job.context_snapshot?.chapter || state.project.chapters.find(ch=>ch.id===job.chapter_id);
  $('#rewriteDialogTitle').textContent = `重写第 ${chapter.number} 章《${chapter.title}》`;
  renderRewrite(job);
  if (!$('#rewriteDialog').open) $('#rewriteDialog').showModal();
}

function renderRewrite(job) {
  const area = $('#rewriteContent');
  const original = job.context_snapshot?.chapter || state.project.chapters.find(ch=>ch.id===job.chapter_id);
  if (job.status === 'running') {
    area.innerHTML = `<div class="rewrite-progress"><div class="scan-pulse"></div><h3>正在生成新的章节版本</h3><p>${escapeHtml(job.message)}。生成和审稿通常需要一至两分钟，可以关闭窗口继续查看其他内容。</p></div>`;
    return;
  }
  if (job.status === 'failed') {
    area.innerHTML = `<div class="rewrite-progress"><h3>候选稿生成失败</h3><p>${escapeHtml(job.message)}</p><div class="dialog-actions"><button class="primary" id="retryRewriteBtn">重新设置要求</button></div></div>`;
    $('#retryRewriteBtn').onclick = openRewriteDialog;
    return;
  }
  if (job.status !== 'completed') {
    area.innerHTML = `<div class="rewrite-progress"><h3>${escapeHtml(job.message)}</h3><p>当前正文没有变化。</p></div>`;
    return;
  }
  const reviewLabel = job.score == null ? '自动审稿未完成' : `审稿评分 ${job.score}`;
  area.innerHTML = `<div class="rewrite-compare"><section class="rewrite-column"><header><strong>当前版本</strong><span>第 ${job.original_version} 版 · ${fmt((original?.content || '').length)} 字</span></header><div class="rewrite-text">${escapeHtml(original?.content)}</div></section><section class="rewrite-column candidate"><header><strong>重写候选稿</strong><span>约 ${fmt(job.candidate_content.length)} 字</span></header><div class="rewrite-text">${escapeHtml(job.candidate_content)}</div><div class="rewrite-score">${reviewLabel} · ${escapeHtml(job.candidate_summary)}</div><div class="rewrite-score">${escapeHtml(job.message)}</div></section></div><div class="dialog-actions"><button class="ghost" id="discardRewriteBtn">放弃候选稿</button>${job.score==null?'<button class="ghost" id="retryRewriteReviewBtn">仅重新审稿</button>':''}<button class="primary" id="applyRewriteBtn">采用候选稿</button></div>`;
  $('#discardRewriteBtn').onclick = () => discardRewrite(job.id);
  $('#applyRewriteBtn').onclick = () => applyRewrite(job.id);
  if ($('#retryRewriteReviewBtn')) $('#retryRewriteReviewBtn').onclick = () => retryRewriteReview(job.id);
  const snapshot = job.context_snapshot;
  if (snapshot?.chapter) {
    const description = `知识截止：第${snapshot.chapter.number}章之前\n本章章纲：${snapshot.chapter.outline}\n单章要求：${snapshot.chapter.writing_instructions || '无'}\n前文摘要：${snapshot.previous.map(ch=>`第${ch.number}章 第${ch.version}版`).join('、') || '无'}\n已确认事实：\n${snapshot.facts.map(m=>`第${m.source_chapter}章 · ${m.subject}：${m.fact}`).join('\n') || '无'}\n仅审稿可见的后续摘要：${snapshot.next.map(ch=>`第${ch.number}章`).join('、') || '无'}\n本次资料在任务开始时固定，后续更新不会混入这次生成。`;
    area.insertAdjacentHTML('afterbegin', `<details class="context-snapshot"><summary>查看本次重写实际使用的资料</summary><pre>${escapeHtml(description)}</pre></details>`);
  }
}

async function retryRewriteReview(jobId) {
  const btn=$('#retryRewriteReviewBtn'); if(btn){btn.disabled=true;btn.textContent='正在审稿…';}
  try { const job=await api(`/api/rewrites/${jobId}/review`,{method:'POST',body:'{}'}); renderRewrite(job); toast('候选稿重新审稿完成'); }
  catch(error) { toast(error.message,true); const job=await api(`/api/rewrites/${jobId}`).catch(()=>null); if(job)renderRewrite(job); }
}

function watchRewrite(jobId) {
  clearInterval(state.rewritePoll);
  const check = async () => {
    try {
      const job = await api(`/api/rewrites/${jobId}`);
      if ($('#rewriteDialog').open && state.rewrite?.id === job.id) renderRewrite(job);
      if (job.status !== 'running') {
        clearInterval(state.rewritePoll); state.rewritePoll = null;
        const btn = $('#rewriteChapterBtn');
        if (btn && state.chapter?.id === job.chapter_id) { btn.textContent = job.status === 'completed' ? '↻ 查看候选稿' : '↻ 重写本章'; btn.onclick = job.status === 'completed' ? () => showRewrite(job) : openRewriteDialog; }
        toast(job.message, job.status === 'failed');
      }
    } catch(error) { clearInterval(state.rewritePoll); toast(error.message, true); }
  };
  check(); state.rewritePoll = setInterval(check, 1200);
}

async function applyRewrite(jobId) {
  const btn = $('#applyRewriteBtn'); if (btn) btn.disabled = true;
  try {
    if (editorDirty()) throw new Error('当前编辑内容未保存，请先保存后重新生成候选稿');
    await api(`/api/rewrites/${jobId}/apply`, {method:'POST', body:'{}'});
    $('#rewriteDialog').close();
    await openProject(state.project.id, true); await refreshDashboard();
    toast('候选稿已采用，原文已保存在历史版本中');
  } catch(error) { toast(error.message, true); if (btn) btn.disabled = false; }
}

async function discardRewrite(jobId) {
  try {
    await api(`/api/rewrites/${jobId}/discard`, {method:'POST', body:'{}'});
    $('#rewriteDialog').close();
    const btn = $('#rewriteChapterBtn'); if (btn) { btn.textContent='↻ 重写本章'; btn.onclick=openRewriteDialog; }
    toast('候选稿已放弃，原文保持不变');
  } catch(error) { toast(error.message, true); }
}

async function loadLatestSimilarity(chapterId) {
  try {
    const check = await api(`/api/chapters/${chapterId}/similarity-check`);
    if (!check || state.chapter?.id !== chapterId) return;
    const btn = $('#checkSimilarityBtn');
    if (!btn) return;
    btn.textContent = check.status === 'running' ? '⌕ 查重进行中…' : (check.status === 'completed' ? `⌕ 查重 ${check.score}%` : '⌕ 重新查重');
    btn.onclick = check.status === 'running' ? () => showSimilarity(check) : (check.status === 'completed' ? () => showSimilarity(check) : startSimilarityCheck);
    if (check.status === 'running') watchSimilarity(check.id);
  } catch {}
}

async function startSimilarityCheck() {
  if (!state.chapter) return;
  const title = $('#chapterTitleInput').value.trim();
  const content = $('#chapterContent').value;
  if (content.trim().length < 120) return toast('正文至少需要 120 个字符才能查重', true);
  try {
    await api(`/api/chapters/${state.chapter.id}`, {method:'PATCH', body:JSON.stringify({title,content,status:'completed'})});
    const check = await api(`/api/chapters/${state.chapter.id}/similarity-check`, {method:'POST', body:'{}'});
    showSimilarity(check); watchSimilarity(check.id);
  } catch(error) { toast(error.message, true); }
}

function showSimilarity(check) {
  const dialog = $('#similarityDialog');
  renderSimilarity(check);
  if (!dialog.open) dialog.showModal();
}

function renderSimilarity(check) {
  const area = $('#similarityContent');
  if (check.status === 'running') {
    area.innerHTML = `<div class="similarity-running"><div class="scan-pulse"></div><h3>正在检索公开网络</h3><p>${escapeHtml(check.message)}。长章节通常需要一至两分钟，可以关闭窗口继续编辑。</p></div>`;
    return;
  }
  if (check.status === 'failed') {
    area.innerHTML = `<div class="similarity-running"><h3>本次查重未完成</h3><p>${escapeHtml(check.message)}</p></div>`;
    return;
  }
  const risk = {low:['较低风险','#66806b'],medium:['需要核对','#b18445'],high:['较高风险','#a54b3f']}[check.risk] || ['未知','#888'];
  const matches = check.matches || [];
  area.innerHTML = `<div class="similarity-summary"><div class="score-ring" style="--score:${check.score};--ring-color:${risk[1]}"><strong>${check.score}%</strong></div><div><h3>${risk[0]}</h3><p>${escapeHtml(check.message)}。本次搜索了 ${check.searched_segments} 组特征句段。</p></div></div><div class="match-list">${matches.map(match => `<article class="match-card"><div class="match-head">${match.url ? `<a href="${escapeHtml(match.url)}" target="_blank" rel="noopener">${escapeHtml(match.title || match.url)}</a>` : `<strong>${escapeHtml(match.title)}</strong>`}<span class="match-score">相似 ${match.similarity}%</span></div><p>${escapeHtml(match.matched_text || '检测到相似文字组合')}</p>${match.source_excerpt ? `<small>来源片段：${escapeHtml(match.source_excerpt)}</small>` : ''}</article>`).join('') || '<div class="empty-state" style="padding:35px"><div class="empty-icon">✓</div><h3>未发现明显相似来源</h3><p>在本次公开网络搜索范围内没有可靠命中。</p></div>'}</div>`;
}

function watchSimilarity(checkId) {
  clearInterval(state.similarityPoll);
  const checkStatus = async () => {
    try {
      const check = await api(`/api/similarity-checks/${checkId}`);
      if ($('#similarityDialog').open) renderSimilarity(check);
      if (check.status !== 'running') {
        clearInterval(state.similarityPoll); state.similarityPoll = null;
        const btn = $('#checkSimilarityBtn');
        if (btn) { btn.textContent = check.status === 'completed' ? `⌕ 查重 ${check.score}%` : '⌕ 重新查重'; btn.onclick = check.status === 'completed' ? () => showSimilarity(check) : startSimilarityCheck; }
        toast(check.message, check.status === 'failed');
      }
    } catch(error) { clearInterval(state.similarityPoll); toast(error.message, true); }
  };
  checkStatus(); state.similarityPoll = setInterval(checkStatus, 1200);
}

async function refreshDashboard() { state.dashboard = await api('/api/dashboard'); renderDashboard(); }

let toastTimer;
function toast(message, error=false) {
  const el = $('#toast'); el.textContent = message; el.style.background = error ? '#8b3e35' : '#30312e'; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

init();
