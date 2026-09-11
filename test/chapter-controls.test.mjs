import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NovelDatabase } from '../src/database.mjs';
import { WritingEngine } from '../src/writing-engine.mjs';
import { RewriteService } from '../src/rewrite-service.mjs';
import { chapterContext, writerContext, reviewerContinuity } from '../src/chapter-context.mjs';

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(),'inkflow-chapter-control-'));
  const filename = join(folder,'test.db');
  const db = new NovelDatabase(filename);
  t.after(() => { db.close(); rmSync(folder,{recursive:true,force:true}); });
  const project = db.planDemo(db.createProject({title:'测试小说',premise:'逐章检验'}).id);
  return {db,project,filename};
}
function models(generate) { return {for:role=>({enabled:true,generate:request=>generate(role,request)}),enabledFor:()=>true}; }
const review = () => ({text:JSON.stringify({score:90,summary:'本章完成搜寻',memories:[{kind:'event',subject:'主角',fact:'找到本章线索'}],issues:[]})});
async function settled(engine) {
  const deadline = Date.now()+5000;
  while(engine.controls.size && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(engine.controls.size,0,'任务应按时结束');
}

test('章纲和单章要求持久化，章纲变更不改正文版本并阻止旧版本覆盖', t => {
  const {db,project,filename} = fixture(t), ch = project.chapters[0];
  const saved = db.saveChapter(ch.id,{outline:'自定义行动',writingInstructions:'只用第一人称',targetWords:1800,expectedRevision:ch.revision});
  assert.equal(saved.version,ch.version);
  assert.equal(saved.revision,ch.revision+1);
  assert.throws(()=>db.saveChapter(ch.id,{outline:'过期编辑',expectedRevision:ch.revision}),/已被修改/);
  const second = new NovelDatabase(filename);
  try { assert.equal(second.getChapter(ch.id).writing_instructions,'只用第一人称'); assert.equal(second.getChapter(ch.id).target_words,1800); }
  finally { second.close(); }
});

test('下一章写作读取上一章结尾片段、交接卡和自定义开篇要求', async t => {
  const {db,project} = fixture(t), previous = project.chapters[0], next = project.chapters[1];
  const previousContent = '灯塔外的雨声突然停了。\n沈屿握紧盐渍信纸，听见门后传来第三下敲门声。';
  db.saveChapter(previous.id, {
    content:previousContent, summary:'沈屿在灯塔门后听见异常敲门声。', status:'completed', contextStale:0,
    handoff:{sourceChapter:1,sourceVersion:2,location:'灯塔值班室门前',time:'深夜',characterStates:['沈屿握着盐渍信纸'],lastAction:'门后传来第三下敲门声',emotionalState:'警惕',newKnowledge:['敲门声不是风造成的'],carriedItems:['盐渍信纸'],unresolved:['门后是谁'],nextOpening:'从第三下敲门声的直接反应开始',lastLine:'门后传来第三下敲门声。'}
  });
  db.saveChapter(next.id,{openingInstructions:'先写人物对第三下敲门声的反应，不要重新介绍灯塔'});
  const seen=[];
  const engine=new WritingEngine(db,models(async(role,request)=>{ if(role==='writer'){seen.push(request.input); return {text:'下一章正文'};} return {text:JSON.stringify({score:90,summary:'本章完成承接',memories:[],issues:[],handoff:{location:'新地点',lastAction:'新的转折'}})}; }));
  const run=engine.start(project.id,{chapterIds:[next.id]}); await settled(engine);
  assert.equal(db.getRun(run.id).status,'completed');
  assert.match(seen[0],/地点：灯塔值班室门前/);
  assert.match(seen[0],/第三下敲门声/);
  assert.match(seen[0],/灯塔外的雨声突然停了/);
  assert.match(seen[0],/先写人物对第三下敲门声的反应/);
  assert.equal(db.getChapter(next.id).handoff.sourceVersion,2);
  assert.equal(db.getChapter(next.id).handoff.location,'新地点');
  assert.equal(db.getChapter(next.id).handoff.lastAction,'新的转折');
});

test('指定第4和2章会按2、4写作，跳过其他章，并使用各章要求和前文知识截止', async t => {
  const {db,project} = fixture(t), seen=[];
  db.saveChapter(project.chapters[1].id,{writingInstructions:'只用第一人称',targetWords:1500});
  db.saveChapter(project.chapters[8].id,{content:'后文',summary:'未来摘要秘密',status:'completed',contextStale:0});
  db.addMemory(project.id,{sourceChapter:9,subject:'秘密',fact:'未来事实秘密'});
  const engine = new WritingEngine(db,models(async(role,request)=>{
    if (role==='writer') { seen.push(request); return {text:'指定章节正文'}; }
    return review();
  }));
  const run=engine.start(project.id,{chapterIds:[project.chapters[3].id,project.chapters[1].id]});
  await settled(engine);
  assert.equal(db.getRun(run.id).status,'completed');
  assert.deepEqual(db.getRun(run.id).chapter_ids,[project.chapters[1].id,project.chapters[3].id]);
  assert.equal(db.getChapter(project.chapters[0].id).content,'');
  assert.equal(db.getChapter(project.chapters[2].id).content,'');
  assert.match(seen[0].input,/第2章/); assert.match(seen[1].input,/第4章/);
  assert.match(seen[0].input,/只用第一人称/); assert.match(seen[0].input,/1500字/);
  for (const request of seen) assert.doesNotMatch(request.input,/未来摘要秘密|未来事实秘密/);
  assert.match(seen[1].input,/找到本章线索/);
});

test('写作队列拒绝已有正文、跨作品、重复以及空章节选择', t => {
  const {db,project}=fixture(t), ch=project.chapters[0];
  const engine=new WritingEngine(db,models(()=>{ throw new Error('不应调用模型'); }));
  for (const ids of [[],['unknown'],[ch.id,ch.id]]) assert.throws(()=>engine.start(project.id,{chapterIds:ids}));
  db.saveChapter(ch.id,{content:'用户正文'});
  assert.throws(()=>engine.start(project.id,{chapterIds:[ch.id]}),/已有正文/);
  assert.equal(db.runningRuns().length,0);
});

test('生成中编辑章纲时停止保存，保留用户的新计划', async t => {
  const {db,project}=fixture(t), ch=project.chapters[0];
  const engine=new WritingEngine(db,models(async(role)=>{
    if (role==='writer') { db.saveChapter(ch.id,{outline:'生成期间的新章纲'}); return {text:'旧计划生成稿'}; }
    return review();
  }));
  const run=engine.start(project.id,{chapterIds:[ch.id]}); await settled(engine);
  assert.equal(db.getRun(run.id).status,'failed');
  assert.match(db.getRun(run.id).message,/已变更/);
  assert.equal(db.getChapter(ch.id).content,'');
  assert.equal(db.getChapter(ch.id).outline,'生成期间的新章纲');
});

test('重启恢复使用持久化的剩余章节选择', async t => {
  const {db,project}=fixture(t);
  db.saveChapter(project.chapters[1].id,{content:'已完成第二章',summary:'第二章摘要',status:'completed'});
  const run=db.createRun(project.id,2,[project.chapters[1].id,project.chapters[3].id]);
  db.updateRun(run.id,{completedChapters:1});
  const seen=[];
  const engine=new WritingEngine(db,models(async(role,request)=>{
    if(role==='writer') { seen.push(request.input); return {text:'第四章新正文'}; } return review();
  }));
  engine.resume(run.id); await settled(engine);
  assert.equal(seen.length,1); assert.match(seen[0],/当前章：第4章/);
  assert.equal(db.getRun(run.id).completed_chapters,2);
  assert.equal(db.getChapter(project.chapters[0].id).content,'');
});

test('扩展承接未写章纲与用户要求，可选数量和分卷，且不覆盖已有计划', async t => {
  const {db,project}=fixture(t); let input;
  db.saveChapter(project.chapters[9].id,{outline:'必须承接的待写转折',writingInstructions:'不要揭露凶手'});
  const engine=new WritingEngine(db,models(async(_role,request)=>{
    input=request.input;
    return {text:JSON.stringify({chapters:[11,12,13].map(number=>({number,title:'新章',outline:'具体行动'}))})};
  }));
  const extended=await engine.extendPlan(project.id,{count:3,volumeNumber:2,instruction:'安排一次失败'});
  assert.match(input,/必须承接的待写转折/); assert.match(input,/不要揭露凶手/); assert.match(input,/安排一次失败/);
  assert.equal(extended.chapters.length,13);
  assert.equal(extended.chapters[10].volume_id,project.volumes[1].id);
  assert.equal(extended.chapters[9].outline,'必须承接的待写转折');
  await assert.rejects(()=>engine.extendPlan(project.id,{count:3}),/连续且完整/);
  assert.equal(db.getProject(project.id).chapters.length,13);
});

test('重写记忆排除未来、待复核和版本不匹配事实；后续摘要只给审稿', t => {
  const {db,project}=fixture(t);
  for(const ch of project.chapters.slice(0,4)) db.saveChapter(ch.id,{content:`第${ch.number}章`,summary:`第${ch.number}章摘要`,status:'completed',contextStale:0});
  db.addMemory(project.id,{sourceChapter:1,subject:'主角',fact:'过去事实'});
  db.addMemory(project.id,{sourceChapter:4,subject:'主角',fact:'未来秘密'});
  db.addMemory(project.id,{sourceChapter:2,subject:'主角',fact:'无效版本事实'});
  db.run("UPDATE memories SET source_version=0 WHERE fact='无效版本事实'");
  db.addMemory(project.id,{sourceChapter:1,subject:'主角',fact:'待复核事实'});
  db.run("UPDATE memories SET status='needs_review' WHERE fact='待复核事实'");
  const snapshot=chapterContext(db.getProject(project.id),db.getChapter(project.chapters[2].id));
  const input=writerContext(snapshot);
  assert.match(input,/过去事实/);
  assert.doesNotMatch(input,/未来秘密|无效版本事实|待复核事实|第4章摘要/);
  assert.match(reviewerContinuity(snapshot),/第4章摘要/);
});

test('重写期间记忆更新不会混入任务快照，采用时会拒绝过期依据', async t => {
  const {db,project}=fixture(t);
  for(const ch of project.chapters.slice(0,3)) db.saveChapter(ch.id,{content:`第${ch.number}章正文`,summary:`第${ch.number}章摘要`,status:'completed',contextStale:0});
  const chapter=db.getChapter(project.chapters[1].id);
  const snapshot=chapterContext(db.getProject(project.id),chapter);
  const job=db.createRewriteJob(chapter,'加强冲突',snapshot);
  const requests=[];
  const service=new RewriteService(db,models(async(role,request)=>{
    requests.push({role,input:request.input});
    if(role==='writer') {
      db.addMemory(project.id,{sourceChapter:1,subject:'主角',fact:'生成后追加的事实'});
      return {text:'新的候选正文'};
    }
    return review();
  }));
  await service.execute(job.id);
  assert.doesNotMatch(requests[0].input,/第3章摘要/);
  assert.match(requests[1].input,/第3章摘要/);
  for(const request of requests) assert.doesNotMatch(request.input,/生成后追加的事实/);
  assert.deepEqual(db.getRewriteJob(job.id).context_snapshot,snapshot);
  assert.throws(()=>db.applyRewriteJob(job.id),/故事依据发生了变化/);
  assert.equal(db.getChapter(chapter.id).content,chapter.content);
});

test('重写候选稿会保存并采用新的章节交接卡', async t => {
  const {db,project}=fixture(t);
  const chapterId=project.chapters[0].id;
  db.saveChapter(chapterId,{content:'原章节正文',summary:'原章节摘要',status:'completed'});
  const chapter=db.getChapter(chapterId);
  const job=db.createRewriteJob(chapter,'加强结尾悬念',chapterContext(db.getProject(project.id),chapter));
  const service=new RewriteService(db,models(async(role)=> role==='writer'
    ? {text:'重写后的章节正文'}
    : {text:JSON.stringify({score:93,summary:'重写后留下新的线索',memories:[],handoff:{location:'港口仓库',lastAction:'仓门在身后落锁',nextOpening:'从仓门落锁后的第一反应开始'}})}));
  await service.execute(job.id);
  const candidate=db.getRewriteJob(job.id);
  assert.equal(candidate.candidate_handoff.location,'港口仓库');
  db.applyRewriteJob(job.id);
  const saved=db.getChapter(chapter.id);
  assert.equal(saved.handoff.sourceVersion,saved.version);
  assert.equal(saved.handoff.lastAction,'仓门在身后落锁');
});

test('采用未审稿候选稿不会复活旧记忆，后续记忆和摘要会待复核', async t => {
  const {db,project}=fixture(t);
  for(const ch of project.chapters.slice(0,2)) {
    db.saveChapter(ch.id,{content:'原文',summary:'旧摘要',status:'completed'});
    db.addMemory(project.id,{sourceChapter:ch.number,subject:'主角',fact:`第${ch.number}章旧事实`});
  }
  const chapter=db.getChapter(project.chapters[0].id);
  const job=db.createRewriteJob(chapter,'修改剧情',chapterContext(db.getProject(project.id),chapter));
  const service=new RewriteService(db,models(async(role)=>{
    if(role==='writer') return {text:'改变事实的新稿'};
    throw new Error('审稿模型没有返回文本');
  }));
  await service.execute(job.id); db.applyRewriteJob(job.id);
  assert.equal(db.getChapter(chapter.id).summary,'');
  assert.equal(db.getChapter(chapter.id).context_stale,1);
  assert.equal(db.getChapter(project.chapters[1].id).context_stale,1);
  assert.deepEqual(db.getChapter(project.chapters[1].id).handoff,{});
  assert.equal(db.getProject(project.id).memories.filter(m=>m.status==='active').length,0);
  const context=chapterContext(db.getProject(project.id),project.chapters[2]);
  assert.equal(context.previous.length,0);
  assert.equal(context.facts.length,0);
});

test('暂停会先保存当前模型返回的草稿，恢复后从资料整理继续', async t => {
  const {db,project}=fixture(t), chapter=project.chapters[0]; let engine;
  const routed=models(async(role)=>{
    if(role==='writer') { engine.stop([...engine.controls.keys()][0]); return {text:'暂停前已经返回的完整草稿'}; }
    return review();
  });
  routed.reviewEnabled=true;
  engine=new WritingEngine(db,routed);
  const run=engine.start(project.id,{chapterIds:[chapter.id]});
  await settled(engine);
  assert.equal(db.getRun(run.id).status,'paused');
  assert.equal(db.getChapter(chapter.id).status,'draft');
  assert.equal(db.getChapter(chapter.id).content,'暂停前已经返回的完整草稿');
  engine.resume(run.id); await settled(engine);
  assert.equal(db.getRun(run.id).status,'completed');
  assert.equal(db.getChapter(chapter.id).status,'completed');
});

test('严重审稿问题会保留草稿并暂停后续章节', async t => {
  const {db,project}=fixture(t);
  const routed=models(async(role)=> role==='writer' ? {text:'存在严重矛盾的正文'} : {text:JSON.stringify({
    score:40,summary:'本章存在时间线矛盾',memories:[],issues:[{severity:'critical',category:'timeline',message:'人物在到达前已经离开'}],handoff:{lastAction:'人物离开'}
  })});
  routed.reviewEnabled=true;
  const engine=new WritingEngine(db,routed);
  const run=engine.start(project.id,{chapterIds:[project.chapters[0].id,project.chapters[1].id]});
  await settled(engine);
  assert.equal(db.getRun(run.id).status,'paused');
  assert.equal(db.getRun(run.id).current_step,'needs-attention');
  assert.equal(db.getChapter(project.chapters[0].id).status,'draft');
  assert.equal(db.getChapter(project.chapters[1].id).content,'');
});

test('结构化章纲、人物变化和伏笔进展会保存并进入后续上下文', async t => {
  const {db,project}=fixture(t), first=project.chapters[0], second=project.chapters[1];
  db.saveChapter(first.id,{plan:{openingState:'雨夜码头',cast:['顾临舟','林鸥'],goal:'找到证人',turn:'证人倒戈',mustHappen:'林鸥交出船票',endingState:'两人被追踪'}});
  const routed=models(async(role,request)=>{
    if(role==='writer') { assert.match(request.input,/雨夜码头|林鸥交出船票/); return {text:'林鸥在码头交出船票。'}; }
    return {text:JSON.stringify({score:91,summary:'林鸥交出船票',memories:[{kind:'item',subject:'船票',fact:'由林鸥交给顾临舟',importance:5}],
      characters:[{name:'林鸥',role:'证人',aliases:[],relationship:'暂时帮助顾临舟',goal:'离开港城',location:'码头',state:'被追踪',importance:'minor'}],
      foreshadows:[{title:'第十三封信',status:'advanced',evidence:'船票背面出现同样盐渍'}],issues:[],handoff:{location:'码头',lastAction:'两人发现追踪者'}})};
  });
  routed.reviewEnabled=true;
  const engine=new WritingEngine(db,routed);
  const run=engine.start(project.id,{chapterIds:[first.id]}); await settled(engine);
  const saved=db.getProject(project.id);
  assert.equal(saved.chapters[0].plan_result.goal,'partial');
  assert.ok(saved.characters.some(item=>item.name==='林鸥' && item.state==='被追踪'));
  assert.equal(saved.foreshadows.find(item=>item.title==='第十三封信').status,'advanced');
  assert.equal(saved.memories.find(item=>item.subject==='船票').importance,5);
  const context=chapterContext(saved,second);
  assert.ok(context.project.characters.some(item=>item.name==='林鸥'));
  assert.match(writerContext(context),/船票/);
});

test('正文写作使用界面配置的完整输出预算，不再按目标字数二次压低', async t => {
  const {db,project}=fixture(t), seen=[];
  db.saveChapter(project.chapters[0].id,{targetWords:1000});
  const routed={
    reviewEnabled:true, enabledFor:()=>true, outputTokens:role=>role==='writer'?24000:6000,
    for:role=>({enabled:true,generate:async request=>{ seen.push({role,budget:request.maxOutputTokens}); return role==='writer'?{text:'正文'}:review(); }})
  };
  const engine=new WritingEngine(db,routed);
  engine.start(project.id,{chapterIds:[project.chapters[0].id]}); await settled(engine);
  assert.equal(seen.find(item=>item.role==='writer').budget,24000);
});
