const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const source = require('./extension-fixture.cjs').readScript('service-worker.js');
const reactRuntime = [
  fs.readFileSync(path.join(__dirname, '../extension/src/vendor/react.production.min.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '../extension/src/vendor/react-dom.production.min.js'), 'utf8')
].join('\n');
const schemaVersion = 'quick-reply.v2';
const candidates = [{ id: 'c1', text: '请问几点方便？' }, { id: 'c2', text: '我们先确认一下时间。' }];
const decision = { schemaVersion, model: 'decision-model-preview', selectedId: 'c1', reviewRequired: false,
  confidence: 0.6, probabilities: { c1: 0.7, c2: 0.2, __none__: 0.1 } };

const senderFor = (url, extra = {}) => ({ id: 'extension-id', url, tab: { id: 17 }, frameId: 0, ...extra });
function runtime(responses, {tabUrl = 'https://x.com/messages/123', tabError, settings={}} = {}) {
  let listener;
  const calls = [];
  const context = { URL, AbortController, TextEncoder, setTimeout, clearTimeout,
    chrome: { runtime: { id: 'extension-id', onMessage: { addListener(fn) { listener = fn; } } },
      tabs: { async get(id) { assert.equal(id,17); if(tabError) throw new Error(tabError); return {id, url: typeof tabUrl === 'function' ? tabUrl() : tabUrl}; } },
      storage: { local: { async get() { return { candidateCount: 2, ...settings }; } } } },
    async fetch(url, options) {
      calls.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Unexpected network call');
      return { ok: response.ok !== false, status: response.status || 200, async json() { return response.body; } };
    }
  };
  vm.runInNewContext(source, context);
  const receive = (message,sender) => new Promise(resolve=>listener(message,sender,resolve));
  return { calls, receive, send(sender = senderFor('https://x.com/messages/123'), kind = 'direct-message') {
    return receive({ type: 'GENERATE_REPLIES', context: {
      kind, messages: [{ role: 'them', text: '明天几点聊？' }] } }, sender);
  } };
}

test('generation precedes real decision and uses gateway custom header', async () => {
  const app = runtime([{ body: { schemaVersion, candidates } }, { body: decision }]);
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.autoLikeAfterReply, false);
  assert.equal(result.oneClickReply, false);
  assert.equal(result.decision.selectedId, 'c1');
  assert.equal(result.decision.confidence, 0.6);
  assert.equal(app.calls.length, 2);
  assert.match(app.calls[0].url, /\/generate$/);
  assert.match(app.calls[1].url, /\/decide$/);
  assert.equal(app.calls[0].options.headers['X-Quick-Reply'], 'v1');
  assert.equal(app.calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(app.calls[1].options.body).candidates[0].id, 'c1');
});

test('one stored overall prompt reaches generation and decision unchanged',async()=>{
  const replyPrompt='轻松接梗，不装熟，不要每条都反问。';
  const replyExamples='这句我会直接回：先忙你的。';
  const app=runtime([{body:{schemaVersion,candidates}},{body:decision}],{settings:{replyPrompt,replyExamples}});
  const result=await app.send();
  assert.equal(result.ok,true,result.error);
  for(const call of app.calls){
    assert.equal(JSON.parse(call.options.body).replyPrompt,replyPrompt);
    assert.equal(JSON.parse(call.options.body).replyExamples,replyExamples);
  }
});

test('one-click setting is returned but never sent to the model request', async () => {
  const app = runtime([{body:{schemaVersion,candidates}},{body:decision}], {tabUrl:'https://x.com/compose/post', settings:{oneClickReply:true}});
  const result = await app.send(senderFor('https://x.com/compose/post'), 'public-reply');
  assert.equal(result.ok,true,result.error);
  assert.equal(result.oneClickReply,true);
  assert.equal(result.oneClickCountdownSeconds,10);
  assert.equal(JSON.parse(app.calls[0].options.body).oneClickReply,undefined);
  assert.equal(JSON.parse(app.calls[0].options.body).oneClickCountdownSeconds,undefined);
});

test('invalid one-click countdown stops before any model request', async () => {
  for (const oneClickCountdownSeconds of [2,61,2.5,'10',null]) {
    const app = runtime([], {settings:{oneClickCountdownSeconds}});
    const result = await app.send();
    assert.equal(result.ok,false); assert.match(result.error,/倒计时设置无效/); assert.equal(app.calls.length,0);
  }
});

test('invalid saved prompt stops before any model request',async()=>{
  for(const replyPrompt of ['',null,12,'字'.repeat(3001)]){
    const app=runtime([],{settings:{replyPrompt}});
    const result=await app.send();assert.equal(result.ok,false);assert.match(result.error,/整体回复提示词/);assert.equal(app.calls.length,0);
  }
});

test('old gateway schema stops before decision with an update instruction',async()=>{
  const app=runtime([{body:{schemaVersion:'quick-reply.v1',candidates}}]);
  const result=await app.send();assert.equal(result.ok,false);assert.match(result.error,/重启新版网关/);assert.equal(app.calls.length,1);
});

test('public reply composer reaches generation and decision with public context', async () => {
  const app = runtime([{ body: { schemaVersion, candidates } }, { body: decision }], {tabUrl:'https://x.com/compose/post'});
  const result = await app.send(senderFor('https://x.com/compose/post'), 'public-reply');
  assert.equal(result.ok, true);
  assert.equal(app.calls.length, 2);
  assert.equal(JSON.parse(app.calls[0].options.body).kind, 'public-reply');
  assert.equal(JSON.parse(app.calls[1].options.body).kind, 'public-reply');
  assert.equal(JSON.parse(app.calls[0].options.body).language, 'auto');
  assert.equal(JSON.parse(app.calls[1].options.body).language, 'auto');
});

test('a home document navigating to a reply modal is authorized using its current browser tab URL',async()=>{
  const app=runtime([{body:{schemaVersion,candidates}},{body:decision}],{tabUrl:'https://x.com/compose/post'});
  const result=await app.send(senderFor('https://x.com/home'),'public-reply');
  assert.equal(result.ok,true,result.error);assert.equal(app.calls.length,2);
});

test('a reply modal opened from the home feed is authorized while the tab stays on home',async()=>{
  const app=runtime([{body:{schemaVersion,candidates}},{body:decision}],{tabUrl:'https://x.com/home'});
  const result=await app.send(senderFor('https://x.com/home'),'public-reply');
  assert.equal(result.ok,true,result.error);assert.equal(app.calls.length,2);
});

test('a stale reply sender cannot authorize a tab that has navigated home',async()=>{
  const app=runtime([],{tabUrl:'https://x.com/home'});
  const result=await app.send(senderFor('https://x.com/compose/post'),'public-reply');
  assert.equal(result.ok,false);assert.equal(app.calls.length,0);
});

test('missing tabs, subframes and non-X document origins never reach the gateway',async()=>{
  for(const sender of [senderFor('https://x.com/compose/post',{tab:undefined}),senderFor('https://x.com/compose/post',{frameId:1}),senderFor('https://attacker.example/compose/post')]){
    const app=runtime([],{tabUrl:'https://x.com/compose/post'});
    const result=await app.send(sender,'public-reply');
    assert.equal(result.ok,false);assert.equal(app.calls.length,0);
  }
});

test('failure to inspect the current browser tab stops without requests or retries',async()=>{
  const app=runtime([],{tabError:'No tab with id: 17.'});
  const result=await app.send(senderFor('https://x.com/compose/post'),'public-reply');
  assert.equal(result.ok,false);assert.match(result.error,/No tab/);assert.equal(app.calls.length,0);
});

test('navigation during generation stops before decision rather than borrowing the old sender route',async()=>{
  let currentUrl='https://x.com/compose/post';
  const generated={get body(){currentUrl='https://x.com/home';return {schemaVersion,candidates};}};
  const app=runtime([generated],{tabUrl:()=>currentUrl});
  const result=await app.send(senderFor('https://x.com/compose/post'),'public-reply');
  assert.equal(result.ok,false);assert.match(result.error,/已切换/);assert.equal(app.calls.length,1);
});

test('actual page and background scripts generate and fill after a home-to-reply SPA navigation',async()=>{
  // Explicit browser/transport doubles; real scripts execute across both seams.
  const {JSDOM}=require('jsdom');
  const page=new JSDOM('<body></body>',{url:'https://x.com/home',runScripts:'outside-only',pretendToBeVisual:true});
  const w=page.window, documentSender=senderFor(w.location.href);
  const worker=runtime([{body:{schemaVersion,candidates}},{body:decision}],{tabUrl:()=>w.location.href});
  w.setInterval=()=>1;w.clearInterval=()=>{};
  w.Element.prototype.getClientRects=()=>[{}];
  w.chrome={runtime:{onMessage:{addListener(){},removeListener(){}},sendMessage:message=>worker.receive(message,documentSender)},storage:{local:{async get(){return {oneClickReply:false,autoLikeAfterReply:false};}}}};
  require('./clipboard-fixture.cjs').installClipboard(w);
  w.document.addEventListener('keydown',event=>{
    if(event.target.matches('[contenteditable="true"]') && event.key==='Backspace'){
      event.preventDefault();
      const selection=w.getSelection();
      if(selection.rangeCount) selection.getRangeAt(0).deleteContents();
    }
  });
  w.document.addEventListener('paste',event=>{event.preventDefault();event.target.textContent=event.clipboardData.getData('text/plain');});
  try{
    const content=`${reactRuntime}\n${fs.readFileSync(path.join(__dirname,'../extension/src/content.js'),'utf8')}`;
    assert.equal(w.eval(content).ok,true);
    w.history.pushState({},'','/compose/post');
    const dialog=w.document.createElement('div');dialog.setAttribute('role','dialog');
    dialog.innerHTML='<div role="dialog" aria-modal="true"><article data-testid="tweet"><div data-testid="tweetText">这周末大家想做什么？</div></article><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><button data-testid="tweetButton">Reply</button></div>';
    w.document.body.append(dialog);
    let sent=0;w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>sent++;
    w.document.querySelector('[data-action="generate"]').click();
    await new Promise(resolve=>setTimeout(resolve,600));
    const status=w.document.querySelector('[data-role="status"]').textContent;
    assert.equal(worker.calls.length,2,status);
    assert.equal(w.document.querySelector('[role="textbox"]').textContent,candidates[0].text);
    assert.match(status,/已回填/);assert.equal(sent,0);
    assert.equal(JSON.parse(worker.calls[0].options.body).messages[0].text,'这周末大家想做什么？');
  }finally{w.close();}
});

test('content script loads from home before SPA navigation to a public reply', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.ok(manifest.content_scripts.some(script => script.matches.includes('https://x.com/*')));
  assert.ok(manifest.action?.default_popup, 'toolbar must have a usable entry point');
});

test('generation errors stop the decision call and do not substitute mock', async () => {
  const app = runtime([{ ok: false, status: 503, body: { error: '生成模型尚未配置：LLM_MODEL' } }]);
  const result = await app.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /LLM_MODEL/);
  assert.equal(app.calls.length, 1);
  assert.equal(result.candidates, undefined);
});

test('abstention is preserved with no selected reply', async () => {
  const app = runtime([{ body: { schemaVersion, candidates } },
    { body: { ...decision, reviewRequired: true, selectedId: null } }]);
  const result = await app.send();
  assert.equal(result.ok, true);
  assert.equal(result.decision.selectedId, null);
  assert.equal(result.decision.reviewRequired, true);
});

test('invalid decision never exposes candidates for filling', async () => {
  for (const invalid of [{ ...decision, selectedId: 'c99' }, { ...decision, confidence: '0.9' },
    { ...decision, probabilities: { c1: 1 } }]) {
    const app = runtime([{ body: { schemaVersion, candidates } }, { body: invalid }]);
    const result = await app.send();
    assert.equal(result.ok, false);
    assert.equal(result.candidates, undefined);
  }
});

test('only the extension content script on a conversation can call models', async () => {
  for (const sender of [senderFor('https://x.com/messages/123',{id:'other-extension'}), senderFor('https://x.com/home')]) {
    const app = runtime([],{tabUrl:sender.url});
    assert.equal((await app.send(sender)).ok, false);
    assert.equal(app.calls.length, 0);
  }
});

// ---- quick-post 发帖：批次编排与候选缓存（话题/候选均为测试替身）----
const POST_SCHEMA = 'quick-post.v1';
const CACHE_KEY = 'quickPost.cache.v1';
const hotTopics = () => ([
  { id: 't1', rank: 1, title: '话题一', summary: '摘要一。', tags: ['a'], repliesCount: 10 },
  { id: 't2', rank: 2, title: '话题二', summary: '摘要二。', tags: ['b'], repliesCount: 20 },
  { id: 't3', rank: 3, title: '话题三', summary: '摘要三。', tags: [], repliesCount: 30 },
  { id: 't4', rank: 4, title: '话题四', summary: '摘要四。', tags: [], repliesCount: 40 },
  { id: 't5', rank: 5, title: '话题五', summary: '摘要五。', tags: [], repliesCount: 50 }
]);
const postDecision = (selectedId = 'c3') => ({ schemaVersion: POST_SCHEMA, model: 'decision-model-preview',
  selectedId, reviewRequired: selectedId === null,
  confidence: 0.7, probabilities: { c1: 0.1, c2: 0.1, c3: 0.5, c4: 0.1, c5: 0.1, __none__: 0.1 } });
const postCandidates = (count = 5) => ({ schemaVersion: POST_SCHEMA,
  candidates: Array.from({ length: count }, (_, i) => ({ id: `c${i + 1}`, topicId: `t${i + 1}`, text: `帖文${i + 1}：你会怎么选？四选一。`, checkNotes: ['发布前核实：机制属实'] })) });
const topicsResponse = () => ({ body: { schemaVersion: POST_SCHEMA, source: 'xzhishu-topics-hot', fetchedAt: 1, topics: hotTopics() } });

function postRuntime(responses, { tabUrl = 'https://x.com/compose/post', settings = {}, store = {}, getError, setError } = {}) {
  let listener;
  const calls = [];
  const storage = { ...store };
  let seq = 0;
  const context = { URL, AbortController, TextEncoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `uuid-${++seq}`, subtle: webcrypto.subtle },
    chrome: { runtime: { id: 'extension-id', onMessage: { addListener(fn) { listener = fn; } } },
      tabs: { async get(id) { assert.equal(id, 17); return { id, url: typeof tabUrl === 'function' ? tabUrl() : tabUrl }; } },
      storage: { local: {
        async get(keys) {
          if (getError) throw Error(getError);
          const list = typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const key of list) out[key] = key in storage ? storage[key] : (typeof keys === 'object' ? keys[key] : undefined);
          return out;
        },
        async set(entries) { if (setError) throw Error(setError); Object.assign(storage, entries); }
      } } },
    async fetch(url, options) {
      calls.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw Error('Unexpected network call');
      return { ok: response.ok !== false, status: response.status || 200, async json() { return response.body; } };
    } };
  vm.runInNewContext(source, context);
  const receive = (message, sender = senderFor('https://x.com/compose/post')) => new Promise(resolve => listener(message, sender, resolve));
  return { calls, storage, receive,
    batch: (source) => receive({ type: 'GENERATE_POST_BATCH', source }),
    list: () => receive({ type: 'LIST_POST_CACHE' }),
    cacheOp: (op, id) => receive({ type: 'POST_CACHE_OP', op, id }) };
}

test('post batch runs fetch, one post per topic, decision and caches every draft', async () => {
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision() }]);
  const result = await app.batch();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.topics.length, 5);
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates[2].topicId, 't3');
  assert.equal(result.decision.selectedId, 'c3');
  assert.equal(app.calls.length, 3);
  assert.match(app.calls[0].url, /\/posts\/topics\/fetch$/);
  assert.match(app.calls[1].url, /\/posts\/generate$/);
  assert.match(app.calls[2].url, /\/posts\/decide$/);
  assert.equal(JSON.parse(app.calls[1].options.body).topics.length, 5);
  assert.equal(JSON.parse(app.calls[1].options.body).language, 'auto');
  assert.equal(app.storage[CACHE_KEY].items.length, 5);
  assert.equal(result.cache.length, 5);
  assert.equal(result.cacheError, null);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.historyCount, 5);
});

test('previously used/generated post text is skipped across batches and not regenerated into the pool', async () => {
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision() },
    topicsResponse(), { body: postCandidates() }, { body: postDecision() }]);
  const first = await app.batch();
  assert.equal(first.ok, true, first.error);
  const second = await app.batch();
  assert.equal(second.ok, true, second.error);
  assert.equal(second.skippedCount, 5);
  assert.equal(second.cache.length, 5);
  assert.equal(second.historyCount, 5);
});

test('clearing history is explicit and does not clear the candidate cache', async () => {
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision() }]);
  const batch = await app.batch();
  assert.equal(batch.historyCount, 5);
  const cleared = await app.cacheOp('clear-history');
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(cleared.historyCount, 0);
  assert.equal(app.storage[CACHE_KEY].items.length, 5);
});

test('decision abstention still caches every post but marks none recommended', async () => {
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision(null) }]);
  const result = await app.batch();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.decision.reviewRequired, true);
  assert.equal(result.decision.selectedId, null);
  assert.equal(app.storage[CACHE_KEY].items.length, 5);
  assert.equal(result.cache.length, 5);
});

test('over the limit the cache deletes used items first, then the oldest', async () => {
  const items = [];
  items.push({ id: 'used-1', text: '已发过的旧帖一', checkNotes: [], sourceTopic: { id: 't0', title: '旧话题' }, batchId: 'b0', createdAt: 1, usedAt: 10 });
  items.push({ id: 'used-2', text: '已发过的旧帖二', checkNotes: [], sourceTopic: { id: 't0', title: '旧话题' }, batchId: 'b0', createdAt: 2, usedAt: 20 });
  for (let i = 3; i <= 28; i++) items.push({ id: `old-${i}`, text: `旧帖${i}`, checkNotes: [], sourceTopic: { id: 't0', title: '旧话题' }, batchId: 'b0', createdAt: i });
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision() }],
    { store: { [CACHE_KEY]: { items } } });
  const result = await app.batch();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.evicted, 3);
  const kept = app.storage[CACHE_KEY].items;
  assert.equal(kept.length, 30);
  assert.ok(!kept.some((item) => item.usedAt), 'used items are evicted first');
  assert.ok(!kept.some((item) => item.id === 'old-3'), 'the oldest unused item is evicted next');
  assert.ok(kept.some((item) => item.id === 'old-4'));
  assert.match(JSON.stringify(result.evicted), /^3$/);
});

test('cache write failure keeps the batch visible but never claims it cached', async () => {
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision() }], { setError: 'disk full' });
  const result = await app.batch();
  assert.equal(result.ok, true, result.error);
  assert.match(result.cacheError, /cache\.write/);
  assert.equal(result.cache, null);
  assert.equal(result.candidates.length, 5);
  assert.equal(app.storage[CACHE_KEY], undefined);
});

test('cache read failure is reported as a failure, never as an empty pool', async () => {
  const app = postRuntime([], { getError: 'storage broken' });
  const result = await app.list();
  assert.equal(result.ok, false);
  assert.match(result.error, /cache\.read/);
  const invalid = postRuntime([], { store: { [CACHE_KEY]: { items: [{ bad: true }] } } });
  const listed = await invalid.list();
  assert.equal(listed.ok, false);
  assert.match(listed.error, /cache\.read/);
});

test('mark, unmark, delete and clear keep the cache pool consistent', async () => {
  const mk = (id, text, usedAt) => ({ id, text, checkNotes: [], sourceTopic: { id: 't1', title: '话题一' }, batchId: 'b1', createdAt: 1, ...(usedAt ? { usedAt } : {}) });
  const app = postRuntime([], { store: { [CACHE_KEY]: { items: [mk('k1', '帖文一'), mk('k2', '帖文二')] } } });
  const marked = await app.cacheOp('mark', 'k1');
  assert.equal(marked.ok, true, marked.error);
  assert.equal(typeof marked.items.find((item) => item.id === 'k1').usedAt, 'number');
  const unmarked = await app.cacheOp('unmark', 'k1');
  assert.equal(unmarked.items.find((item) => item.id === 'k1').usedAt, undefined);
  const deleted = await app.cacheOp('delete', 'k2');
  assert.equal(deleted.items.length, 1);
  const missing = await app.cacheOp('mark', 'nope');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);
  const cleared = await app.cacheOp('clear');
  assert.equal(cleared.items.length, 0);
});

test('invalid topic or post payloads stop the batch chain at their stage', async () => {
  const empty = postRuntime([{ body: { schemaVersion: POST_SCHEMA, source: 'xzhishu-topics-hot', fetchedAt: 1, topics: [] } }]);
  const emptyResult = await empty.batch();
  assert.equal(emptyResult.ok, false);
  assert.equal(empty.calls.length, 1);

  const short = postRuntime([topicsResponse(), { body: postCandidates(4) }]);
  const shortResult = await short.batch();
  assert.equal(shortResult.ok, false);
  assert.match(shortResult.error, /恰好一条/);
  assert.equal(short.calls.length, 2);
});

test('post messages require a compose surface on the current tab', async () => {
  const app = postRuntime([], { tabUrl: 'https://x.com/messages/123' });
  const result = await app.batch();
  assert.equal(result.ok, false);
  assert.match(result.error, /发帖/);
  assert.equal(app.calls.length, 0);
});

test('the board source is passed explicitly and never switched on failure', async () => {
  const app = postRuntime([topicsResponse(), { body: postCandidates() }, { body: postDecision() }]);
  const result = await app.batch('tweets');
  assert.equal(result.ok, true, result.error);
  assert.equal(JSON.parse(app.calls[0].options.body).source, 'tweets');
  const invalid = postRuntime([]);
  const rejected = await invalid.batch('blogs');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /topics|tweets/);
  assert.equal(invalid.calls.length, 0);
});
