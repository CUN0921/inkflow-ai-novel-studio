import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovelDatabase } from '../src/database.mjs';
import { ModelRouter, parseJsonText } from '../src/ai.mjs';
import { WritingEngine } from '../src/writing-engine.mjs';
import { RewriteService } from '../src/rewrite-service.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-qa-anomalies-'));
  let db;
  t.after(() => { db?.close(); rmSync(dir, { recursive:true, force:true }); });
  db = new NovelDatabase(join(dir, 'qa.db'));
  return db;
}

function env() {
  return {
    OPENAI_API_KEY:'qa-key', OPENAI_MODEL:'qa-model',
    OPENAI_BASE_URL:'https://qa.invalid/v1', OPENAI_PROTOCOL:'responses'
  };
}

async function waitForRun(db, engine, runId) {
  const deadline = Date.now() + 3000;
  while (engine.controls.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return db.getRun(runId);
}

test('QA: Responses 截断规划会失败且保留截断返回，临时数据库不写入规划', async t => {
  const db = fixture(t);
  const project = db.createProject({ title:'截断规划', premise:'测试返回截断' });
  const events = [];
  const router = new ModelRouter(env(), {
    fetchImpl:async () => ({ ok:true, json:async () => ({
      status:'incomplete', incomplete_details:{reason:'max_output_tokens'},
      output_text:'{"outline":"未完成'
    }) }),
    onEvent:event => events.push(event)
  });

  await assert.rejects(() => new WritingEngine(db, router).createPlan(project.id), /返回被截断/);
  assert.equal(db.getProject(project.id).outline, '');
  assert.deepEqual(events.map(event => event.status), ['running', 'failed']);
  assert.equal(events.at(-1).responseText, '{"outline":"未完成');
});

test('QA: 写作链路审稿无效 JSON 会保留正文，并可仅重试审稿', async t => {
  const db = fixture(t);
  const project = db.planDemo(db.createProject({ title:'正文保留', premise:'审稿失败后保留正文' }).id);
  let reviewAttempts = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const isReview = body.instructions.includes('责任编辑');
    return { ok:true, json:async () => ({
      output_text:isReview
        ? (++reviewAttempts === 1 ? '{"score":' : JSON.stringify({score:91,summary:'本章事实摘要',memories:[],issues:[]}))
        : '这是已经生成的正文。',
      usage:{ output_tokens:12, total_tokens:12 }
    }) };
  };
  const events = [];
  const router = new ModelRouter(env(), { fetchImpl, onEvent:event => events.push(event) });
  const engine = new WritingEngine(db, router);
  const run = engine.start(project.id, { chapterIds:[project.chapters[0].id] });
  const finished = await waitForRun(db, engine, run.id);
  const chapter = db.getChapter(project.chapters[0].id);

  assert.equal(finished.status, 'failed', '审稿失败后任务应停止，等待单独重试审稿');
  assert.equal(chapter.content, '这是已经生成的正文。', '审稿失败时正文应保留');
  assert.equal(chapter.status, 'draft');
  assert.equal(chapter.review_score, null);
  assert.equal(events.findLast(event => event.task === 'review').status, 'failed', '审稿 JSON 失败应反映为失败状态');

  const retry = engine.startReview(chapter.id);
  const retryRun = await waitForRun(db, engine, retry.id);
  const reviewed = db.getChapter(chapter.id);
  assert.equal(retryRun.status, 'completed');
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.review_score, 91);
  assert.equal(reviewAttempts, 2);
});

test('QA: 重写链路审稿无效 JSON 会保留候选稿，但当前没有仅重试审稿入口', async t => {
  const db = fixture(t);
  const project = db.planDemo(db.createProject({ title:'重写审稿重试' }).id);
  const chapter = db.getChapter(project.chapters[0].id);
  db.saveChapter(chapter.id, { content:'原始正文', status:'completed' });
  let reviewCalls = 0;
  const models = {
    reviewEnabled:true,
    for:role => ({
      enabled:true,
      generate:async () => role === 'writer'
        ? {text:'重写候选正文'}
        : (++reviewCalls, {text:'{"score":'})
    })
  };
  const service = new RewriteService(db, models);
  const jobRecord = db.createRewriteJob(chapter, '增强冲突');
  const job = await service.execute(jobRecord.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.candidate_content, '重写候选正文');
  assert.equal(job.score, null);
  assert.equal(typeof service.retryReview, 'function', '预期修复后：应能直接对已有候选稿重试审稿');
  assert.equal(reviewCalls, 1);
});

test('QA: 规划结构化 JSON 解析失败时模型动态标记为失败', async t => {
  const db = fixture(t);
  const project = db.createProject({ title:'动态状态', premise:'动态状态测试' });
  const router = new ModelRouter(env(), {
    fetchImpl:async () => ({ ok:true, json:async () => ({ output_text:'{"outline":' }) }),
    onEvent:event => db.addModelEvent({ ...event, projectId:project.id })
  });
  const engine = new WritingEngine(db, router);
  await assert.rejects(() => engine.createPlan(project.id), /不是有效的 JSON/);
  const event = db.listModelEvents(project.id)[0];
  assert.equal(event.status, 'failed', '预期修复后：规划 JSON 失败应在动态中显示失败');
  assert.match(event.response_text, /outline/);
});

test('QA: AIClient 的显式校验会把无效 JSON 记录为失败并保留返回片段', async t => {
  const db = fixture(t);
  const project = db.createProject({ title:'显式校验' });
  const router = new ModelRouter(env(), {
    fetchImpl:async () => ({ ok:true, json:async () => ({ output_text:'{"bad":' }) }),
    onEvent:event => db.addModelEvent({ ...event, projectId:project.id })
  });
  await assert.rejects(() => router.for('reviewer').generate({
    instructions:'审稿', input:'只返回 JSON', validate:parseJsonText
  }), /校验失败/);
  const event = db.listModelEvents(project.id)[0];
  assert.equal(event.status, 'failed');
  assert.equal(event.response_text, '{"bad":');
});
