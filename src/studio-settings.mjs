import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { ModelRouter } from './ai.mjs';

export class StudioSettings {
  constructor(filename, env) {
    this.filename = filename;
    this.env = env;
    this.saved = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
  }
  effectiveEnv() {
    const env = {...this.env()};
    for (const [role, profile] of Object.entries(this.saved.profiles || {})) {
      const prefix = `AI_${role.toUpperCase()}_`;
      for (const [field, suffix] of Object.entries({model:'MODEL', baseUrl:'BASE_URL', protocol:'PROTOCOL', apiKey:'API_KEY', outputTokens:'MAX_OUTPUT_TOKENS', reasoningEffort:'REASONING_EFFORT'})) {
        if (profile[field] !== undefined) env[prefix + suffix] = profile[field];
      }
    }
    env.AI_REVIEW_ENABLED = String(this.saved.reviewEnabled ?? true);
    return env;
  }
  describe() {
    const router = new ModelRouter(this.effectiveEnv());
    return {reviewEnabled:router.reviewEnabled, profiles:router.describe().map(item => ({
      role:item.role, label:item.label, model:item.model, baseUrl:item.endpoint,
      protocol:item.protocol, outputTokens:router.for(item.role).maxOutputTokens,
      reasoningEffort:router.for(item.role).reasoningEffort || 'auto', hasApiKey:router.for(item.role).enabled
    }))};
  }
  save(input) {
    if (typeof input.reviewEnabled !== 'boolean' || !Array.isArray(input.profiles) || input.profiles.length !== 4) throw new Error('请填写完整的模型设置和审稿开关');
    const router = new ModelRouter(this.effectiveEnv());
    const profiles = {};
    for (const item of input.profiles) {
      if (!['planner','writer','reviewer','checker'].includes(item.role) || profiles[item.role]) throw new Error('模型角色设置无效');
      const model = String(item.model || '').trim(), baseUrl = String(item.baseUrl || '').trim();
      if (!model || /[\r\n]/.test(model)) throw new Error('请填写模型名称');
      let url;
      try { url = new URL(baseUrl); } catch { throw new Error('API 地址格式不正确'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址需为 HTTP(S) 地址，请将密钥填入密钥栏');
      if (!['chat','responses'].includes(item.protocol)) throw new Error('请选择接口协议');
      const outputTokens = Number(item.outputTokens);
      if (!Number.isInteger(outputTokens) || outputTokens < 256 || outputTokens > 32768) throw new Error('输出 Token 预算需在 256 到 32768 之间');
      const reasoningEffort = String(item.reasoningEffort ?? (router.for(item.role).reasoningEffort || 'auto')).trim().toLowerCase();
      if (!['auto','none','minimal','low','medium','high','xhigh','max'].includes(reasoningEffort)) throw new Error('推理模式设置无效');
      if ((/\/responses\/?$/i.test(baseUrl) && item.protocol !== 'responses') || (/\/chat\/completions\/?$/i.test(baseUrl) && item.protocol !== 'chat')) throw new Error('完整 API 路径与所选协议不一致');
      const apiKey = String(item.apiKey || '').trim();
      if (/[\r\n]/.test(apiKey)) throw new Error('密钥不能包含换行');
      profiles[item.role] = {model, baseUrl, protocol:item.protocol, outputTokens, reasoningEffort, apiKey:item.clearApiKey === true ? '' : (apiKey || router.for(item.role).apiKey || '')};
    }
    const next = {reviewEnabled:input.reviewEnabled, profiles};
    mkdirSync(dirname(this.filename), {recursive:true});
    writeFileSync(this.filename + '.tmp', JSON.stringify(next, null, 2), {mode:0o600});
    renameSync(this.filename + '.tmp', this.filename);
    this.saved = next;
    return this.describe();
  }
}
