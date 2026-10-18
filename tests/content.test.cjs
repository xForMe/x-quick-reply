// Synthetic DOM fixtures; these do not replace acceptance on the live X editor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { installClipboard } = require('./clipboard-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content.js'), 'utf8');
const post = (id, text) => `<article data-testid="tweet"><a href="/someone/status/${id}"><time>now</time></a><div data-testid="tweetText">${text}</div></article>`;
const editor = '<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>';
function app({html = `<div role="dialog">${post('123', '一起讨论这个想法？')}${editor}<button data-testid="tweetButton">Reply</button></div>`, url = 'https://x.com/compose/post', response, trustedTypes = false, pasteHandler} = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, {url, runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window, calls = [];
  let messageListener;
  let listenerCount = 0;
  let poll;
  w.setInterval = fn => {poll=fn;return 1;};
  w.clearInterval = () => {};
  w.Element.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  w.chrome = {runtime:{onMessage:{addListener(fn){messageListener=fn;listenerCount++;},removeListener(fn){if(messageListener===fn) {messageListener=null;listenerCount--;}}}, async sendMessage(message) {
    calls.push(message);
    if (response) return response(message);
    return {ok:true, candidates:[{id:'c1',text:'你最想先讨论哪一部分？'},{id:'c2',text:'可以具体说说你的想法吗？'}], decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}};
  }}};
  installClipboard(w);
  // Minimal editor substitute. Actual Draft.js integration is tested separately.
  w.document.addEventListener('paste', event => {
    if (!event.target.matches('[contenteditable="true"]')) return;
    if(pasteHandler) return pasteHandler(event,w);
    event.preventDefault();
    const range=w.getSelection().getRangeAt(0);
    range.deleteContents();
    range.insertNode(w.document.createTextNode(event.clipboardData.getData('text/plain')));
  });
  w.document.execCommand = () => { throw Error('Unexpected native DOM insertion'); };
  const htmlDescriptor = Object.getOwnPropertyDescriptor(w.Element.prototype,'innerHTML');
  if (trustedTypes) {
    Object.defineProperty(w.Element.prototype, 'innerHTML', { set() { throw new TypeError("This document requires 'TrustedHTML' assignment."); } });
    w.Element.prototype.insertAdjacentHTML = () => { throw new TypeError("This document requires 'TrustedHTML' assignment."); };
  }
  const boot = w.eval(source);
  return {w, calls, panel:()=>w.document.getElementById('quick-reply-panel'),
    status:()=>w.document.querySelector('[data-role="status"]').textContent,
    async generate(){w.document.querySelector('[data-action="generate"]').click(); await new Promise(resolve=>setTimeout(resolve,180));},
    open(){let result; messageListener({type:'OPEN_QUICK_REPLY'}, {id:'test'}, r=>result=r);return result;},
    boot, tick(){poll();},reinject(){return w.eval(source);},listenerCount(){return listenerCount;},
    close(){Object.defineProperty(w.Element.prototype,'innerHTML',htmlDescriptor);w.close();}};
}

test('public reply dialog reads only its target and fills selected candidate without sending', async () => {
  const a=app({html:`${post('999','背景信息不能使用')}<div role="dialog">${post('123','一起讨论这个想法？')}${editor}<button data-testid="tweetButton">Reply</button></div>`});
  try {
    let sent=0; a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>sent++;
    await a.generate();
    assert.equal(a.calls.length,1);
    assert.equal(a.calls[0].context.kind,'public-reply');
    assert.deepEqual(JSON.parse(JSON.stringify(a.calls[0].context.messages)),[{role:'them',text:'一起讨论这个想法？'}]);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'你最想先讨论哪一部分？');
    assert.equal(sent,0);
    assert.match(a.status(),/已回填/);
  } finally {a.close();}
});

test('auto-like waits for a confirmed user send and verifies the like state', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'},{id:'c2',text:'可以具体说说。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}}),html:`<div role="dialog">${post('123','目标帖子')}<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><button data-testid="tweetButton">Reply</button></div>`});
  try {
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Unlike');};
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    await a.generate();
    assert.equal(like.dataset.testid,'like');
    const editor=a.w.document.querySelector('[role="textbox"]');
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{editor.textContent='';};
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    assert.equal(like.dataset.testid,'like');
    a.tick();
    assert.equal(like.dataset.testid,'unlike',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like stays disabled unless the setting is explicitly enabled', async () => {
  const a=app({html:`<div role="dialog">${post('123','目标帖子')}<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><button data-testid="tweetButton">Reply</button></div>`});
  try {
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    await a.generate();
    a.w.document.querySelector('[role="textbox"]').textContent='';
    a.w.document.querySelector('[data-testid="tweetButton"]').click(); a.tick();
    assert.equal(like.dataset.testid,'like');
  } finally {a.close();}
});

test('auto-like also covers a manually typed public reply when the panel is open', async () => {
  const a=app({html:`<div role="dialog">${post('123','目标帖子')}${editor}<button data-testid="tweetButton">Reply</button></div>`});
  try {
    a.w.chrome.storage={local:{async get(){return {autoLikeAfterReply:true};}}};
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Unlike');};
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    const textbox=a.w.document.querySelector('[role="textbox"]'); textbox.textContent='手写回复';
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{textbox.textContent='';};
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(textbox.textContent,'');
    assert.equal(like.dataset.testid,'unlike',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like relocates the target when X rewrites the status link and uses a counted aria label', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}}),html:`<div role="dialog">${post('123','目标帖子')}${editor}<button data-testid="tweetButtonInline">Reply</button></div>`});
  try {
    const original=a.w.document.querySelector('[data-testid="tweet"]');
    const editorNode=a.w.document.querySelector('[role="textbox"]');
    const like=a.w.document.createElement('button'); like.setAttribute('aria-label','Like (12)');
    like.onclick=()=>{like.setAttribute('aria-label','Unlike (13)');};
    original.append(like);
    await a.generate();
    a.w.document.querySelector('[data-testid="tweetButtonInline"]').onclick=()=>{
      editorNode.remove();
      original.remove();
      const replacement=a.w.document.createElement('article'); replacement.dataset.testid='tweet';
      replacement.innerHTML='<a href="https://x.com/someone/status/123?ref=timeline"></a>';
      const replacementLike=a.w.document.createElement('button'); replacementLike.setAttribute('aria-label','Like (12)');
      replacementLike.onclick=()=>replacementLike.setAttribute('aria-label','Unlike (13)');
      replacement.append(replacementLike); a.w.document.body.append(replacement);
    };
    a.w.document.querySelector('[data-testid="tweetButtonInline"]').click();
    a.tick();
    const replacement=a.w.document.querySelector('[data-testid="tweet"]');
    assert.equal(replacement.querySelector('[aria-label^="Unlike"]').getAttribute('aria-label'),'Unlike (13)',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('reply language follows source content regardless of the X interface language',async()=>{
  for(const [interfaceLanguage,text] of [['en','这个周末想去爬山，大家有什么建议？'],['zh-CN','Any tips for my first hiking trip?']]){
    const a=app({html:`<div role="dialog">${post('123',text)}${editor}</div>`});
    try{
      a.w.document.documentElement.lang=interfaceLanguage;
      await a.generate();assert.equal(a.calls.length,1,a.status());
      assert.equal(a.calls[0].context.language,'auto');
      assert.equal(a.calls[0].context.messages[0].text,text);
    }finally{a.close();}
  }
});

test('after auto-fill another candidate replaces the unchanged plugin draft',async()=>{
  const a=app();
  try{
    await a.generate();
    a.w.document.querySelector('[data-candidate="c2"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'可以具体说说你的想法吗？',a.status());
    assert.match(a.status(),/已回填/);
    assert.equal(a.calls.length,1);
  }finally{a.close();}
});

test('repeated fill of the same candidate is a no-op without an error',async()=>{
  const a=app();
  try{
    let writes=0;
    a.w.document.addEventListener('paste',()=>writes++);
    await a.generate();
    a.w.document.querySelector('[data-action="fill"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    assert.equal(writes,1);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'你最想先讨论哪一部分？');
    assert.doesNotMatch(a.status(),/变化|失败/);
  }finally{a.close();}
});

test('rapid fill events and reinitialization do not duplicate paste handlers',async()=>{
  const a=app();
  try{
    a.reinject();a.reinject();
    let pastes=0;a.w.document.addEventListener('paste',()=>pastes++);
    a.w.document.querySelector('[data-action="generate"]').click();
    await new Promise(resolve=>setTimeout(resolve,10));
    const fill=a.w.document.querySelector('[data-action="fill"]');
    assert.equal(fill.disabled,true);
    fill.dispatchEvent(new a.w.MouseEvent('click',{bubbles:true}));
    fill.dispatchEvent(new a.w.MouseEvent('click',{bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(pastes,1);assert.match(a.status(),/已回填/);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'你最想先讨论哪一部分？');
  }finally{a.close();}
});

test('manual changes after fill are preserved with or without an input event',async()=>{
  for(const notify of [true,false]){
    const a=app();
    try{
      await a.generate();
      a.w.document.querySelector('[data-candidate="c2"]').click();
      const textbox=a.w.document.querySelector('[role="textbox"]');
      textbox.textContent='我手动改写的草稿';
      if(notify) textbox.dispatchEvent(new a.w.InputEvent('input',{bubbles:true}));
      a.w.document.querySelector('[data-action="fill"]').dispatchEvent(new a.w.MouseEvent('click',{bubbles:true}));
      assert.equal(textbox.textContent,'我手动改写的草稿');
      assert.match(a.status(),/变化/);assert.equal(a.calls.length,1);
    }finally{a.close();}
  }
});

test('manual changes during verification cancel ownership and cannot be overwritten',async()=>{
  const a=app();
  try{
    a.w.document.querySelector('[data-action="generate"]').click();
    await new Promise(resolve=>setTimeout(resolve,10));
    const textbox=a.w.document.querySelector('[role="textbox"]');
    textbox.textContent='核验期间手动写的内容';
    textbox.dispatchEvent(new a.w.InputEvent('input',{bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(textbox.textContent,'核验期间手动写的内容');
    assert.match(a.status(),/变化/);
    assert.equal(a.w.document.querySelectorAll('[data-candidate]').length,0);
  }finally{a.close();}
});

test('late framework input notifications for unchanged text retain replaceable ownership',async()=>{
  const a=app();
  try{
    await a.generate();
    const textbox=a.w.document.querySelector('[role="textbox"]');
    textbox.dispatchEvent(new a.w.InputEvent('input',{bubbles:true}));
    a.w.document.querySelector('[data-candidate="c2"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(textbox.textContent,'可以具体说说你的想法吗？',a.status());
    assert.match(a.status(),/已回填/);
  }finally{a.close();}
});

test('unhandled paste stops without a native insertion or a second attempt',async()=>{
  const a=app({pasteHandler:()=>{}});
  try{
    let pastes=0;a.w.document.addEventListener('paste',()=>pastes++);
    await a.generate();
    assert.equal(pastes,1);assert.match(a.status(),/未接收粘贴事件/);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');
    assert.equal(a.w.document.querySelectorAll('[data-candidate]').length,0);
  }finally{a.close();}
});

test('accepted paste followed by duplicate reconciliation fails verification without retry',async()=>{
  const a=app({pasteHandler:(event,w)=>{
    event.preventDefault();const text=event.clipboardData.getData('text/plain');
    event.target.textContent=text;
    w.setTimeout(()=>{event.target.textContent=text+text;},30);
  }});
  try{
    let pastes=0;a.w.document.addEventListener('paste',()=>pastes++);
    await a.generate();
    assert.equal(pastes,1);assert.match(a.status(),/核验失败/);
    assert.equal(a.w.document.querySelectorAll('[data-candidate]').length,0);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'你最想先讨论哪一部分？'.repeat(2));
  }finally{a.close();}
});

test('accepted paste that never renders is a failure rather than success',async()=>{
  const a=app({pasteHandler:event=>event.preventDefault()});
  try{await a.generate();assert.match(a.status(),/核验失败/);assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');}finally{a.close();}
});

test('target changes during editor focus stop before paste',async()=>{
  const a=app();
  try{
    let pastes=0;a.w.document.addEventListener('paste',()=>pastes++);
    a.w.document.querySelector('[role="textbox"]').addEventListener('focus',()=>{a.w.document.querySelector('[data-testid="tweetText"]').textContent='另一个目标';});
    await a.generate();
    assert.equal(pastes,0);assert.match(a.status(),/聚焦输入框时目标或草稿发生变化/);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');
  }finally{a.close();}
});

test('replacing the reply target during verification never grants draft ownership',async()=>{
  const a=app();
  try{
    a.w.document.querySelector('[data-action="generate"]').click();
    await new Promise(resolve=>setTimeout(resolve,10));
    const target=a.w.document.querySelector('[data-testid="tweet"]');
    target.replaceWith(target.cloneNode(true));
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.match(a.status(),/核验失败/);
    assert.equal(a.w.document.querySelectorAll('[data-candidate]').length,0);
  }finally{a.close();}
});

test('textarea candidate replacement also replaces only the exact plugin draft',async()=>{
  const a=app({url:'https://x.com/messages/123',html:'<div data-testid="DMConversation"><div data-testid="messageEntry">合成消息</div><textarea data-testid="dmComposerTextInput"></textarea></div>'});
  try{
    await a.generate();
    a.w.document.querySelector('[data-candidate="c2"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(a.w.document.querySelector('textarea').value,'可以具体说说你的想法吗？');
    assert.match(a.status(),/已回填/);
  }finally{a.close();}
});

test('an invalidated extension context stops generation and directs the user to refresh X',async()=>{
  const a=app({response:()=>{throw new Error('Extension context invalidated.');}});
  try{
    await a.generate();
    assert.equal(a.calls.length,1);
    assert.match(a.status(),/刷新 X 页面/);
    assert.doesNotMatch(a.status(),/Extension context invalidated/);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');
    assert.equal(a.w.document.querySelector('[data-action="generate"]').disabled,false);
    assert.equal(a.w.document.querySelectorAll('[data-candidate]').length,0);
  }finally{a.close();}
});

test('nested dialog wrappers around one reply editor count as one reply surface', async () => {
  const a=app({html:`<div role="dialog" aria-modal="true"><div role="dialog" data-testid="sheetDialog">${post('123','目标正文')}${editor}</div></div>`});
  try {await a.generate();assert.equal(a.calls.length,1,a.status());assert.match(a.status(),/已回填/);}finally{a.close();}
});

test('target and editor can occupy different nested wrappers inside the same modal', async () => {
  const a=app({html:`<div role="dialog" aria-modal="true">${post('123','目标正文')}<div role="dialog">${editor}</div></div>`});
  try {await a.generate();assert.equal(a.calls.length,1,a.status());assert.match(a.status(),/已回填/);}finally{a.close();}
});

test('an unrelated visible dialog without a reply editor cannot block the reply surface', async () => {
  const a=app({html:`<div role="dialog">无关提示</div><div role="dialog">${post('123','目标正文')}${editor}</div>`});
  try {await a.generate();assert.equal(a.calls.length,1,a.status());assert.match(a.status(),/已回填/);}finally{a.close();}
});

test('two distinct reply dialogs remain ambiguous and never call models', async () => {
  const a=app({html:`<div role="dialog">${post('123','目标一')}${editor}</div><div role="dialog">${post('456','目标二')}${editor}</div>`});
  try{await a.generate();assert.equal(a.calls.length,0);assert.match(a.status(),/唯一|多个/);}finally{a.close();}
});

test('reported structure: one visible reply editor, one hidden editor and no status links', async () => {
  // Reconstruct only metadata supplied by the user; all text is synthetic.
  const a=app({html:`${post('999','背景帖子不可使用')}<div role="dialog"><article data-testid="tweet"><div data-testid="tweetText">当前回复目标正文</div></article>${editor}</div><div role="dialog" aria-modal="true"><div aria-hidden="true"><article data-testid="tweet"><div data-testid="tweetText">隐藏目标不可使用</div></article>${editor}</div></div>`});
  try {
    assert.equal(a.open().ok,true,a.status());
    await a.generate();
    assert.equal(a.calls.length,1,a.status());
    assert.equal(a.calls[0].context.messages[0].text,'当前回复目标正文');
    const editors=a.w.document.querySelectorAll('[role="textbox"]');
    assert.match(editors[0].textContent,/讨论/);
    assert.equal(editors[1].textContent,'');
    assert.match(a.status(),/已回填/);
  }finally{a.close();}
});

test('linkless reply target replaced during generation prevents stale fill', async () => {
  let finish;
  const a=app({html:`<div role="dialog"><article data-testid="tweet"><div data-testid="tweetText">相同正文</div></article>${editor}</div>`,response:()=>new Promise(resolve=>finish=resolve)});
  try {
    await a.generate();assert.equal(a.calls.length,1,a.status());
    const target=a.w.document.querySelector('[data-testid="tweet"]');
    target.replaceWith(target.cloneNode(true));
    finish({ok:true,candidates:[{id:'c1',text:'不应回填'}],decision:{selectedId:'c1',reviewRequired:false,confidence:1}});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');
    assert.match(a.status(),/变化/);
  }finally{a.close();}
});

test('reply snapshots detect changed links, text node, editor or modal even with identical text',async()=>{
  const changes=[
    a=>a.w.document.querySelector('a').setAttribute('href','/someone/status/456'),
    a=>{const node=a.w.document.querySelector('[data-testid="tweetText"]');node.replaceWith(node.cloneNode(true));},
    a=>{const node=a.w.document.querySelector('[role="textbox"]');node.replaceWith(node.cloneNode(true));},
    a=>{const old=a.w.document.querySelector('[role="dialog"]'), replacement=old.cloneNode(false);replacement.append(...old.childNodes);old.replaceWith(replacement);}
  ];
  for(const change of changes){
    let finish;const a=app({response:()=>new Promise(resolve=>finish=resolve)});
    try{
      await a.generate();assert.equal(a.calls.length,1,a.status());change(a);
      finish({ok:true,candidates:[{id:'c1',text:'不应回填'}],decision:{selectedId:'c1',reviewRequired:false,confidence:1}});
      await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');assert.match(a.status(),/变化/);
    }finally{a.close();}
  }
});

test('copyable diagnostics contain structural metadata, excluding text, draft and status identity',async()=>{
  const a=app({html:`<div role="dialog">${post('123456789','不应复制的帖子正文')}${editor}${editor}</div>`});
  try {
    a.w.document.querySelector('[role="textbox"]').textContent='不应复制的草稿';
    let copied;
    Object.defineProperty(a.w.navigator,'clipboard',{value:{async writeText(text){copied=text;}}});
    await a.generate();
    const button=a.w.document.querySelector('[data-action="diagnostics"]');
    assert.equal(button.hidden,false);button.click();await new Promise(resolve=>setTimeout(resolve,0));
    const value=JSON.parse(copied);
    assert.equal(value.editorCount,2);assert.equal(value.dialogCount,1);
    assert.equal(value.eligibleEditorCount,2);assert.equal(value.dialogs[0].visibleEditors,2);
    assert.equal(value.editors[0].nearestDialogIndex,0);assert.equal(value.editors[0].boundaryDialogIndex,0);
    assert.equal(value.schema,'quick-reply.dom.v1');
    for(const secret of ['不应复制的帖子正文','不应复制的草稿','123456789','https://x.com','someone']) assert.equal(copied.includes(secret),false);
    assert.equal(a.calls.length,0);assert.match(a.status(),/已复制/);
  }finally{a.close();}
});

test('opening a reply from home before generation shows instructions, not a stale-result error', () => {
  const a=app({html:'',url:'https://x.com/home'});
  try {
    a.w.history.pushState({},'', '/compose/post');
    const dialog=a.w.document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML=post('123','目标帖子')+editor;a.w.document.body.append(dialog);
    a.tick();
    assert.equal(a.panel().hidden,false);
    assert.equal(a.w.document.querySelector('[data-role="status"]').classList.contains('error'),false);
    assert.match(a.status(),/点击/);
    assert.equal(a.w.document.querySelector('[data-action="fill"]').hidden,true);
    assert.equal(a.calls.length,0);
  }finally{a.close();}
});

test('generation shows busy state and keeps real failures visible',async()=>{
  let finish;
  const a=app({response:()=>new Promise(resolve=>finish=resolve)});
  try {
    await a.generate();
    const button=a.w.document.querySelector('[data-action="generate"]');
    assert.equal(button.disabled,true);assert.match(button.textContent,/生成中/);
    finish({ok:false,error:'生成接口失败：HTTP 503'});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(button.disabled,false);assert.match(a.status(),/HTTP 503/);
    assert.equal(a.w.document.querySelector('[data-role="status"]').classList.contains('error'),true);
  }finally{a.close();}
});

test('Trusted Types enforcement does not prevent startup, candidate rendering or fill', async () => {
  const a=app({trustedTypes:true});
  try {assert.equal(a.open().ok,true);await a.generate();assert.equal(a.calls.length,1);assert.match(a.status(),/已回填/);}finally{a.close();}
});

test('a stale DOM panel left by a reloaded extension cannot suppress initialization', () => {
  const a=app({html:'<aside id="quick-reply-panel">obsolete</aside>'});
  try {assert.equal(a.open().ok,false);assert.match(a.status(),/目标|回复/);assert.equal(a.w.document.querySelectorAll('#quick-reply-panel').length,1);}finally{a.close();}
});

test('repeated explicit initialization keeps one panel and one live listener', () => {
  const a=app();
  try {assert.equal(a.boot.ok,true);assert.equal(a.reinject().ok,true);assert.equal(a.reinject().ok,true);assert.equal(a.listenerCount(),1);assert.equal(a.w.document.querySelectorAll('#quick-reply-panel').length,1);assert.equal(a.open().ok,true);}finally{a.close();}
});

test('blank post and quote composers never borrow a post from the background', async () => {
  for(const html of [`${post('999','background')}<div role="dialog">${editor}</div>`, `<div role="dialog">${editor}${post('123','quote')}</div>`]) {
    const a=app({html}); try { await a.generate(); assert.equal(a.calls.length,0); assert.match(a.status(),/回复|目标/); } finally{a.close();}
  }
});

test('nonempty draft stops before network, preserving user text', async () => {
  const a=app(); try { a.w.document.querySelector('[role="textbox"]').textContent='我的草稿';await a.generate();assert.equal(a.calls.length,0);assert.match(a.status(),/草稿/); }finally{a.close();}
});

test('ambiguous editors or target posts stop before model calls', async () => {
  for (const html of [`<div role="dialog">${post('123','target')}${editor}${editor}</div>`,
    `<div role="dialog">${post('123','one')}${post('456','two')}${editor}</div>`]) {
    const a=app({html}); try{await a.generate();assert.equal(a.calls.length,0);assert.match(a.status(),/唯一|目标/);}finally{a.close();}
  }
});

test('direct-message extraction stays inside the current conversation', async () => {
  const a=app({url:'https://x.com/messages/123',html:'<div data-testid="messageEntry">无关消息</div><div data-testid="DMConversation"><div data-testid="messageEntry">可以聊聊吗？</div><textarea data-testid="dmComposerTextInput"></textarea></div>'});
  try{await a.generate();assert.equal(a.calls[0].context.kind,'direct-message');assert.equal(a.calls[0].context.messages.length,1);assert.equal(a.calls[0].context.messages[0].text,'可以聊聊吗？');assert.match(a.w.document.querySelector('textarea').value,/讨论/);}finally{a.close();}
});

test('changing target while generation runs prevents stale fill', async () => {
  let resolveResponse;
  const a=app({response:()=>new Promise(resolve=>resolveResponse=resolve)});
  try {
    await a.generate();
    a.w.document.querySelector('[data-testid="tweetText"]').textContent='新帖子';
    resolveResponse({ok:true,candidates:[{id:'c1',text:'旧回复'}],decision:{selectedId:'c1',reviewRequired:false,confidence:1}});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'');
    assert.match(a.status(),/变化|切换/);
  }finally{a.close();}
});

test('abstention and gateway failure never fill editor', async () => {
  for(const response of [{ok:false,error:'生成接口失败：HTTP 503'}, {ok:true,candidates:[{id:'c1',text:'不可填'}],decision:{selectedId:null,reviewRequired:true,confidence:0.8}}]) {
    const a=app({response:()=>response}); try{await a.generate(); assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,''); assert.match(a.status(),/失败|未选择/);}finally{a.close();}
  }
});

test('toolbar reopens a closed panel and SPA navigation discovers reply dialog', async () => {
  const a=app({html:'',url:'https://x.com/home'});
  try {
    assert.equal(a.open().ok,false, 'unsupported pages must return an explicit toolbar error');
    a.w.history.pushState({},'', '/compose/post');
    const dialog=a.w.document.createElement('div'); dialog.setAttribute('role','dialog');dialog.innerHTML=post('123','目标帖子')+editor;a.w.document.body.append(dialog);
    assert.equal(a.open().ok,true); assert.equal(a.panel().hidden,false);
    a.w.document.querySelector('[data-action="close"]').click(); assert.equal(a.panel().hidden,true);
    assert.equal(a.open().ok,true); assert.equal(a.panel().hidden,false);
    await a.generate(); assert.equal(a.calls.length,1);
  }finally{a.close();}
});
