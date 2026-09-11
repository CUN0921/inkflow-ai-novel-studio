import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClient, ModelRouter, parseJsonText } from '../src/ai.mjs';

test('JSON 解析可修复模型在字符串中返回的未转义控制字符', () => {
  const value = parseJsonText('```json\n{"summary":"第一行\n第二行\t补充","note":"含\u0001控制符"}\n```');
  assert.equal(value.summary, '第一行\n第二行\t补充');
  assert.equal(value.note, '含\u0001控制符');
});

test('JSON 控制字符修复不会掩盖结构错误', () => {
  assert.throws(() => parseJsonText('{"summary":"内容",}'));
});

test('模型路由支持三个任务使用不同地址、模型和协议', () => {
  const router = new ModelRouter({
    OPENAI_API_KEY:'default-key', OPENAI_MODEL:'default-model', OPENAI_BASE_URL:'https://default.example/v1',
    AI_PLANNER_MODEL:'plan-model',
    AI_WRITER_API_KEY:'writer-key', AI_WRITER_MODEL:'writer-model', AI_WRITER_BASE_URL:'https://writer.example/v1/responses',
    AI_REVIEWER_MODEL:'review-model', AI_REVIEWER_BASE_URL:'https://review.example/v1', AI_REVIEWER_PROTOCOL:'chat'
  });
  assert.equal(router.for('planner').model, 'plan-model');
  assert.equal(router.for('planner').endpoint, 'https://default.example/v1/responses');
  assert.equal(router.for('writer').endpoint, 'https://writer.example/v1/responses');
  assert.equal(router.for('reviewer').endpoint, 'https://review.example/v1/chat/completions');
  assert.equal(router.for('reviewer').protocol, 'chat');
});

test('Chat Completions 客户端发送对应格式并读取正文', async () => {
  let request;
  const client = new AIClient({apiKey:'key', model:'novel-model', baseUrl:'https://mock.example/v1', protocol:'chat', role:'正文', fetchImpl:async (url, options) => {
    request = {url, body:JSON.parse(options.body)};
    return {ok:true, json:async () => ({choices:[{message:{content:'生成正文'}}]})};
  }});
  const result = await client.generate({instructions:'规则', input:'开始'});
  assert.equal(request.url, 'https://mock.example/v1/chat/completions');
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(result.text, '生成正文');
});

test('Responses 客户端支持填写完整接口路径', async () => {
  let request;
  const client = new AIClient({apiKey:'key', model:'plan-model', baseUrl:'https://mock.example/custom/responses', protocol:'responses', role:'规划', fetchImpl:async (url, options) => {
    request = {url, body:JSON.parse(options.body)};
    return {ok:true, json:async () => ({output_text:'规划完成'})};
  }});
  const result = await client.generate({instructions:'规则', input:'开始'});
  assert.equal(request.url, 'https://mock.example/custom/responses');
  assert.equal(request.body.store, false);
  assert.equal(result.text, '规划完成');
});

test('完整接口路径可以自动识别协议', () => {
  const router = new ModelRouter({
    OPENAI_API_KEY:'key', OPENAI_BASE_URL:'https://mock.example/v1/chat/completions'
  });
  assert.equal(router.for('writer').protocol, 'chat');
  assert.equal(router.for('writer').endpoint, 'https://mock.example/v1/chat/completions');
});

test('Responses 客户端可以传递网页搜索工具', async () => {
  let body;
  const client = new AIClient({apiKey:'key', model:'search-model', baseUrl:'https://mock.example/v1', protocol:'responses', role:'查重', fetchImpl:async (_url, options) => {
    body = JSON.parse(options.body);
    return {ok:true, json:async () => ({output_text:'{"results":[]}'})};
  }});
  await client.generate({instructions:'搜索', input:'句段', tools:[{type:'web_search'}], toolChoice:{type:'web_search'}});
  assert.deepEqual(body.tools, [{type:'web_search'}]);
  assert.deepEqual(body.tool_choice, {type:'web_search'});
});

test('DeepSeek Responses 审稿默认关闭思考，避免推理耗尽输出预算', async () => {
  let body;
  const router = new ModelRouter({
    OPENAI_API_KEY:'key', OPENAI_MODEL:'deepseek-v4-flash', OPENAI_BASE_URL:'https://api.deepseek.com/responses'
  }, {fetchImpl:async (_url, options) => {
    body = JSON.parse(options.body);
    return {ok:true, json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"score":90}'}]}]})};
  }});
  assert.equal(router.for('reviewer').reasoningEffort,'none');
  await router.for('reviewer').generate({instructions:'审稿',input:'只返回 JSON'});
  assert.deepEqual(body.reasoning,{effort:'none'});
});

test('Responses 没有可见文本时会保留截断原因和用量', async () => {
  const events = [];
  const client = new AIClient({apiKey:'key',model:'review-model',baseUrl:'https://mock.example/v1',role:'审稿整理',emit:event=>events.push(event),fetchImpl:async()=>({ok:true,json:async()=>({
    status:'incomplete', incomplete_details:{reason:'max_output_tokens'}, output:[{type:'reasoning',content:[{type:'reasoning_text',text:'思考'}]}], usage:{input_tokens:20,output_tokens:6000,total_tokens:6020}
  })})});
  await assert.rejects(() => client.generate({instructions:'审稿',input:'只返回 JSON'}),/返回被截断（max_output_tokens）/);
  assert.deepEqual(events.at(-1).usage,{input_tokens:20,output_tokens:6000,total_tokens:6020});
});

test('Responses 文本块兼容 type=text 的服务商格式', async () => {
  const client = new AIClient({apiKey:'key',model:'review-model',baseUrl:'https://mock.example/v1',role:'审稿整理',fetchImpl:async()=>({ok:true,json:async()=>({output:[{type:'message',content:[{type:'text',text:'服务商文本'}]}]})})});
  const result = await client.generate({instructions:'规则',input:'开始'});
  assert.equal(result.text,'服务商文本');
});

test('运行期间可以重新加载模型配置', () => {
  const router = new ModelRouter({OPENAI_MODEL:'old-model'});
  assert.equal(router.for('writer').enabled, false);
  router.reload({OPENAI_API_KEY:'new-key', OPENAI_MODEL:'new-model', OPENAI_BASE_URL:'https://new.example/v1'});
  assert.equal(router.for('writer').enabled, true);
  assert.equal(router.for('writer').model, 'new-model');
  assert.equal(router.for('writer').endpoint, 'https://new.example/v1/responses');
});

test('模型调用会报告进行中、完成和返回信息事件', async () => {
  const events = [];
  const client = new AIClient({apiKey:'key',model:'writer-model',baseUrl:'https://mock.example/v1',role:'正文',emit:event=>events.push(event),fetchImpl:async()=>({ok:true,json:async()=>({output_text:'返回候选正文',usage:{input_tokens:12,output_tokens:8,total_tokens:20}})})});
  const result = await client.generate({instructions:'写作规则',input:'本章要求',meta:{task:'write',projectId:'p1',chapterId:'c1'}});
  assert.equal(result.text,'返回候选正文');
  assert.equal(events.length,2);
  assert.equal(events[0].status,'running');
  assert.equal(events[1].status,'completed');
  assert.equal(events[1].projectId,'p1');
  assert.equal(events[1].responseLength,6);
  assert.deepEqual(events[1].usage,{input_tokens:12,output_tokens:8,total_tokens:20});
});

test('模型调用失败也会报告错误事件', async () => {
  const events = [];
  const client = new AIClient({apiKey:'key',model:'writer-model',baseUrl:'https://mock.example/v1',role:'正文',emit:event=>events.push(event),fetchImpl:async()=>({ok:false,status:503,text:async()=> 'temporary'})});
  await assert.rejects(() => client.generate({instructions:'规则',input:'内容'}),/503/);
  assert.equal(events.at(-1).status,'failed');
  assert.match(events.at(-1).error,/503/);
});

test('正文请求可流式接收 Responses 文本并持续报告进度', async () => {
  const events=[]; let body;
  const stream = [
    'data: {"type":"response.output_text.delta","delta":"第一段"}',
    'data: {"type":"response.output_text.delta","delta":"第二段"}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}',
    'data: [DONE]'
  ].join('\n\n');
  const client=new AIClient({apiKey:'key',model:'writer',baseUrl:'https://mock.example/v1',role:'正文',emit:event=>events.push(event),
    fetchImpl:async(_url,options)=>{ body=JSON.parse(options.body); return new Response(stream,{headers:{'content-type':'text/event-stream'}}); }});
  const result=await client.generate({instructions:'写作',input:'正文',streamProgress:true});
  assert.equal(body.stream,true);
  assert.equal(result.text,'第一段第二段');
  assert.deepEqual(result.usage,{input_tokens:3,output_tokens:4,total_tokens:7});
  assert.ok(events.some(event=>event.status==='running' && event.responseText==='第一段第二段'));
  assert.equal(events.at(-1).status,'completed');
});
