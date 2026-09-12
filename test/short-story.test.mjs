import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NovelDatabase } from '../src/database.mjs';
import { WritingEngine } from '../src/writing-engine.mjs';

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(),'inkflow-short-story-'));
  const db = new NovelDatabase(join(folder,'test.db'));
  t.after(() => { db.close(); rmSync(folder,{recursive:true,force:true}); });
  return db;
}

function router(generate, enabled=true) {
  return {
    reviewEnabled:true,
    enabledFor:()=>enabled,
    outputTokens:(_role,fallback)=>fallback,
    for:role=>({enabled,generate:request=>generate(role,request)})
  };
}

test('短故事项目限制平台篇幅并只创建一篇完整稿件', t => {
  const db = fixture(t);
  assert.throws(() => db.createProject({title:'太短',mode:'short',targetWords:5999}),/6000/);
  assert.throws(() => db.createProject({title:'太长',mode:'short',targetWords:80001}),/80000/);
  const created = db.createProject({title:'未寄出的录音',genre:'悬疑',premise:'死者在七天后发来录音',mode:'short',targetWords:15000,perspective:'third'});
  const project = db.planDemo(created.id);
  assert.equal(project.mode,'short');
  assert.equal(project.short_config.perspective,'third');
  assert.equal(project.volumes.length,1);
  assert.equal(project.chapters.length,1);
  assert.equal(project.chapters[0].target_words,15000);
  assert.match(project.short_config.hook,/前三段|开篇/);
  assert.throws(() => db.saveChapter(project.chapters[0].id,{targetWords:80001}),/80000/);
  assert.doesNotThrow(() => db.saveChapter(project.chapters[0].id,{targetWords:6000}));
});

test('规划模型必须返回钩子、递进反转、高潮和闭环结局', async t => {
  const db = fixture(t);
  const project = db.createProject({title:'末班船',genre:'现实悬疑',premise:'摆渡人发现最后一位乘客是失踪多年的自己',mode:'short',targetWords:20000,perspective:'first'});
  const calls=[];
  const value = {
    outline:'摆渡人追查乘客身份并面对自己掩藏的事故真相。',world:'渡口只在暴雨夜开最后一班船。',
    characters:[{name:'周渡',role:'摆渡人'},{name:'乘客',role:'神秘来客'}],
    storyOutline:'暴雨夜出现陌生乘客，身份线索两次翻转，周渡在沉船遗址面对真相并完成选择。',
    plan:{openingState:'陌生乘客登船',cast:['周渡','乘客'],goal:'查明身份',turn:'乘客其实是周渡被压抑的记忆',mustHappen:'两次反转与沉船高潮',endingState:'周渡救回幸存者并坦白'},
    shortStory:{recommendedTitle:'《末班船上的我》',titleOptions:['《暴雨渡口》'],category:'悬疑',perspective:'first',hook:'乘客递来一张写着我名字的死亡证明。',coreConflict:'周渡必须在自保与救人之间选择。',emotionalArc:'疑惧—否认—崩溃—承担',reversals:['乘客知道事故细节','乘客是记忆投影'],climax:'周渡重返沉船救出幸存者。',ending:'周渡公开事故并重新生活。',trialHook:'乘客摘下帽子，露出和我相同的脸。'}
  };
  const models = router(async(role,request) => {
    calls.push({role,request});
    const validated = request.validate(JSON.stringify(value));
    return {text:JSON.stringify(value),value:validated};
  });
  const planned = await new WritingEngine(db,models).createPlan(project.id);
  assert.equal(calls.length,1);
  assert.equal(calls[0].request.meta.task,'short-plan');
  assert.match(calls[0].request.input,/6000–80000/);
  assert.match(calls[0].request.input,/一篇文章完结/);
  assert.equal(planned.chapters.length,1);
  assert.equal(planned.chapters[0].outline,value.storyOutline);
  assert.deepEqual(planned.short_config.reversals,value.shortStory.reversals);

  const invalid = structuredClone(value);
  invalid.shortStory.reversals = ['只有一次'];
  const rejected = router(async(_role,request) => ({text:JSON.stringify(invalid),value:request.validate(JSON.stringify(invalid))}));
  const another = db.createProject({title:'无反转稿',mode:'short',targetWords:10000});
  await assert.rejects(() => new WritingEngine(db,rejected).createPlan(another.id),/至少需要两个/);
});

test('短故事写作和审稿使用全文闭环规则', async t => {
  const db = fixture(t);
  const project = db.planDemo(db.createProject({title:'七日回声',mode:'short',targetWords:12000,perspective:'first'}).id);
  const seen=[];
  const models = router(async(role,request) => {
    seen.push({role,request});
    if (role === 'writer') return {text:'我在第七天听完录音，终于说出了事故真相。'};
    const result = {score:92,summary:'主人公听完录音并公开真相。',revisedContent:'',planCheck:{goal:'done',turn:'done',mustHappen:'done',endingState:'done',note:'闭环完整'},memories:[],characters:[],foreshadows:[],issues:[],handoff:{lastAction:'主人公公开真相',lastLine:'我终于说出了事故真相。'}};
    return {text:JSON.stringify(result),value:request.validate(JSON.stringify(result))};
  });
  const engine = new WritingEngine(db,models);
  const draft = await engine.writeChapter(project,project.chapters[0]);
  assert.match(seen[0].request.instructions,/全文必须在一篇内完结/);
  assert.match(seen[0].request.input,/不要输出.*第X章/);
  const review = await engine.reviewChapter(project,project.chapters[0],draft.content);
  assert.equal(review.score,92);
  assert.match(seen[1].request.instructions,/短故事责任编辑/);
  assert.match(seen[1].request.input,/核心冲突、关键反转、高潮或结局/);
  await assert.rejects(() => engine.extendPlan(project.id),/不使用扩展章纲/);
});
