import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioSettings } from '../src/studio-settings.mjs';
import { ModelRouter } from '../src/ai.mjs';
import { NovelDatabase } from '../src/database.mjs';
import { WritingEngine } from '../src/writing-engine.mjs';
import { RewriteService } from '../src/rewrite-service.mjs';

function fixture(t, close = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-settings-'));
  t.after(() => { close(); rmSync(dir, {recursive:true,force:true}); });
  return dir;
}

test('设置持久化、密钥留空保留/清除、非法设置不覆盖、读取不泄露密钥', t => {
  const file = join(fixture(t), 'settings.json');
  const env = () => ({OPENAI_API_KEY:'private-test-secret',OPENAI_MODEL:'default-model',OPENAI_BASE_URL:'https://example.test/v1'});
  const settings = new StudioSettings(file, env);
  const input = settings.describe();
  assert.equal(input.reviewEnabled,true);
  assert.ok(!JSON.stringify(input).includes('private-test-secret'));
  input.reviewEnabled = false;
  input.profiles[1].model = 'custom-writer';
  input.profiles[1].apiKey = 'changed-secret';
  input.profiles[1].baseUrl = 'https://writer.test/chat/completions';
  input.profiles[1].protocol = 'chat';
  input.profiles[1].reasoningEffort = 'low';
  settings.save(input);
  const restored = new StudioSettings(file,env);
  const router = new ModelRouter(restored.effectiveEnv());
  assert.equal(router.reviewEnabled,false);
  assert.equal(router.for('writer').model,'custom-writer');
  assert.equal(router.for('writer').reasoningEffort,'low');
  assert.equal(router.for('writer').apiKey,'changed-secret');
  assert.equal(router.for('planner').apiKey,'private-test-secret');
  const safe = restored.describe();
  assert.ok(!JSON.stringify(safe).includes('secret'));
  restored.save(safe);
  assert.equal(new ModelRouter(restored.effectiveEnv()).for('writer').apiKey,'changed-secret');
  const before = readFileSync(file,'utf8');
  const invalid = structuredClone(safe); invalid.profiles[1].baseUrl = 'not-a-url';
  assert.throws(() => restored.save(invalid), /地址/);
  assert.equal(readFileSync(file,'utf8'),before);
  safe.profiles[1].clearApiKey = true;
  restored.save(safe);
  assert.equal(new ModelRouter(restored.effectiveEnv()).for('writer').enabled,false);
});

test('关闭质量审稿仍整理摘要和记忆，正文无评分且开关可恢复', async t => {
  let db;
  db = new NovelDatabase(join(fixture(t,()=>db?.close()),'test.db'));
  const p = db.planDemo(db.createProject({title:'审稿开关测试'}).id);
  const calls = [];
  const models = {reviewEnabled:false,enabledFor:()=>true,for:role=>({enabled:true,generate:async()=>{
    calls.push(role);
    return {text:role==='writer'?'这是生成的正文。':JSON.stringify({score:92,summary:'主角找到钥匙',memories:[{kind:'event',subject:'主角',fact:'找到钥匙'}],issues:[],handoff:{lastAction:'主角收好钥匙'}})};
  }})};
  const engine = new WritingEngine(db,models);
  async function run(ids) {
    const task = engine.start(p.id,{chapterIds:ids});
    const deadline = Date.now()+5000;
    while(engine.controls.size && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
    assert.equal(db.getRun(task.id).status,'completed');
  }
  await run(p.chapters.slice(0,2).map(ch=>ch.id));
  assert.deepEqual(calls,['writer','reviewer','writer','reviewer']);
  const saved = db.getProject(p.id);
  for (const ch of saved.chapters.slice(0,2)) {
    assert.equal(ch.content,'这是生成的正文。'); assert.equal(ch.review_score,null);
    assert.equal(ch.summary,'主角找到钥匙'); assert.equal(ch.context_stale,0);
  }
  assert.equal(saved.memories.length,1);
  models.reviewEnabled = true;
  await run([p.chapters[2].id]);
  assert.equal(db.getChapter(p.chapters[2].id).review_score,92);
  assert.deepEqual(calls,['writer','reviewer','writer','reviewer','writer','reviewer']);
  models.reviewEnabled = false;
  const rewrites = new RewriteService(db,models);
  const job = rewrites.start(p.chapters[0].id,'改善描写');
  const deadline = Date.now()+3000;
  while(db.getRewriteJob(job.id).status==='running' && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  const result = db.getRewriteJob(job.id);
  assert.equal(result.status,'completed'); assert.equal(result.score,null);
  assert.match(result.message,/故事资料/);
  assert.deepEqual(calls,['writer','reviewer','writer','reviewer','writer','reviewer','writer','reviewer']);
});
