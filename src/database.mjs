import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildChapterHandoff, chapterContext, contextFingerprint } from './chapter-context.mjs';

const now = () => new Date().toISOString();

export class NovelDatabase {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL DEFAULT '',
        premise TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT '',
        target_words INTEGER NOT NULL DEFAULT 300000, mode TEXT NOT NULL DEFAULT 'serial',
        status TEXT NOT NULL DEFAULT 'planning', outline TEXT NOT NULL DEFAULT '',
        world TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '[]', story_digest TEXT NOT NULL DEFAULT '',
        current_chapter INTEGER NOT NULL DEFAULT 0, short_config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS volumes (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned', UNIQUE(project_id, number)
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL, number INTEGER NOT NULL,
        title TEXT NOT NULL, outline TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '', opening_instructions TEXT NOT NULL DEFAULT '', handoff TEXT NOT NULL DEFAULT '{}',
        plan TEXT NOT NULL DEFAULT '{}', plan_result TEXT NOT NULL DEFAULT '{}', context_snapshot TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'planned',
        word_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        review_score INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, number)
      );
      CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_chapter INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, subject TEXT NOT NULL,
        fact TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', importance INTEGER NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS foreshadows (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        planted_chapter INTEGER NOT NULL DEFAULT 0, target_volume INTEGER,
        title TEXT NOT NULL, visible_clue TEXT NOT NULL DEFAULT '', truth TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planted', actual_chapter INTEGER,
        progress_note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_number INTEGER, severity TEXT NOT NULL, category TEXT NOT NULL,
        message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL, requested_chapters INTEGER NOT NULL, completed_chapters INTEGER NOT NULL DEFAULT 0,
        current_step TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}', active_chapter_id TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS similarity_checks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        status TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, risk TEXT NOT NULL DEFAULT 'pending',
        searched_segments INTEGER NOT NULL DEFAULT 0, result_count INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS similarity_matches (
        id TEXT PRIMARY KEY, check_id TEXT NOT NULL REFERENCES similarity_checks(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL DEFAULT 'web', title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
        similarity INTEGER NOT NULL DEFAULT 0, matched_text TEXT NOT NULL DEFAULT '', source_excerpt TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS rewrite_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        status TEXT NOT NULL, instruction TEXT NOT NULL DEFAULT '', original_version INTEGER NOT NULL,
        candidate_content TEXT NOT NULL DEFAULT '', candidate_summary TEXT NOT NULL DEFAULT '',
        candidate_memories TEXT NOT NULL DEFAULT '[]', candidate_characters TEXT NOT NULL DEFAULT '[]',
        candidate_foreshadows TEXT NOT NULL DEFAULT '[]', candidate_plan_result TEXT NOT NULL DEFAULT '{}',
        candidate_handoff TEXT NOT NULL DEFAULT '{}', score INTEGER, message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_events (
        id TEXT PRIMARY KEY, project_id TEXT, chapter_id TEXT, run_id TEXT, job_id TEXT,
        task TEXT NOT NULL DEFAULT 'unknown', role TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
        protocol TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
        request_preview TEXT NOT NULL DEFAULT '', request_text TEXT NOT NULL DEFAULT '', request_length INTEGER NOT NULL DEFAULT 0, output_budget INTEGER NOT NULL DEFAULT 0,
        response_text TEXT NOT NULL DEFAULT '',
        response_preview TEXT NOT NULL DEFAULT '', response_length INTEGER NOT NULL DEFAULT 0,
        usage TEXT NOT NULL DEFAULT '{}', duration_ms INTEGER, error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const additions = {
      projects:{story_digest:"TEXT NOT NULL DEFAULT ''",short_config:"TEXT NOT NULL DEFAULT '{}'"},
      chapters:{writing_instructions:"TEXT NOT NULL DEFAULT ''",target_words:'INTEGER NOT NULL DEFAULT 3000',opening_instructions:"TEXT NOT NULL DEFAULT ''",handoff:"TEXT NOT NULL DEFAULT '{}'",plan:"TEXT NOT NULL DEFAULT '{}'",plan_result:"TEXT NOT NULL DEFAULT '{}'",context_snapshot:"TEXT NOT NULL DEFAULT '{}'",revision:'INTEGER NOT NULL DEFAULT 1',context_stale:'INTEGER NOT NULL DEFAULT 0'},
      runs:{chapter_ids:"TEXT NOT NULL DEFAULT '[]'",task_type:"TEXT NOT NULL DEFAULT 'write'",options:"TEXT NOT NULL DEFAULT '{}'",active_chapter_id:'TEXT'},
      memories:{source_version:'INTEGER',importance:'INTEGER NOT NULL DEFAULT 1',pinned:'INTEGER NOT NULL DEFAULT 0',updated_at:"TEXT NOT NULL DEFAULT ''"},
      foreshadows:{actual_chapter:'INTEGER',progress_note:"TEXT NOT NULL DEFAULT ''"},
      rewrite_jobs:{context_snapshot:"TEXT NOT NULL DEFAULT '{}'",original_revision:'INTEGER',candidate_handoff:"TEXT NOT NULL DEFAULT '{}'",candidate_characters:"TEXT NOT NULL DEFAULT '[]'",candidate_foreshadows:"TEXT NOT NULL DEFAULT '[]'",candidate_plan_result:"TEXT NOT NULL DEFAULT '{}'"},
      model_events:{request_text:"TEXT NOT NULL DEFAULT ''",request_length:'INTEGER NOT NULL DEFAULT 0',output_budget:'INTEGER NOT NULL DEFAULT 0'}
    };
    for (const [table, fields] of Object.entries(additions)) {
      const existing = new Set(this.all(`PRAGMA table_info(${table})`).map(field => field.name));
      for (const [name, definition] of Object.entries(fields)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    this.run("UPDATE chapters SET context_stale=1 WHERE TRIM(content)<>'' AND TRIM(COALESCE(handoff,'')) IN ('','{}','null')");
  }

  close() { this.db.close(); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  seed() {
    if (this.get('SELECT COUNT(*) AS n FROM projects').n) return;
    const project = this.createProject({
      title: '雾港来信', genre: '悬疑奇幻', premise: '失忆的灯塔守望人收到来自十年后的信，必须在海雾吞没港城前找出写信的人。',
      tone: '克制、潮湿、充满悬念；第三人称限知', targetWords: 320000, mode: 'serial'
    });
    this.planDemo(project.id);
  }

  createProject(input) {
    const id = randomUUID(), stamp = now();
    const mode = input.mode === 'short' ? 'short' : 'serial';
    const targetWords = Number(input.targetWords) || (mode === 'short' ? 15000 : 300000);
    if (!Number.isInteger(targetWords) || targetWords < (mode === 'short' ? 6000 : 10000) || targetWords > (mode === 'short' ? 80000 : 3000000)) {
      throw new Error(mode === 'short' ? '短故事目标字数需在 6000 到 80000 之间' : '长篇目标字数需在 10000 到 3000000 之间');
    }
    const shortConfig = normalizeShortConfig({...(input.shortConfig || {}),perspective:input.perspective || input.shortConfig?.perspective});
    this.run(`INSERT INTO projects(id,title,genre,premise,tone,target_words,mode,status,short_config,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, input.title?.trim() || '未命名作品', input.genre || '', input.premise || '',
      input.tone || '', targetWords, mode, 'planning', JSON.stringify(shortConfig), stamp, stamp);
    return this.getProject(id);
  }

  listProjects() {
    return this.all(`SELECT p.*, COALESCE(SUM(c.word_count),0) AS written_words,
      COUNT(CASE WHEN c.status='completed' THEN 1 END) AS completed_count
      FROM projects p LEFT JOIN chapters c ON c.project_id=p.id GROUP BY p.id ORDER BY p.updated_at DESC`);
  }

  getProject(id) {
    const project = this.get('SELECT * FROM projects WHERE id=?', id);
    if (!project) return null;
    project.characters = JSON.parse(project.characters || '[]');
    try { project.short_config = normalizeShortConfig(JSON.parse(project.short_config || '{}')); }
    catch { project.short_config = normalizeShortConfig(); }
    project.volumes = this.all('SELECT * FROM volumes WHERE project_id=? ORDER BY number', id);
    project.chapters = this.all('SELECT * FROM chapters WHERE project_id=? ORDER BY number', id).map(chapter => this.hydrateChapter(chapter));
    project.memories = this.all('SELECT * FROM memories WHERE project_id=? ORDER BY source_chapter DESC, created_at DESC', id);
    project.foreshadows = this.all('SELECT * FROM foreshadows WHERE project_id=? ORDER BY planted_chapter', id);
    project.issues = this.all('SELECT * FROM issues WHERE project_id=? ORDER BY created_at DESC LIMIT 50', id);
    const latest = this.get('SELECT id FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 1', id);
    project.latest_run = latest ? this.getRun(latest.id) : null;
    project.written_words = project.chapters.reduce((sum, ch) => sum + ch.word_count, 0);
    return project;
  }

  updateProject(id, input) {
    const allowed = { title:'title', genre:'genre', premise:'premise', tone:'tone', targetWords:'target_words', mode:'mode', shortConfig:'short_config', outline:'outline', world:'world', characters:'characters', status:'status' };
    const entries = Object.entries(input).filter(([key]) => allowed[key]);
    if (!entries.length) return this.getProject(id);
    const fields = entries.map(([key]) => `${allowed[key]}=?`);
    const values = entries.map(([key,value]) => key === 'characters' ? JSON.stringify(value) : key === 'shortConfig' ? JSON.stringify(normalizeShortConfig(value)) : value);
    this.run(`UPDATE projects SET ${fields.join(',')}, updated_at=? WHERE id=?`, ...values, now(), id);
    return this.getProject(id);
  }

  deleteProject(id) {
    const project = this.get('SELECT id FROM projects WHERE id=?', id);
    if (!project) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // model_events intentionally has no foreign key so it can record failed
      // calls; remove those records explicitly with the rest of the work.
      this.run('DELETE FROM model_events WHERE project_id=?', id);
      this.run('DELETE FROM projects WHERE id=?', id);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  replacePlan(projectId, plan) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.run('DELETE FROM volumes WHERE project_id=?', projectId);
      this.run('DELETE FROM chapters WHERE project_id=?', projectId);
      this.run('DELETE FROM foreshadows WHERE project_id=?', projectId);
      for (const volume of plan.volumes) {
        const volumeId = randomUUID();
        this.run('INSERT INTO volumes(id,project_id,number,title,goal,status) VALUES(?,?,?,?,?,?)', volumeId, projectId, volume.number, volume.title, volume.goal, 'planned');
        for (const chapter of volume.chapters || []) {
          const stamp = now();
          this.run(`INSERT INTO chapters(id,project_id,volume_id,number,title,outline,plan,target_words,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), projectId, volumeId, chapter.number, chapter.title, chapter.outline, JSON.stringify(normalizeChapterPlan(chapter.plan)), Number(chapter.targetWords) || 3000, 'planned', stamp, stamp);
        }
      }
      for (const item of plan.foreshadows || []) {
        this.run(`INSERT INTO foreshadows(id,project_id,planted_chapter,target_volume,title,visible_clue,truth,status,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`, randomUUID(), projectId, item.plantedChapter || 0, item.targetVolume || null,
          item.title, item.visibleClue || '', item.truth || '', 'planned', now());
      }
      const current = this.get('SELECT short_config FROM projects WHERE id=?',projectId);
      const shortConfig = plan.shortConfig ? normalizeShortConfig(plan.shortConfig) : normalizeShortConfig(JSON.parse(current?.short_config || '{}'));
      this.run(`UPDATE projects SET outline=?,world=?,characters=?,short_config=?,status='ready',updated_at=? WHERE id=?`,
        plan.outline, plan.world, JSON.stringify((plan.characters || []).map(item => ({...item,firstChapter:item.firstChapter ?? 0,importance:item.importance || 'major',status:'active'}))), JSON.stringify(shortConfig), now(), projectId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getProject(projectId);
  }

  planDemo(projectId) {
    const project = this.get('SELECT * FROM projects WHERE id=?', projectId);
    if (project?.mode === 'short') return this.replacePlan(projectId, mockShortPlanFor({...project,short_config:normalizeShortConfig(JSON.parse(project.short_config || '{}'))}));
    const isSample = project?.title === '雾港来信';
    if (!isSample) return this.replacePlan(projectId, mockPlanFor(project));
    return this.replacePlan(projectId, {
      outline: '顾临舟在被海雾封锁的岚津港追查未来来信。每封信都救下一人，也让港城更接近十年前被掩盖的沉船真相。最终他必须在保住自己的过去与拯救整座港城之间选择。',
      world: '岚津是一座依靠雾灯航行的封闭港城。每逢黑潮，雾会抹去人在其中经历的一小段记忆。港务议会垄断雾灯燃料，并禁止讨论十年前的白鲸号沉船。',
      characters: [
        { name:'顾临舟', role:'主角', desire:'找回失去的十年', conflict:'害怕自己正是灾难的制造者' },
        { name:'沈栖月', role:'潮汐报社记者', desire:'公开白鲸号真相', conflict:'父亲是当年的港务议员' },
        { name:'阿策', role:'码头少年', desire:'找到失踪的姐姐', conflict:'能记住海雾中发生的一切' }
      ],
      volumes: [
        { number:1, title:'逆潮的信', goal:'确认未来来信真实，并发现白鲸号沉船与黑潮有关', chapters:[
          {number:1,title:'灯塔下的第十三封信',outline:'顾临舟在没有寄件人的信中读到一场尚未发生的码头事故。'},
          {number:2,title:'退潮后的名字',outline:'预言成真；获救者却声称十年前见过顾临舟。'},
          {number:3,title:'报社的旧底片',outline:'沈栖月展示白鲸号沉船底片，照片里出现了未曾变老的顾临舟。'},
          {number:4,title:'无人值守的雾灯',outline:'灯塔在顾临舟离开时自行点亮，港城出现第一次逆向潮汐。'},
          {number:5,title:'记得雾的人',outline:'阿策说出雾中被所有人遗忘的细节，并要求交换姐姐的线索。'},
          {number:6,title:'黑潮前夜',outline:'三人潜入港务档案室，找到被撕走的值班日志。'},
          {number:7,title:'白鲸号幸存者',outline:'唯一幸存者指认顾临舟曾下令熄灭航标。'},
          {number:8,title:'来自明日的警告',outline:'新信件要求顾临舟亲手烧毁证据，否则沈栖月会死。'},
          {number:9,title:'两种真相',outline:'顾临舟设局保住证据，却发现沈栖月隐瞒了信件来源。'},
          {number:10,title:'雾中鸣笛',outline:'沉没十年的白鲸号在黑潮中再次鸣笛，第一卷危机爆发。'}
        ]},
        { number:2, title:'沉船归航', goal:'登上重现的白鲸号，查清记忆循环的来源', chapters:[] },
        { number:3, title:'无雾之城', goal:'打破港务议会的控制，并完成主角对过去的选择', chapters:[] }
      ],
      foreshadows: [
        {title:'第十三封信',plantedChapter:1,targetVolume:3,visibleClue:'信纸带有灯塔地下室的盐渍',truth:'写信人使用的是被黑潮折叠的时间'},
        {title:'阿策的完整记忆',plantedChapter:5,targetVolume:2,visibleClue:'他不受海雾遗忘影响',truth:'姐姐将一枚雾灯核心植入了他的身体'}
      ]
    });
  }

  hydrateChapter(chapter) {
    if (!chapter) return chapter;
    try { chapter.handoff = JSON.parse(chapter.handoff || '{}'); }
    catch { chapter.handoff = {}; }
    try { chapter.plan = normalizeChapterPlan(JSON.parse(chapter.plan || '{}')); }
    catch { chapter.plan = {}; }
    try { chapter.plan_result = JSON.parse(chapter.plan_result || '{}'); }
    catch { chapter.plan_result = {}; }
    try { chapter.context_snapshot = JSON.parse(chapter.context_snapshot || '{}'); }
    catch { chapter.context_snapshot = {}; }
    return chapter;
  }

  getChapter(id) { return this.hydrateChapter(this.get('SELECT * FROM chapters WHERE id=?', id)); }

  appendChapters(projectId, volumeNumber, chapters) {
    const volume = this.get('SELECT * FROM volumes WHERE project_id=? AND number=?', projectId, volumeNumber);
    if (!volume) throw new Error('目标分卷不存在');
    const stamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const chapter of chapters) {
        this.run(`INSERT INTO chapters(id,project_id,volume_id,number,title,outline,plan,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, randomUUID(), projectId, volume.id, chapter.number, chapter.title, chapter.outline, JSON.stringify(normalizeChapterPlan(chapter.plan)), 'planned', stamp, stamp);
      }
      this.run('UPDATE projects SET updated_at=? WHERE id=?', stamp, projectId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getProject(projectId);
  }

  saveChapter(id, input) {
    const chapter = this.getChapter(id);
    if (!chapter) return null;
    if (input.expectedRevision !== undefined && input.expectedRevision !== chapter.revision) throw new Error('章节已被修改，请刷新后重试');
    const targetWords = input.targetWords === undefined ? chapter.target_words : Number(input.targetWords);
    const project = this.get('SELECT mode FROM projects WHERE id=?',chapter.project_id);
    const minWords = project?.mode === 'short' ? 6000 : 500;
    const maxWords = project?.mode === 'short' ? 80000 : 6000;
    if (!Number.isInteger(targetWords) || targetWords < minWords || targetWords > maxWords) throw new Error(project?.mode === 'short' ? '短故事目标字数需在 6000 到 80000 之间' : '单章目标字数需在 500 到 6000 之间');
    const normalizedPlan = input.plan === undefined ? chapter.plan : normalizeChapterPlan(input.plan);
    const changed = ['title','outline','content'].some(key => input[key] !== undefined && input[key] !== chapter[key])
      || (input.plan !== undefined && JSON.stringify(normalizedPlan) !== JSON.stringify(chapter.plan || {}))
      || (input.writingInstructions !== undefined && input.writingInstructions !== chapter.writing_instructions)
      || (input.openingInstructions !== undefined && input.openingInstructions !== chapter.opening_instructions)
      || targetWords !== chapter.target_words;
    if (chapter.content && input.content !== undefined && input.content !== chapter.content) {
      this.run('INSERT INTO chapter_versions(id,chapter_id,version,content,created_at) VALUES(?,?,?,?,?)', randomUUID(), id, chapter.version, chapter.content, now());
    }
    const content = input.content ?? chapter.content;
    const contentChanged = Boolean(chapter.content && input.content !== undefined && input.content !== chapter.content);
    const words = countWords(content);
    const handoff = input.handoff !== undefined ? JSON.stringify(input.handoff || {}) : (contentChanged ? '{}' : JSON.stringify(chapter.handoff || {}));
    const contextSnapshot = input.contextSnapshot === undefined ? chapter.context_snapshot : input.contextSnapshot;
    this.run(`UPDATE chapters SET title=?,outline=?,content=?,summary=?,opening_instructions=?,handoff=?,plan=?,plan_result=?,context_snapshot=?,status=?,word_count=?,version=?,review_score=?,writing_instructions=?,target_words=?,revision=?,context_stale=?,updated_at=? WHERE id=?`,
      input.title ?? chapter.title, input.outline ?? chapter.outline, content, input.summary ?? (contentChanged ? '' : chapter.summary),
      input.openingInstructions ?? chapter.opening_instructions, handoff, JSON.stringify(normalizedPlan), JSON.stringify(input.planResult ?? (contentChanged ? {} : chapter.plan_result || {})), JSON.stringify(contextSnapshot || {}), input.status ?? chapter.status, words, chapter.version + (content !== chapter.content ? 1 : 0),
      input.reviewScore !== undefined ? input.reviewScore : (contentChanged ? null : chapter.review_score),
      input.writingInstructions ?? chapter.writing_instructions, targetWords, chapter.revision + (changed ? 1 : 0),
      input.contextStale ?? (contentChanged ? 1 : chapter.context_stale), now(), id);
    this.run('UPDATE projects SET updated_at=? WHERE id=?', now(), chapter.project_id);
    if (content !== chapter.content) {
      this.run("UPDATE memories SET status='needs_review' WHERE project_id=? AND source_chapter>=?", chapter.project_id, chapter.number);
      this.run("UPDATE chapters SET context_stale=1,handoff='{}' WHERE project_id=? AND number>?", chapter.project_id, chapter.number);
      const project = this.get('SELECT characters FROM projects WHERE id=?', chapter.project_id);
      if (project) {
        const characters = JSON.parse(project.characters || '[]').map(character => Number(character.firstChapter || 0) >= chapter.number
          ? {...character,status:'needs_review'} : character);
        this.run('UPDATE projects SET characters=? WHERE id=?', JSON.stringify(characters), chapter.project_id);
      }
      const later = this.get("SELECT COUNT(*) AS n FROM chapters WHERE project_id=? AND number>? AND status='completed'", chapter.project_id, chapter.number).n;
      if (later) this.addIssue(chapter.project_id, {
        chapterNumber:chapter.number, severity:'critical', category:'影响检查',
        message:`第${chapter.number}章正文已修改，${later}个后续章节需要重新检查人物状态、时间线和伏笔。`
      });
    }
    return this.getChapter(id);
  }

  addMemory(projectId, memory) {
    const source = this.get('SELECT version FROM chapters WHERE project_id=? AND number=?', projectId, memory.sourceChapter || 0);
    const kind = memory.kind || 'event', subject = String(memory.subject || '故事').trim(), fact = String(memory.fact || '').trim();
    if (!fact) return null;
    const existing = this.get("SELECT id FROM memories WHERE project_id=? AND kind=? AND subject=? AND fact=? AND status='active'", projectId, kind, subject, fact);
    const stamp = now(), importance = Math.max(1, Math.min(5, Number(memory.importance) || 1));
    if (existing) {
      this.run("UPDATE memories SET status='active',importance=MAX(importance,?),updated_at=? WHERE id=?",
        importance, stamp, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.run('INSERT INTO memories(id,project_id,source_chapter,kind,subject,fact,status,importance,pinned,created_at,updated_at,source_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, memory.sourceChapter || 0, kind, subject, fact, 'active', importance, memory.pinned ? 1 : 0, stamp, stamp, source?.version ?? null);
    return id;
  }

  updateMemory(id,input={}) {
    const memory=this.get('SELECT * FROM memories WHERE id=?',id);
    if (!memory) return null;
    const pinned=input.pinned === undefined ? memory.pinned : (input.pinned ? 1 : 0);
    const status=['active','needs_review'].includes(input.status) ? input.status : memory.status;
    this.run('UPDATE memories SET pinned=?,status=?,updated_at=? WHERE id=?',pinned,status,now(),id);
    return this.get('SELECT * FROM memories WHERE id=?',id);
  }

  mergeCharacters(projectId, updates=[], sourceChapter=0) {
    if (!Array.isArray(updates) || !updates.length) return;
    const project = this.get('SELECT characters FROM projects WHERE id=?', projectId);
    const characters = JSON.parse(project?.characters || '[]');
    for (const raw of updates) {
      const name = String(raw?.name || '').trim();
      if (!name) continue;
      const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(String).filter(Boolean).slice(0,8) : [];
      const index = characters.findIndex(item => item.name === name || (item.aliases || []).includes(name) || aliases.includes(item.name));
      const previous = index >= 0 ? characters[index] : {};
      const next = {
        ...previous, name:previous.name || name,
        role:String(raw.role || previous.role || '剧情人物'),
        desire:String(raw.goal || raw.desire || previous.desire || ''),
        conflict:String(raw.conflict || previous.conflict || ''),
        aliases:[...new Set([...(previous.aliases || []),...aliases])],
        relationship:String(raw.relationship || previous.relationship || ''),
        location:String(raw.location || previous.location || ''),
        state:String(raw.state || previous.state || ''),
        importance:raw.importance === 'major' || previous.importance === 'major' ? 'major' : 'minor',
        firstChapter:index >= 0 && previous.firstChapter == null ? 0 : (Number(previous.firstChapter ?? sourceChapter) || 0),
        updatedChapter:sourceChapter,
        status:'active'
      };
      if (index >= 0) characters[index] = next; else characters.push(next);
    }
    this.run('UPDATE projects SET characters=?,updated_at=? WHERE id=?', JSON.stringify(characters), now(), projectId);
  }

  updateForeshadows(projectId, updates=[], sourceChapter=0) {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      const title = String(item?.title || '').trim();
      if (!title) continue;
      const existing = this.get('SELECT id,status FROM foreshadows WHERE project_id=? AND title=?', projectId, title);
      const status = ['planned','planted','advanced','resolved'].includes(item.status) ? item.status : (existing?.status || 'planted');
      if (existing) {
        this.run('UPDATE foreshadows SET status=?,actual_chapter=COALESCE(actual_chapter,?),progress_note=?,updated_at=? WHERE id=?',
          status, sourceChapter || null, String(item.evidence || ''), now(), existing.id);
      } else {
        this.run('INSERT INTO foreshadows(id,project_id,planted_chapter,title,visible_clue,truth,status,actual_chapter,progress_note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          randomUUID(), projectId, sourceChapter, title, String(item.evidence || ''), '', status, sourceChapter || null, String(item.evidence || ''), now());
      }
    }
  }

  addIssue(projectId, issue) {
    this.run('INSERT INTO issues(id,project_id,chapter_number,severity,category,message,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      randomUUID(), projectId, issue.chapterNumber || null, issue.severity || 'notice', issue.category || 'continuity', issue.message, 'open', now());
  }

  createRun(projectId, requested, chapterIds=[], taskType='write', options={}) {
    const id = randomUUID(), stamp = now();
    this.run('INSERT INTO runs(id,project_id,status,requested_chapters,current_step,message,started_at,updated_at,chapter_ids,task_type,options) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, 'running', requested, 'preparing', taskType === 'review' ? '正在准备待整理正文' : '正在准备所选章节的故事资料', stamp, stamp, JSON.stringify(chapterIds), taskType, JSON.stringify(options || {}));
    return this.getRun(id);
  }

  getRun(id) {
    const run = this.get('SELECT * FROM runs WHERE id=?', id);
    if (run) { run.chapter_ids = JSON.parse(run.chapter_ids || '[]'); run.options = JSON.parse(run.options || '{}'); }
    return run;
  }
  runningRuns() { return this.all("SELECT * FROM runs WHERE status='running' ORDER BY started_at"); }
  updateRun(id, input) {
    const run = this.getRun(id);
    if (!run) return null;
    this.run('UPDATE runs SET status=?,completed_chapters=?,current_step=?,message=?,active_chapter_id=?,updated_at=? WHERE id=?',
      input.status ?? run.status, input.completedChapters ?? run.completed_chapters, input.currentStep ?? run.current_step, input.message ?? run.message,
      input.activeChapterId !== undefined ? input.activeChapterId : run.active_chapter_id, now(), id);
    return this.getRun(id);
  }

  createSimilarityCheck(chapter) {
    const id = randomUUID(), stamp = now();
    this.run(`INSERT INTO similarity_checks(id,project_id,chapter_id,status,message,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`, id, chapter.project_id, chapter.id, 'running', '正在提取有辨识度的句段', stamp, stamp);
    return this.getSimilarityCheck(id);
  }

  getSimilarityCheck(id) {
    const check = this.get('SELECT * FROM similarity_checks WHERE id=?', id);
    if (!check) return null;
    check.matches = this.all('SELECT * FROM similarity_matches WHERE check_id=? ORDER BY similarity DESC', id);
    return check;
  }

  latestSimilarityCheck(chapterId) {
    const check = this.get('SELECT id FROM similarity_checks WHERE chapter_id=? ORDER BY created_at DESC LIMIT 1', chapterId);
    return check ? this.getSimilarityCheck(check.id) : null;
  }

  updateSimilarityCheck(id, input) {
    const check = this.getSimilarityCheck(id);
    if (!check) return null;
    this.run(`UPDATE similarity_checks SET status=?,score=?,risk=?,searched_segments=?,result_count=?,message=?,updated_at=? WHERE id=?`,
      input.status ?? check.status, input.score ?? check.score, input.risk ?? check.risk,
      input.searchedSegments ?? check.searched_segments, input.resultCount ?? check.result_count,
      input.message ?? check.message, now(), id);
    return this.getSimilarityCheck(id);
  }

  addSimilarityMatch(checkId, match) {
    this.run(`INSERT INTO similarity_matches(id,check_id,source_type,title,url,similarity,matched_text,source_excerpt)
      VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), checkId, match.sourceType || 'web', match.title || '', match.url || '',
      Math.max(0, Math.min(100, Number(match.similarity) || 0)), match.matchedText || '', match.sourceExcerpt || '');
  }

  createRewriteJob(chapter, instruction, snapshot={}) {
    const id = randomUUID(), stamp = now();
    this.run(`INSERT INTO rewrite_jobs(id,project_id,chapter_id,status,instruction,original_version,message,created_at,updated_at,context_snapshot,original_revision,candidate_handoff)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, chapter.project_id, chapter.id, 'running', instruction || '', chapter.version,
      '正在整理本章的前后文和故事依据', stamp, stamp, JSON.stringify(snapshot), chapter.revision, '{}');
    return this.getRewriteJob(id);
  }

  getRewriteJob(id) {
    const job = this.get('SELECT * FROM rewrite_jobs WHERE id=?', id);
    if (!job) return null;
    job.candidate_memories = JSON.parse(job.candidate_memories || '[]');
    job.candidate_characters = JSON.parse(job.candidate_characters || '[]');
    job.candidate_foreshadows = JSON.parse(job.candidate_foreshadows || '[]');
    job.candidate_plan_result = JSON.parse(job.candidate_plan_result || '{}');
    job.context_snapshot = JSON.parse(job.context_snapshot || '{}');
    try { job.candidate_handoff = JSON.parse(job.candidate_handoff || '{}'); }
    catch { job.candidate_handoff = {}; }
    return job;
  }

  latestRewriteJob(chapterId) {
    const job = this.get('SELECT id FROM rewrite_jobs WHERE chapter_id=? ORDER BY created_at DESC LIMIT 1', chapterId);
    return job ? this.getRewriteJob(job.id) : null;
  }

  updateRewriteJob(id, input) {
    const job = this.getRewriteJob(id);
    if (!job) return null;
    this.run(`UPDATE rewrite_jobs SET status=?,candidate_content=?,candidate_summary=?,candidate_memories=?,candidate_characters=?,candidate_foreshadows=?,candidate_plan_result=?,candidate_handoff=?,score=?,message=?,updated_at=? WHERE id=?`,
      input.status ?? job.status, input.candidateContent ?? job.candidate_content,
      input.candidateSummary ?? job.candidate_summary,
      JSON.stringify(input.candidateMemories ?? job.candidate_memories), JSON.stringify(input.candidateCharacters ?? job.candidate_characters),
      JSON.stringify(input.candidateForeshadows ?? job.candidate_foreshadows), JSON.stringify(input.candidatePlanResult ?? job.candidate_plan_result),
      JSON.stringify(input.candidateHandoff ?? job.candidate_handoff ?? {}), input.score ?? job.score,
      input.message ?? job.message, now(), id);
    return this.getRewriteJob(id);
  }

  applyRewriteJob(id) {
    const job = this.getRewriteJob(id);
    if (!job || job.status !== 'completed') throw new Error('重写候选稿尚未完成或已经处理');
    const chapter = this.getChapter(job.chapter_id);
    if (!chapter) throw new Error('章节不存在');
    if (chapter.version !== job.original_version) throw new Error('原章节在候选稿生成后发生了修改，请重新生成候选稿');
    if (job.original_revision != null && chapter.revision !== job.original_revision) throw new Error('本章章纲或要求已修改，请按新要求重新生成候选稿');
    if (!job.candidate_content.trim()) throw new Error('候选稿没有正文');
    if (job.context_snapshot?.chapter && contextFingerprint(chapterContext(this.getProject(chapter.project_id), chapter)) !== contextFingerprint(job.context_snapshot)) {
      throw new Error('生成后故事依据发生了变化，请重新生成候选稿再采用');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const finalContent = job.candidate_content;
      const hasContext = Boolean((job.candidate_summary || '').trim());
      this.saveChapter(chapter.id, {
        content:finalContent, summary:hasContext ? job.candidate_summary : '',
        status:'completed', reviewScore:job.score, contextStale:hasContext ? 0 : 1, planResult:job.candidate_plan_result || {},
        handoff:hasContext ? buildChapterHandoff(job.candidate_handoff, {
          chapterNumber:chapter.number,
          sourceVersion:chapter.version + (finalContent !== chapter.content ? 1 : 0),
          content:finalContent,
          summary:job.candidate_summary
        }) : {}
      });
      this.run('DELETE FROM memories WHERE project_id=? AND source_chapter=?', chapter.project_id, chapter.number);
      for (const memory of hasContext ? job.candidate_memories : []) {
        this.addMemory(chapter.project_id, {...memory, sourceChapter:chapter.number});
      }
      if (hasContext) {
        this.mergeCharacters(chapter.project_id,job.candidate_characters,chapter.number);
        this.updateForeshadows(chapter.project_id,job.candidate_foreshadows,chapter.number);
      }
      this.run("UPDATE rewrite_jobs SET status='accepted',message='候选稿已采用并保存为新版本',updated_at=? WHERE id=?", now(), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getChapter(chapter.id);
  }

  discardRewriteJob(id) {
    const job = this.getRewriteJob(id);
    if (!job) return null;
    this.run("UPDATE rewrite_jobs SET status='discarded',message='候选稿已放弃，原文保持不变',updated_at=? WHERE id=?", now(), id);
    return this.getRewriteJob(id);
  }

  addModelEvent(input) {
    const id = input.id || randomUUID(), stamp = now();
    const response = String(input.responseText || '').slice(0, 20000);
    const preview = String(input.responsePreview || response.slice(0, 1200));
    const rawRequest = String(input.requestText || input.requestPreview || '');
    const request = String(input.requestPreview || rawRequest.slice(0, 1600)).slice(0, 1600);
    const requestText = rawRequest.slice(0, 20000);
    const requestLength = Number(input.requestLength ?? rawRequest.length) || 0;
    const usage = input.usage && typeof input.usage === 'object' ? JSON.stringify(input.usage) : (input.usage || '{}');
    this.run(`INSERT INTO model_events(id,project_id,chapter_id,run_id,job_id,task,role,model,protocol,status,message,request_preview,request_text,request_length,output_budget,response_text,response_preview,response_length,usage,duration_ms,error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,message=excluded.message,request_preview=excluded.request_preview,
        request_text=excluded.request_text,request_length=excluded.request_length,output_budget=excluded.output_budget,
        response_text=excluded.response_text,response_preview=excluded.response_preview,response_length=excluded.response_length,
        usage=excluded.usage,duration_ms=excluded.duration_ms,error=excluded.error,updated_at=excluded.updated_at`,
      id, input.projectId || null, input.chapterId || null, input.runId || null, input.jobId || null,
      input.task || 'unknown', input.role || '未知模型', input.model || '', input.protocol || '', input.status || 'running',
      input.message || '', request, requestText, requestLength, Number(input.outputBudget) || 0, response, preview, Number(input.responseLength ?? response.length) || 0,
      usage, input.durationMs == null ? null : Number(input.durationMs), input.error || '', input.createdAt || stamp, stamp);
    return this.getModelEvent(id);
  }

  getModelEvent(id) { return this.get('SELECT * FROM model_events WHERE id=?', id); }

  listModelEvents(projectId, limit=80) {
    return this.all('SELECT * FROM model_events WHERE project_id=? ORDER BY updated_at DESC LIMIT ?', projectId, Math.max(1, Math.min(200, Number(limit) || 80)));
  }

  dashboard() {
    const projects = this.listProjects();
    return {
      projects,
      totals: {
        projects: projects.length,
        words: projects.reduce((n,p) => n + Number(p.written_words), 0),
        chapters: projects.reduce((n,p) => n + Number(p.completed_count), 0),
        openIssues: Number(this.get("SELECT COUNT(*) AS n FROM issues WHERE status='open'").n)
      }
    };
  }
}

export function countWords(text='') {
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return chinese + latin;
}

function normalizeChapterPlan(value={}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = key => String(input[key] || '').trim();
  return {
    openingState:text('openingState'),
    cast:Array.isArray(input.cast) ? input.cast.map(String).map(item => item.trim()).filter(Boolean).slice(0,12) : [],
    goal:text('goal'),
    turn:text('turn'),
    mustHappen:text('mustHappen'),
    endingState:text('endingState')
  };
}

export function normalizeShortConfig(value={}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const perspective = ['first','third'].includes(input.perspective) ? input.perspective : 'first';
  const titleOptions = Array.isArray(input.titleOptions) ? input.titleOptions.map(String).map(item=>item.trim()).filter(Boolean).slice(0,6) : [];
  const reversals = Array.isArray(input.reversals) ? input.reversals.map(String).map(item=>item.trim()).filter(Boolean).slice(0,6) : [];
  return {
    perspective,
    recommendedTitle:String(input.recommendedTitle || '').trim(),
    titleOptions,
    category:String(input.category || '').trim(),
    hook:String(input.hook || '').trim(),
    coreConflict:String(input.coreConflict || '').trim(),
    emotionalArc:String(input.emotionalArc || '').trim(),
    reversals,
    climax:String(input.climax || '').trim(),
    ending:String(input.ending || '').trim(),
    trialHook:String(input.trialHook || '').trim()
  };
}

function mockShortPlanFor(project) {
  const title = project?.title || '未命名短故事';
  const premise = project?.premise || '主人公必须在有限时间里完成一次无法回避的选择。';
  const genre = project?.genre || '现实情感';
  const perspective = project?.short_config?.perspective || 'first';
  const shortConfig = normalizeShortConfig({
    perspective,
    recommendedTitle:title,
    titleOptions:[title,`我在真相揭开前失去了最重要的人`,`那封信抵达后的第七天`],
    category:genre,
    hook:'开篇直接呈现异常事件和主人公即将失去的东西，在前三段建立核心悬念。',
    coreConflict:premise,
    emotionalArc:'从压抑和怀疑进入希望，再经背叛跌至低谷，最终用主动选择完成情绪释放。',
    reversals:['主人公信任的解释被关键证据推翻','看似帮助主人公的人其实隐瞒了真正目的','最终选择揭示主人公早已付出的代价'],
    climax:'核心秘密、人物关系和现实代价在同一场行动中爆发，主人公必须立即选择。',
    ending:'解决核心冲突并回应开篇意象，让人物选择产生清晰且不可逆的结果。',
    trialHook:'在第一次重大反转之后切断试读，让读者明确知道更大的秘密即将揭开。'
  });
  const outline = `《${title}》围绕“${premise}”展开。开篇立即抛出异常与损失，中段用连续升级的阻碍和三次有效反转改变读者判断，在高潮中迫使主人公完成不可撤回的选择，结尾回收核心悬念与情绪承诺。`;
  return {
    outline,
    world:`故事只保留推动“${genre}”核心冲突所需的背景规则。所有设定都必须通过行动显现，不使用大段说明。`,
    characters:[
      {name:'林默',role:'第一叙事者',desire:'阻止眼前的失去并弄清真相',conflict:'越接近真相，越需要承认自己的责任'},
      {name:'苏遥',role:'关键关系人物',desire:'迫使主人公面对被掩盖的选择',conflict:'既想保护主人公，又必须揭开会伤害双方的事实'},
      {name:'周先生',role:'对立力量',desire:'让秘密永远停留在过去',conflict:'他的阻止行为来自一项可以理解却不能接受的代价'}
    ],
    volumes:[{number:1,title:'完整故事',goal:'在一篇正文内完成悬念、反转、高潮与情绪闭环',chapters:[{
      number:1,title:'完整故事',targetWords:Number(project.target_words) || 15000,outline,
      plan:{openingState:'异常正在发生，主人公立即面临具体损失',cast:['林默','苏遥','周先生'],goal:'追查真相并阻止损失',turn:'关键证据推翻主人公对事件和关系的理解',mustHappen:'至少两次递进反转；高潮中完成不可撤回的选择',endingState:'核心冲突解决，开篇悬念与情绪承诺得到回收'}
    }]}],
    foreshadows:[],
    shortConfig
  };
}

function mockPlanFor(project) {
  const title = project?.title || '未命名作品';
  const premise = project?.premise || '主人公被卷入一场足以改变命运的事件。';
  const genre = project?.genre || '长篇小说';
  const beats = [
    ['异样的开端','一次反常事件打破主人公的日常，并留下无法忽视的线索。'],
    ['无法拒绝的邀请','主人公尝试回避，却因个人目标主动进入冲突。'],
    ['第一位同行者','关键人物登场，双方在互不信任中达成暂时合作。'],
    ['规则的代价','主人公第一次触碰世界的隐藏规则，并为此付出代价。'],
    ['错误的答案','看似合理的解释出现，却与一个细节发生矛盾。'],
    ['对手现身','对立力量公开行动，证明冲突远比想象中庞大。'],
    ['关系的裂缝','压力使同伴目标发生冲突，一项隐瞒被迫暴露。'],
    ['越界','主人公做出不可撤回的决定，跨过故事的第一道门槛。'],
    ['真相的一角','旧线索拼出局部真相，同时引出更危险的问题。'],
    ['第一次正面交锋','阶段冲突爆发，主人公赢得机会，却失去原有退路。']
  ];
  return {
    outline:`《${title}》围绕“${premise}”展开。主人公从被动卷入，到主动追寻真相，再到承担选择的后果；每一卷推进一层核心谜题，并让人物关系随冲突发生不可逆的改变。`,
    world:`这是一个服务于“${genre}”主题的故事世界。超常现象必须有边界和代价；信息传播、人物行动范围与时间经过都需要在正文中留下依据。`,
    characters:[
      {name:'林默',role:'主角',desire:'弄清事件真相并守住珍视的人',conflict:'越接近真相，越怀疑自己的记忆与判断'},
      {name:'苏遥',role:'关键同伴',desire:'借主人公的行动完成隐秘目标',conflict:'合作建立在一项尚未揭开的隐瞒上'},
      {name:'周先生',role:'主要对手',desire:'维持现有秩序',conflict:'他的手段冷酷，但理由并非全无道理'}
    ],
    volumes:[
      {number:1,title:'门被推开',goal:'建立规则与人物关系，让主人公主动进入核心冲突',chapters:beats.map((b,i)=>({number:i+1,title:b[0],outline:b[1]}))},
      {number:2,title:'代价浮现',goal:'扩大冲突，揭开第一层真相并改变主要人物关系',chapters:[]},
      {number:3,title:'无法回头',goal:'完成最终选择，回收核心伏笔并收束人物成长',chapters:[]}
    ],
    foreshadows:[
      {title:'被忽略的细节',plantedChapter:1,targetVolume:2,visibleClue:'开端事件中存在一个与常识不符的细节',truth:'这个细节指向冲突背后的真正规则'},
      {title:'同伴的隐瞒',plantedChapter:3,targetVolume:3,visibleClue:'同伴对某个名字表现出异常熟悉',truth:'同伴早已参与过相似事件'}
    ]
  };
}
