const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
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
  const context = { URL, AbortController, setTimeout, clearTimeout,
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
  assert.equal(JSON.parse(app.calls[0].options.body).oneClickReply,undefined);
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
    await new Promise(resolve=>setTimeout(resolve,180));
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
