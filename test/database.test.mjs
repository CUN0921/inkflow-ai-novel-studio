import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NovelDatabase, countWords } from '../src/database.mjs';

test('中文和英文内容可统计字数', () => {
  assert.equal(countWords('你好，世界 hello world'), 6);
});

test('作品、规划、章节版本与记忆能持久保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-'));
  const db = new NovelDatabase(join(dir, 'test.db'));
  try {
    const project = db.createProject({title:'测试故事', genre:'科幻', premise:'时间停止了一分钟', targetWords:300000});
    const planned = db.planDemo(project.id);
    assert.equal(planned.volumes.length, 3);
    assert.equal(planned.chapters.length, 10);
    assert.match(planned.outline, /时间停止/);
    const chapter = planned.chapters[0];
    db.saveChapter(chapter.id, {content:'第一版正文', status:'completed'});
    db.saveChapter(chapter.id, {content:'第二版正文'});
    assert.equal(db.getChapter(chapter.id).version, 3);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id=?', chapter.id).n, 1);
    db.addMemory(project.id, {sourceChapter:1, kind:'event', subject:'主角', fact:'发现异常'});
    assert.equal(db.getProject(project.id).memories.length, 1);
  } finally {
    db.close(); rmSync(dir, {recursive:true, force:true});
  }
});

test('模型动态按项目持久保存并更新同一条调用记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-model-events-'));
  const db = new NovelDatabase(join(dir, 'test.db'));
  try {
    const requestText = '系统提示与章节上下文';
    const project = db.createProject({title:'模型动态测试',premise:'事件'});
    db.addModelEvent({id:'event-1',projectId:project.id,task:'write',role:'正文写作',model:'demo',protocol:'responses',status:'running',message:'已提交',requestText,requestLength:requestText.length,outputBudget:4321});
    db.addModelEvent({id:'event-1',projectId:project.id,task:'write',role:'正文写作',model:'demo',protocol:'responses',status:'completed',message:'已返回',requestText,requestLength:requestText.length,outputBudget:4321,responseText:'候选正文',usage:{total_tokens:42},durationMs:1234});
    const events = db.listModelEvents(project.id);
    assert.equal(events.length,1);
    assert.equal(events[0].status,'completed');
    assert.equal(events[0].response_text,'候选正文');
    assert.equal(events[0].request_text,requestText);
    assert.equal(events[0].request_length,requestText.length);
    assert.equal(events[0].output_budget,4321);
    assert.equal(JSON.parse(events[0].usage).total_tokens,42);
    assert.equal(events[0].duration_ms,1234);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('章节重写先保存候选稿，采用后才替换正文和记忆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-rewrite-'));
  const db = new NovelDatabase(join(dir, 'test.db'));
  try {
    const project = db.createProject({title:'重写测试', premise:'测试候选版本'});
    const planned = db.planDemo(project.id);
    const chapter = planned.chapters[0];
    const original = db.saveChapter(chapter.id, {content:'这是原始章节正文。'.repeat(20), summary:'原摘要', status:'completed'});
    db.addMemory(project.id, {sourceChapter:1, kind:'event', subject:'主角', fact:'旧事实'});
    const job = db.createRewriteJob(original, '加强冲突');
    db.updateRewriteJob(job.id, {status:'completed', candidateContent:'这是全新的候选正文。'.repeat(20), candidateSummary:'新摘要', candidateMemories:[{kind:'event',subject:'主角',fact:'新事实'}], score:91});
    assert.match(db.getChapter(chapter.id).content, /原始章节/);
    const applied = db.applyRewriteJob(job.id);
    assert.match(applied.content, /全新的候选正文/);
    assert.equal(applied.version, original.version + 1);
    const memories = db.getProject(project.id).memories;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].fact, '新事实');
    assert.equal(db.getRewriteJob(job.id).status, 'accepted');
  } finally {
    db.close(); rmSync(dir, {recursive:true, force:true});
  }
});
