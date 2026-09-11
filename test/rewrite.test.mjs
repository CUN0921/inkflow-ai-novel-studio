import test from 'node:test';
import assert from 'node:assert/strict';
import { RewriteService, buildRewriteContext } from '../src/rewrite-service.mjs';

test('重写作者上下文包含前文事实与分卷目标，隔离后续摘要', () => {
  const project = {
    outline:'全书主线', world:'世界规则', characters:[{name:'甲'}],
    volumes:[{id:'v1',goal:'本卷目标'}],
    chapters:[
      {id:'c1',number:1,status:'completed',summary:'第一章摘要'},
      {id:'c2',number:2,status:'completed',summary:'第二章摘要',volume_id:'v1',outline:'第二章目标'},
      {id:'c3',number:3,status:'completed',summary:'第三章摘要'}
    ],
    memories:[{source_chapter:1,status:'active',kind:'event',subject:'甲',fact:'发现线索'}],
    foreshadows:[{planted_chapter:1,status:'planted',title:'旧钥匙',visible_clue:'钥匙有划痕'}]
  };
  const text = buildRewriteContext(project, project.chapters[1]);
  assert.match(text, /本卷目标/);
  assert.match(text, /第一章摘要/);
  assert.doesNotMatch(text, /第三章摘要/);
  assert.match(text, /发现线索/);
  assert.match(text, /旧钥匙/);
});

test('审稿模型失败时仍保留并完成候选稿', async () => {
  const chapter = {id:'c1',project_id:'p1',number:1,title:'第一章',content:'原文',summary:'原摘要',status:'completed',volume_id:'v1',outline:'章纲'};
  const project = {
    id:'p1', tone:'克制', outline:'主线', world:'规则', characters:[], chapters:[chapter],
    volumes:[{id:'v1',goal:'卷目标'}],
    memories:[{source_chapter:1,kind:'event',subject:'甲',fact:'原有事实'}], foreshadows:[]
  };
  const updates = [];
  const db = {
    getRewriteJob:() => ({id:'r1',project_id:'p1',chapter_id:'c1',instruction:'加强冲突'}),
    getProject:() => project,
    updateRewriteJob:(_id, input) => { updates.push(input); return input; }
  };
  const models = {for:role => role === 'writer'
    ? {enabled:true, generate:async () => ({text:'候选正文'})}
    : {enabled:true, generate:async () => { throw new Error('审稿整理模型没有返回文本'); }}
  };
  const result = await new RewriteService(db, models).execute('r1');
  assert.equal(result.status, 'completed');
  assert.equal(result.candidateContent, '候选正文');
  assert.equal(result.candidateSummary, '');
  assert.deepEqual(result.candidateMemories, []);
  assert.equal(result.score, null);
  assert.match(result.message, /自动审稿暂未完成/);
});
