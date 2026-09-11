import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, watchFile } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NovelDatabase } from './src/database.mjs';
import { ModelRouter } from './src/ai.mjs';
import { WritingEngine } from './src/writing-engine.mjs';
import { SimilarityService } from './src/similarity-service.mjs';
import { RewriteService } from './src/rewrite-service.mjs';
import { chapterContext } from './src/chapter-context.mjs';
import { readEnvFile, workspaceId, servicePort } from './src/runtime-config.mjs';
import { StudioSettings } from './src/studio-settings.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const envFile = join(root, '.env');
const runtimeEnv = () => ({...readEnvFile(envFile), ...process.env});
const initialEnv = runtimeEnv();
const db = new NovelDatabase(initialEnv.NOVEL_DB_PATH || join(root, 'data', 'novels.db'));
db.seed();
const settings = new StudioSettings(initialEnv.NOVEL_SETTINGS_PATH || join(dirname(initialEnv.NOVEL_DB_PATH || join(root, 'data', 'novels.db')), 'model-settings.json'), runtimeEnv);
const models = new ModelRouter(settings.effectiveEnv(), {onEvent:event => db.addModelEvent(event)});
const engine = new WritingEngine(db, models);
const similarity = new SimilarityService(db, models);
const rewrites = new RewriteService(db, models);
for (const run of db.runningRuns()) engine.resume(run.id);
const port = servicePort(initialEnv);
watchFile(envFile, {interval:1000}, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) return;
  const profiles = models.reload(settings.effectiveEnv());
  console.log(`模型配置已自动重新加载：${profiles.filter(item => item.enabled).length}/${profiles.length} 个任务模型可用`);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    serveStatic(res, url.pathname);
  } catch (error) {
    json(res, 500, { error:error.message || '服务器发生错误' });
  }
});

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/api/settings') {
    if (method === 'GET') return json(res, 200, settings.describe());
    if (method === 'PUT') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, {error:'请从本机工作台保存设置'});
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, {error:'设置需以 JSON 提交'});
      try {
        const result = settings.save(await body(req));
        models.reload(settings.effectiveEnv());
        return json(res, 200, result);
      } catch (error) { return json(res, 400, {error:error.message}); }
    }
  }
  if (method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, db.dashboard());
  if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok:true, app:'inkflow',workspaceId:workspaceId(root),aiEnabled:models.enabled,reviewEnabled:models.reviewEnabled, models:models.describe() });
  if (method === 'POST' && url.pathname === '/api/models/test') return json(res, 200, {results:await models.testConnections()});
  if (method === 'GET' && url.pathname === '/api/projects') return json(res, 200, db.listProjects());
  if (method === 'POST' && url.pathname === '/api/projects') return json(res, 201, db.createProject(await body(req)));

  if (parts[1] === 'projects' && parts[2]) {
    const id = parts[2];
    if (method === 'GET' && parts.length === 3) {
      const project = db.getProject(id);
      return project ? json(res, 200, project) : json(res, 404, { error:'作品不存在' });
    }
    if (method === 'PATCH' && parts.length === 3) return json(res, 200, db.updateProject(id, await body(req)));
    if (method === 'DELETE' && parts.length === 3) {
      engine.stopProject?.(id);
      return db.deleteProject(id) ? json(res, 200, {ok:true}) : json(res, 404, {error:'作品不存在'});
    }
    if (method === 'GET' && parts[3] === 'model-events') return json(res, 200, db.listModelEvents(id, url.searchParams.get('limit')));
    if (method === 'GET' && parts[3] === 'model-events') return json(res, 200, db.listModelEvents(id, url.searchParams.get('limit')));
    if (method === 'POST' && parts[3] === 'plan') return json(res, 200, await engine.createPlan(id));
    if (method === 'POST' && parts[3] === 'extend-plan') return json(res, 200, await engine.extendPlan(id, await body(req)));
    if (method === 'POST' && parts[3] === 'run') {
      const input = await body(req);
      return json(res, 202, engine.start(id, input));
    }
    if (method === 'GET' && parts[3] === 'export') return exportText(res, db.getProject(id));
  }

  if (parts[1] === 'chapters' && parts[2]) {
    if (method === 'POST' && parts[3] === 'review') return json(res, 202, engine.startReview(parts[2]));
    if (method === 'GET' && parts[3] === 'context') {
      const chapter = db.getChapter(parts[2]);
      return chapter ? json(res, 200, chapterContext(db.getProject(chapter.project_id),chapter)) : json(res,404,{error:'章节不存在'});
    }
    if (method === 'GET' && parts.length === 3) {
      const chapter = db.getChapter(parts[2]);
      return chapter ? json(res, 200, chapter) : json(res, 404, { error:'章节不存在' });
    }
    if (method === 'PATCH' && parts.length === 3) return json(res, 200, db.saveChapter(parts[2], await body(req)));
    if (method === 'POST' && parts[3] === 'similarity-check') return json(res, 202, similarity.start(parts[2]));
    if (method === 'GET' && parts[3] === 'similarity-check') return json(res, 200, db.latestSimilarityCheck(parts[2]));
    if (method === 'POST' && parts[3] === 'rewrite') {
      const input = await body(req);
      return json(res, 202, rewrites.start(parts[2], input.instruction));
    }
    if (method === 'GET' && parts[3] === 'rewrite') return json(res, 200, db.latestRewriteJob(parts[2]));
  }

  if (parts[1] === 'similarity-checks' && parts[2] && method === 'GET') {
    const check = db.getSimilarityCheck(parts[2]);
    return check ? json(res, 200, check) : json(res, 404, {error:'查重任务不存在'});
  }
  if (parts[1] === 'memories' && parts[2] && method === 'PATCH') {
    const memory=db.updateMemory(parts[2],await body(req));
    return memory ? json(res,200,memory) : json(res,404,{error:'故事记忆不存在'});
  }
  if (parts[1] === 'rewrites' && parts[2]) {
    if (method === 'GET') {
      const job = db.getRewriteJob(parts[2]);
      return job ? json(res, 200, job) : json(res, 404, {error:'重写任务不存在'});
    }
    if (method === 'POST' && parts[3] === 'apply') return json(res, 200, db.applyRewriteJob(parts[2]));
    if (method === 'POST' && parts[3] === 'discard') return json(res, 200, db.discardRewriteJob(parts[2]));
    if (method === 'POST' && parts[3] === 'review') return json(res, 200, await rewrites.retryReview(parts[2]));
  }

  if (parts[1] === 'runs' && parts[2]) {
    if (method === 'GET') {
      const run = db.getRun(parts[2]);
      return run ? json(res, 200, run) : json(res, 404, { error:'任务不存在' });
    }
    if (method === 'POST' && parts[3] === 'stop') return json(res, 200, engine.stop(parts[2]));
    if (method === 'POST' && parts[3] === 'resume') {
      const run = engine.resume(parts[2]);
      return run ? json(res, 202, db.getRun(parts[2])) : json(res, 409, {error:'当前任务无法继续'});
    }
  }
  return json(res, 404, { error:'接口不存在' });
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = join(root, 'public', relative);
  if (!file.startsWith(join(root, 'public')) || !existsSync(file) || statSync(file).isDirectory()) {
    return sendFile(res, join(root, 'public', 'index.html'));
  }
  sendFile(res, file);
}

function sendFile(res, file) {
  const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
  res.writeHead(200, { 'Content-Type':types[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache' });
  createReadStream(file).pipe(res);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求内容不是有效的 JSON'); }
}

function exportText(res, project) {
  if (!project) return json(res, 404, { error:'作品不存在' });
  const complete = project.chapters.filter(ch => ch.status === 'completed');
  const text = [`《${project.title}》`, '', project.outline, '', ...complete.flatMap(ch => [`第${ch.number}章 ${ch.title}`, '', ch.content, ''])].join('\n');
  const name = encodeURIComponent(`${project.title}.txt`);
  res.writeHead(200, {
    'Content-Type':'text/plain; charset=utf-8',
    'Content-Disposition':`attachment; filename*=UTF-8''${name}`
  });
  res.end(text);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`墨流 AI 小说工作台已启动：http://127.0.0.1:${port}`);
  const active = models.describe().filter(item => item.enabled);
  console.log(active.length ? `已连接 ${active.length} 个任务模型：${active.map(item => `${item.label}=${item.model}`).join('，')}` : '当前为演示模式；设置模型 API 后使用真实模型。');
});

process.on('SIGINT', () => { db.close(); server.close(() => process.exit(0)); });
