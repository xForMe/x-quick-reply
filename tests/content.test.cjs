// Synthetic DOM fixtures; these do not replace acceptance on the live X editor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { installClipboard } = require('./clipboard-fixture.cjs');
const reactRuntime = [
  fs.readFileSync(path.join(__dirname, '../extension/src/vendor/react.production.min.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '../extension/src/vendor/react-dom.production.min.js'), 'utf8')
].join('\n');
const source = `${reactRuntime}\n${fs.readFileSync(path.join(__dirname, '../extension/src/content.js'), 'utf8')}`;
const post = (id, text) => `<article data-testid="tweet"><a href="/someone/status/${id}"><time>now</time></a><div data-testid="tweetText">${text}</div></article>`;
const editor = '<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>';
function app({html = `<div role="dialog">${post('123', '一起讨论这个想法？')}${editor}<button data-testid="tweetButton">Reply</button></div>`, url = 'https://x.com/compose/post', response, trustedTypes = false, pasteHandler, pendingLikeMarker, pendingLikeRaw, oneClickReply = false, oneClickCountdownSeconds = 10, trustedClicks = false} = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, {url, runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window, calls = [];
  let now = Date.now();
  w.Date.now = () => now;
  let messageListener;
  let listenerCount = 0;
  const intervals = [];
  w.setInterval = fn => {intervals.push(fn);return intervals.length;};
  w.clearInterval = id => {intervals[id - 1] = null;};
  w.Element.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  const storage={async get(){return {oneClickReply,oneClickCountdownSeconds,autoLikeAfterReply:false};}};
  if (trustedClicks) {
    // Test-only stand-in for a real user click: jsdom cannot dispatch trusted events,
    // so document click listeners receive the same event with isTrusted forced true.
    const add=w.document.addEventListener.bind(w.document), remove=w.document.removeEventListener.bind(w.document), wrapped=new Map();
    const trust=event=>new Proxy(event,{get:(target,key)=>key==='isTrusted'?true:(typeof target[key]==='function'?target[key].bind(target):target[key])});
    w.document.addEventListener=(type,fn,options)=>{if(type!=='click')return add(type,fn,options);const listener=event=>fn(trust(event));wrapped.set(fn,listener);return add(type,listener,options);};
    w.document.removeEventListener=(type,fn,options)=>remove(type,type==='click'&&wrapped.has(fn)?wrapped.get(fn):fn,options);
  }
  w.chrome = {runtime:{onMessage:{addListener(fn){messageListener=fn;listenerCount++;},removeListener(fn){if(messageListener===fn) {messageListener=null;listenerCount--;}}}, async sendMessage(message) {
    calls.push(message);
    if (response) return response(message);
    return {ok:true, candidates:[{id:'c1',text:'你最想先讨论哪一部分？'},{id:'c2',text:'可以具体说说你的想法吗？'}], decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}};
  }},storage:{local:storage}};
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
  w.document.addEventListener('keydown', event => {
    if (!event.target.matches('[contenteditable="true"]') || event.key !== 'Backspace') return;
    event.preventDefault();
    const selection=w.getSelection();
    if (!selection.rangeCount) return;
    selection.getRangeAt(0).deleteContents();
  });
  w.document.execCommand = () => { throw Error('Unexpected native DOM insertion'); };
  const htmlDescriptor = Object.getOwnPropertyDescriptor(w.Element.prototype,'innerHTML');
  if (trustedTypes) {
    Object.defineProperty(w.Element.prototype, 'innerHTML', { set() { throw new TypeError("This document requires 'TrustedHTML' assignment."); } });
    w.Element.prototype.insertAdjacentHTML = () => { throw new TypeError("This document requires 'TrustedHTML' assignment."); };
  }
  if (pendingLikeRaw !== undefined) w.sessionStorage.setItem('__xQuickReplyPendingLike.v1', pendingLikeRaw);
  else if (pendingLikeMarker) w.sessionStorage.setItem('__xQuickReplyPendingLike.v1', JSON.stringify(pendingLikeMarker));
  const boot = w.eval(source);
  return {w, calls, panel:()=>w.document.getElementById('quick-reply-panel'),
    status:()=>w.document.querySelector('[data-role="status"]').textContent,
    async generate(){await new Promise(resolve=>setTimeout(resolve,0));w.document.querySelector('[data-action="generate"]').click(); await new Promise(resolve=>setTimeout(resolve,180));},
    open(type='OPEN_QUICK_REPLY'){let result; messageListener({type}, {id:'test'}, r=>result=r);return result;},
    boot, tick(ms=0){now += ms; intervals.filter(Boolean).forEach(fn=>fn());},reinject(){return w.eval(source);},listenerCount(){return listenerCount;},
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

// v2: only a trusted click on X's reply control auto-sends, after a countdown.
const timeline = (id='123', text='一起讨论这个想法？') => `<article data-testid="tweet"><a href="/someone/status/${id}"><time>now</time></a><div data-testid="tweetText">${text}</div><button data-testid="reply">Reply</button></article>`;
const flush = (ms=0) => new Promise(resolve=>setTimeout(resolve,ms));
const oneClickResponse = (extra={}) => () => ({ok:true,oneClickReply:true,oneClickCountdownSeconds:10,candidates:[{id:'c1',text:'先聊这个。'},{id:'c2',text:'可以具体说说。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8},...extra});
function autoApp(options={}) {
  const a=app({html:timeline(),url:'https://x.com/home',oneClickReply:true,trustedClicks:true,response:oneClickResponse(),...options});
  const sends=[];
  a.openReply=async()=>{
    a.w.document.querySelector('[data-testid="reply"]').click();
    await flush();
    const dialog=a.w.document.createElement('div'); dialog.setAttribute('role','dialog');
    dialog.innerHTML=`${post('123','一起讨论这个想法？')}${editor}<button data-testid="tweetButton">Reply</button>`;
    a.w.document.body.append(dialog);
    dialog.querySelector('[data-testid="tweetButton"]').onclick=()=>{sends.push(a.editor().textContent);a.editor().textContent='';};
    a.tick();
    await flush(200);
  };
  a.editor=()=>a.w.document.querySelector('[role="dialog"] [role="textbox"]');
  a.sends=sends;
  a.countdown=()=>a.w.document.querySelector('[data-role="countdown"]');
  return a;
}

test('trusted reply click auto-generates, fills the selected candidate and sends once after the countdown', async () => {
  const a=autoApp();
  try {
    await a.openReply();
    assert.equal(a.calls.length,1);
    assert.equal(a.editor().textContent,'先聊这个。');
    assert.ok(a.countdown(),a.status());
    assert.equal(a.w.document.querySelector('[data-role="countdown-seconds"]').textContent,'10');
    assert.match(a.status(),/将在 10 秒后发送/);
    a.tick(9999);
    assert.deepEqual(a.sends,[]);
    a.tick(1);
    assert.deepEqual(a.sends,['先聊这个。']);
    a.tick(100);
    assert.match(a.status(),/回复已发送/);
    a.tick(20000);
    assert.equal(a.sends.length,1);
    assert.equal(a.calls.length,1);
  } finally {a.close();}
});

test('the configured countdown length is used', async () => {
  const a=autoApp({oneClickCountdownSeconds:3,response:oneClickResponse({oneClickCountdownSeconds:3})});
  try {
    await a.openReply();
    assert.equal(a.w.document.querySelector('[data-role="countdown-seconds"]').textContent,'3');
    a.tick(2999); assert.equal(a.sends.length,0);
    a.tick(1); assert.equal(a.sends.length,1);
  } finally {a.close();}
});

test('untrusted reply clicks, a disabled switch, or an expired trigger never auto-generate', async () => {
  const untrusted=autoApp({trustedClicks:false});
  try { await untrusted.openReply(); assert.equal(untrusted.calls.length,0); assert.equal(untrusted.countdown(),null); } finally {untrusted.close();}
  const off=autoApp({oneClickReply:false});
  try { await off.openReply(); assert.equal(off.calls.length,0); assert.equal(off.editor().textContent,''); } finally {off.close();}
  const late=autoApp();
  try {
    late.w.document.querySelector('[data-testid="reply"]').click();
    await flush();
    late.tick(5001);
    const dialog=late.w.document.createElement('div'); dialog.setAttribute('role','dialog');
    dialog.innerHTML=`${post('123','一起讨论这个想法？')}${editor}`;
    late.w.document.body.append(dialog);
    late.tick(); await flush(200);
    assert.equal(late.calls.length,0);
  } finally {late.close();}
});

test('opening a reply dialog without a reply-button click does not auto-generate', async () => {
  const a=app({url:'https://x.com/compose/post',oneClickReply:true,trustedClicks:true,response:oneClickResponse()});
  try { a.tick(); await flush(200); assert.equal(a.calls.length,0); } finally {a.close();}
});

test('invalid stored countdown stops before generation', async () => {
  for (const value of [2,61,2.5,'10',null]) {
    const a=autoApp({oneClickCountdownSeconds:value});
    try { await a.openReply(); assert.equal(a.calls.length,0); assert.match(a.status(),/倒计时设置无效/); } finally {a.close();}
  }
});

test('cancel during the countdown keeps the draft and never sends', async () => {
  const a=autoApp();
  try {
    await a.openReply();
    a.w.document.querySelector('[data-action="cancel-send"]').click();
    a.tick(20000);
    assert.equal(a.sends.length,0);
    assert.equal(a.editor().textContent,'先聊这个。');
    assert.match(a.status(),/已取消自动发送/);
    assert.equal(a.countdown(),null);
  } finally {a.close();}
});

test('send-now sends immediately and only once', async () => {
  const a=autoApp();
  try {
    await a.openReply();
    a.w.document.querySelector('[data-action="send-now"]').click();
    assert.deepEqual(a.sends,['先聊这个。']);
    a.tick(20000);
    assert.equal(a.sends.length,1);
  } finally {a.close();}
});

test('editing the draft, closing the dialog, closing the panel or changing route cancels the send', async () => {
  const cases={
    edit:a=>{a.editor().textContent='我自己改一下';a.editor().dispatchEvent(new a.w.Event('input',{bubbles:true}));},
    dialog:a=>{a.w.document.querySelector('[role="dialog"]').remove();},
    panel:a=>{a.w.document.querySelector('[data-action="close"]').click();},
    route:a=>{a.w.history.pushState({},'', '/someone/status/999');}
  };
  for (const [name,act] of Object.entries(cases)) {
    const a=autoApp();
    try {
      await a.openReply();
      act(a);
      a.tick(); a.tick(20000);
      assert.equal(a.sends.length,0,name);
      assert.match(a.status(),/已取消自动发送/,name);
    } finally {a.close();}
  }
});

test('a hidden tab keeps counting down and still sends once', async () => {
  const a=autoApp();
  try {
    await a.openReply();
    Object.defineProperty(a.w.document,'visibilityState',{value:'hidden',configurable:true});
    Object.defineProperty(a.w.document,'hidden',{value:true,configurable:true});
    a.w.document.dispatchEvent(new a.w.Event('visibilitychange'));
    a.tick(10000);
    assert.deepEqual(a.sends,['先聊这个。']);
  } finally {a.close();}
});

test('choosing another candidate during the countdown replaces the draft and sends it immediately', async () => {
  const a=autoApp();
  try {
    await a.openReply();
    a.w.document.querySelector('[data-candidate="c2"]').click();
    await flush(200);
    assert.deepEqual(a.sends,['可以具体说说。']);
    a.tick(20000);
    assert.equal(a.sends.length,1);
  } finally {a.close();}
});

test('abstention after an auto trigger never fills or sends', async () => {
  const a=autoApp({response:oneClickResponse({decision:{selectedId:null,reviewRequired:true,confidence:0.2}})});
  try {
    await a.openReply();
    a.tick(20000);
    assert.equal(a.editor().textContent,'');
    assert.equal(a.sends.length,0);
    assert.match(a.status(),/未选择合适回复，未发送/);
  } finally {a.close();}
});

test('auto-sent reply hands confirmation to auto-like when it is enabled', async () => {
  const a=autoApp({response:oneClickResponse({autoLikeAfterReply:true})});
  try {
    await a.openReply();
    a.tick(10000);
    assert.equal(a.sends.length,1);
    assert.match(a.status(),/点赞/);
  } finally {a.close();}
});

// Real X changes the URL to /compose/post when the reply dialog opens; the
// route poll may notice that only after the new generation has started.
function openReplyLikeX(a, id, text) {
  a.w.document.querySelector(`[data-reply-for="${id}"]`).click();
  a.w.history.pushState({},'', '/compose/post');
  const dialog=a.w.document.createElement('div'); dialog.setAttribute('role','dialog');
  dialog.innerHTML=`${post(id,text)}${editor}<button data-testid="tweetButton">Reply</button>`;
  a.w.document.body.append(dialog);
  dialog.querySelector('[data-testid="tweetButton"]').onclick=()=>{
    a.sends.push(dialog.querySelector('[role="textbox"]').textContent);
    dialog.remove();
    a.w.history.pushState({},'', '/home');
  };
}
const twoPosts = () => ['123','456'].map(id => timeline(id, `帖子${id}`).replace('data-testid="reply"', `data-testid="reply" data-reply-for="${id}"`)).join('');

test('a generation started before the route poll notices /compose/post is not cancelled as stale', async () => {
  const a=autoApp({html:twoPosts()});
  try {
    openReplyLikeX(a,'123','帖子123');
    await flush(200);
    a.tick();
    await flush(200);
    assert.doesNotMatch(a.status(),/页面已切换/);
    assert.ok(a.countdown(),a.status());
    a.tick(10000);
    assert.deepEqual(a.sends,['先聊这个。']);
  } finally {a.close();}
});

test('a second reply after a completed auto-send starts cleanly', async () => {
  const a=autoApp({html:twoPosts()});
  try {
    openReplyLikeX(a,'123','帖子123');
    await flush(200); a.tick(); await flush(200);
    a.tick(10000); a.tick(100); a.tick(500);
    assert.equal(a.sends.length,1,a.status());
    openReplyLikeX(a,'456','帖子456');
    await flush(200); a.tick(); await flush(200);
    assert.doesNotMatch(a.status(),/页面已切换/);
    assert.equal(a.calls.length,2);
    assert.ok(a.countdown(),a.status());
    a.tick(10000);
    assert.equal(a.sends.length,2);
  } finally {a.close();}
});

test('a second reply after auto-send plus auto-like starts cleanly', async () => {
  const a=autoApp({html:twoPosts(),response:oneClickResponse({autoLikeAfterReply:true})});
  try {
    for (const tweet of a.w.document.querySelectorAll('[data-testid="tweet"]')) {
      const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
      like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Liked');};
      tweet.append(like);
    }
    openReplyLikeX(a,'123','帖子123');
    await flush(200); a.tick(); await flush(200);
    a.tick(10000); a.tick(100); a.tick(4001); a.tick(100);
    assert.equal(a.sends.length,1);
    assert.match(a.status(),/已自动点赞/);
    openReplyLikeX(a,'456','帖子456');
    await flush(200); a.tick(); await flush(200);
    assert.doesNotMatch(a.status(),/页面已切换/);
    assert.equal(a.calls.length,2);
    assert.ok(a.countdown(),a.status());
  } finally {a.close();}
});

test('panel button fills only, even with one-click enabled', async () => {
  const a=app({oneClickReply:true,trustedClicks:true,response:oneClickResponse()});
  try {
    let sent=0; a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>sent++;
    assert.equal(a.w.document.querySelector('[data-action="generate"]').textContent,'生成并填入回复');
    await a.generate();
    a.tick(20000);
    assert.equal(sent,0);
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent,'先聊这个。');
    assert.match(a.status(),/手动发送/);
  } finally {a.close();}
});

test('one-click setting does not auto-send private messages', async () => {
  const html='<div data-testid="DMConversation"><div data-testid="messageEntry">明天几点聊？</div><div data-testid="dmComposerTextInput" role="textbox" contenteditable="true"></div><button data-testid="tweetButton">发送</button></div>';
  const a=app({html,url:'https://x.com/messages/123',oneClickReply:true,response:()=>({ok:true,oneClickReply:true,candidates:[{id:'c1',text:'明天下午。'},{id:'c2',text:'晚点确认。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}})});
  try {
    let sent=0;a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>sent++;
    await a.generate();
    assert.equal(sent,0);
    assert.match(a.status(),/手动发送|已回填/);
  } finally {a.close();}
});

test('auto-like waits for a confirmed user send and verifies the like state', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'},{id:'c2',text:'可以具体说说。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}}),html:`<div role="dialog">${post('123','目标帖子')}<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><button data-testid="tweetButton">Reply</button></div>`});
  try {
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','44 Likes. Liked');};
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    await a.generate();
    assert.equal(like.dataset.testid,'like');
    const editor=a.w.document.querySelector('[role="textbox"]');
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{editor.textContent='';};
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    assert.equal(like.dataset.testid,'like');
    a.tick(); a.tick(4001);
    assert.equal(like.dataset.testid,'unlike');
    assert.equal(like.getAttribute('aria-label'),'44 Likes. Liked',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like uses a variable post-send delay before clicking', async () => {
  async function run(randomValue, beforeReadyMs) {
    const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}})});
    try {
      Object.defineProperty(a.w.Math, 'random', {value:()=>randomValue, configurable:true});
      const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
      like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Liked');};
      a.w.document.querySelector('[data-testid="tweet"]').append(like);
      await a.generate();
      const editorNode=a.w.document.querySelector('[role="textbox"]');
      a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{editorNode.textContent='';};
      a.w.document.querySelector('[data-testid="tweetButton"]').click();
      a.tick();
      assert.equal(like.dataset.testid,'like');
      a.tick(beforeReadyMs);
      assert.equal(like.dataset.testid,'like');
      a.tick(1);
      assert.equal(like.dataset.testid,'unlike',a.status());
    } finally {a.close();}
  }
  await run(0,1499);
  await run(0.99999,3999);
});

test('auto-like stays disabled unless the setting is explicitly enabled', async () => {
  const a=app({html:`<div role="dialog">${post('123','目标帖子')}<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div><button data-testid="tweetButton">Reply</button></div>`});
  try {
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    await a.generate();
    a.w.document.querySelector('[role="textbox"]').textContent='';
    a.w.document.querySelector('[data-testid="tweetButton"]').click(); a.tick(); a.tick(4001);
    assert.equal(like.dataset.testid,'like');
  } finally {a.close();}
});

test('auto-like also covers a manually typed public reply when the panel is open', async () => {
  const a=app({html:`<div role="dialog">${post('123','目标帖子')}${editor}<button data-testid="tweetButton">Reply</button></div>`});
  try {
    const storage={async get(){assert.equal(this,storage);return {autoLikeAfterReply:true};}};
    a.w.chrome.storage={local:storage};
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','Like');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Liked');};
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    const textbox=a.w.document.querySelector('[role="textbox"]'); textbox.textContent='手写回复';
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{textbox.textContent='';};
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    await new Promise(resolve=>setTimeout(resolve,0));
    a.tick(); a.tick(4001);
    assert.equal(textbox.textContent,'');
    assert.equal(like.dataset.testid,'unlike',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like relocates the target and ignores the count in the aria label', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}}),html:`<div role="dialog">${post('123','目标帖子')}${editor}<button data-testid="tweetButtonInline">Reply</button></div>`});
  try {
    const original=a.w.document.querySelector('[data-testid="tweet"]');
    const editorNode=a.w.document.querySelector('[role="textbox"]');
    const like=a.w.document.createElement('button'); like.setAttribute('aria-label','42,001 Likes. Like');
    like.onclick=()=>{like.setAttribute('aria-label','42,002 Likes. Liked');};
    original.append(like);
    await a.generate();
    a.w.document.querySelector('[data-testid="tweetButtonInline"]').onclick=()=>{
      editorNode.remove();
      original.remove();
      const replacement=a.w.document.createElement('article'); replacement.dataset.testid='tweet';
      replacement.innerHTML='<a href="https://x.com/someone/status/123?ref=timeline"></a>';
      const replacementLike=a.w.document.createElement('button'); replacementLike.setAttribute('aria-label','42,001 Likes. Like');
      replacementLike.onclick=()=>replacementLike.setAttribute('aria-label','42,002 Likes. Liked');
      replacement.append(replacementLike); a.w.document.body.append(replacement);
    };
    a.w.document.querySelector('[data-testid="tweetButtonInline"]').click();
    a.tick(); a.tick(4001);
    const replacement=a.w.document.querySelector('[data-testid="tweet"]');
    assert.equal(replacement.querySelector('[aria-label$="Liked"]').getAttribute('aria-label'),'42,002 Likes. Liked',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like reads a status link rendered beside the tweet wrapper', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}}),html:`<div role="dialog"><article data-testid="tweet"><a href="/z2810358647">作者</a><div data-testid="tweetText">目标帖子</div><button data-testid="like" aria-label="Like"></button></article><a href="/someone/status/123"><time>now</time></a>${editor}<button data-testid="tweetButton">Reply</button></div>`});
  try {
    const like=a.w.document.querySelector('[data-testid="like"]');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Liked');};
    await a.generate();
    const editorNode=a.w.document.querySelector('[role="textbox"]');
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{editorNode.textContent='';};
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    a.tick(); a.tick(4001);
    assert.equal(like.dataset.testid,'unlike',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like captures the original status link when the reply modal omits it', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}}),html:`<article data-testid="tweet"><a href="/someone/status/123"><time>now</time></a><button data-testid="reply">Reply</button></article><div role="dialog"><article data-testid="tweet"><a href="/z2810358647">作者</a><div data-testid="tweetText">目标帖子</div><button data-testid="like" aria-label="Like"></button></article>${editor}<button data-testid="tweetButton">Reply</button></div>`});
  try {
    const like=a.w.document.querySelector('[data-testid="like"]');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','Liked');};
    a.w.document.querySelector('[data-testid="reply"]').click();
    await a.generate();
    const editorNode=a.w.document.querySelector('[role="textbox"]');
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{editorNode.textContent='';};
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    a.tick(); a.tick(4001);
    assert.equal(like.dataset.testid,'unlike',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('auto-like survives the route change caused by closing the reply modal', async () => {
  const a=app({response:()=>({ok:true,autoLikeAfterReply:true,candidates:[{id:'c1',text:'先聊这个。'}],decision:{selectedId:'c1',reviewRequired:false,confidence:0.8}})});
  try {
    const like=a.w.document.createElement('button'); like.dataset.testid='like'; like.setAttribute('aria-label','43 Likes. Like');
    like.onclick=()=>{like.dataset.testid='unlike';like.setAttribute('aria-label','44 Likes. Liked');};
    a.w.document.querySelector('[data-testid="tweet"]').append(like);
    await a.generate();
    const editorNode=a.w.document.querySelector('[role="textbox"]');
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick=()=>{
      editorNode.remove();
      a.w.history.pushState({},'', '/home');
    };
    a.w.document.querySelector('[data-testid="tweetButton"]').click();
    a.tick(); a.tick(4001);
    assert.equal(like.dataset.testid,'unlike',a.status());
    assert.match(a.status(),/已自动点赞/);
  } finally {a.close();}
});

test('a pending auto-like marker is resumed on the original post page', () => {
  const a=app({url:'https://x.com/someone/status/123',html:post('123','原帖').replace('</article>','<button data-testid="unlike" aria-label="44 Likes. Liked"></button></article>'),pendingLikeMarker:{schema:'quick-reply.like.v1',url:'https://x.com/someone/status/123',createdAt:Date.now()}});
  try {
    a.tick();
    assert.match(a.status(),/此前已点赞/);
    assert.equal(a.w.sessionStorage.getItem('__xQuickReplyPendingLike.v1'),null);
  } finally {a.close();}
});

test('a malformed pending auto-like marker is cleared and reported', () => {
  const a=app({pendingLikeRaw:'not-json'});
  try {
    assert.equal(a.w.sessionStorage.getItem('__xQuickReplyPendingLike.v1'), null);
    assert.match(a.status(),/读取原帖点赞任务失败/);
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

test('replacement clears an existing draft before the paste event',async()=>{
  const a=app();
  try{
    const textbox=a.w.document.querySelector('[role="textbox"]');
    const events=[];
    a.w.document.addEventListener('keydown',event=>{
      if(event.target===textbox && event.key==='Backspace') events.push(`clear:${textbox.textContent}`);
    },true);
    a.w.document.addEventListener('paste',event=>{
      if(event.target===textbox) events.push(`paste:${textbox.textContent}`);
    },true);
    await a.generate();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    a.w.document.querySelector('[data-candidate="c2"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.deepEqual(events,['clear:','paste:','clear:你最想先讨论哪一部分？','paste:']);
    assert.equal(textbox.textContent,'可以具体说说你的想法吗？',a.status());
    assert.match(a.status(),/已回填/);
  }finally{a.close();}
});

test('replacement remains exact when the editor collapses selection on selectionchange',async()=>{
  const a=app({pasteHandler:(event,w)=>{
    event.preventDefault();
    const selection=w.getSelection();
    const range=selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(w.document.createTextNode(event.clipboardData.getData('text/plain')));
  }});
  try{
    const textbox=a.w.document.querySelector('[role="textbox"]');
    let collapsed=false;
    a.w.document.addEventListener('selectionchange',()=>{
      if(collapsed) return;
      collapsed=true;
      const selection=a.w.getSelection();
      selection.collapse(textbox,textbox.childNodes.length);
    });
    await a.generate();
    a.w.document.querySelector('[data-candidate="c2"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(textbox.textContent,'可以具体说说你的想法吗？',a.status());
    assert.match(a.status(),/已回填/);
  }finally{a.close();}
});

test('replacement selects current nodes when selectionchange rebuilds the editor',async()=>{
  const a=app({pasteHandler:(event,w)=>{
    event.preventDefault();
    const selection=w.getSelection();
    const range=selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(w.document.createTextNode(event.clipboardData.getData('text/plain')));
  }});
  try{
    const textbox=a.w.document.querySelector('[role="textbox"]');
    let rebuilt=false;
    a.w.document.addEventListener('selectionchange',()=>{
      if(rebuilt) return;
      rebuilt=true;
      const text=textbox.textContent;
      textbox.replaceChildren(a.w.document.createTextNode(text));
    });
    await a.generate();
    a.w.document.querySelector('[data-candidate="c2"]').click();
    a.w.document.querySelector('[data-action="fill"]').click();
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(textbox.textContent,'可以具体说说你的想法吗？',a.status());
    assert.match(a.status(),/已回填/);
  }finally{a.close();}
});

test('replacement resynchronizes the controlled editor internal selection',async()=>{
  let textbox;
  let internalSelection='full';
  let firstSelectionChange=true;
  const a=app({pasteHandler:(event,w)=>{
    event.preventDefault();
    const selection=w.getSelection();
    if(internalSelection==='end') selection.collapse(textbox,textbox.childNodes.length);
    const range=selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(w.document.createTextNode(event.clipboardData.getData('text/plain')));
  }});
  try{
    textbox=a.w.document.querySelector('[role="textbox"]');
    a.w.document.addEventListener('selectionchange',()=>{
      internalSelection=firstSelectionChange?'end':'full';
      firstSelectionChange=false;
    });
    await a.generate();
    assert.equal(textbox.textContent,'你最想先讨论哪一部分？',a.status());
    assert.match(a.status(),/已回填/);
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

test('a visible reply dialog on the home feed is treated as a public reply surface', async () => {
  const a=app({url:'https://x.com/home',html:''});
  try {
    const dialog=a.w.document.createElement('div'); dialog.setAttribute('role','dialog');
    dialog.innerHTML=post('123','首页目标帖子')+editor+'<button data-testid="tweetButton">Reply</button>';
    a.w.document.body.append(dialog);
    a.tick();
    assert.equal(a.panel().hidden,false);
    await a.generate();
    assert.equal(a.calls.length,1,a.status());
    assert.equal(dialog.querySelector('[role="textbox"]').textContent,'你最想先讨论哪一部分？');
  } finally {a.close();}
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
  // A compose dialog without a target post is the post scene: the reply panel
  // is not shown there, so nothing can borrow the background post.
  const compose = app({ html: `${post('999', 'background')}<div role="dialog">${editor}</div>` });
  try {
    assert.ok(compose.panel().querySelector('[data-action="post-batch"]'), compose.status());
    assert.equal(compose.panel().querySelector('[data-action="generate"]'), null);
    assert.equal(compose.calls.length, 0);
  } finally { compose.close(); }
  // A quote composer (editor before the quoted post) is still rejected by the reply flow.
  const quote = app({ html: `<div role="dialog">${editor}${post('123', 'quote')}</div>` });
  try { await quote.generate(); assert.equal(quote.calls.length, 0); assert.match(quote.status(), /回复|目标/); } finally { quote.close(); }
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

// ---- quick-post 发帖模式（合成 DOM；不代表真实 X 发帖框已验证）----
const composeEditor = '<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>';
const cacheItem = (id, text, used) => ({ id, text, checkNotes: ['发布前核实：机制属实'],
  sourceTopic: { id: 't3', title: '话题三' }, batchId: 'b1', createdAt: 1000, ...(used ? { usedAt: 2000 } : {}) });

function postApp({ items = [cacheItem('k1', '帖文一：你会怎么选？四选一。'), cacheItem('k2', '帖文二：说说你的边界。')], batchResponse } = {}) {
  return app({
    html: `<div role="dialog">${composeEditor}<button data-testid="tweetButton">Post</button></div>`,
    url: 'https://x.com/compose/post',
    response: (message) => {
      if (message.type === 'LIST_POST_CACHE') return { ok: true, items };
      if (message.type === 'GENERATE_POST_BATCH') return batchResponse || { ok: true, rejected: false,
        topics: [], decision: { selectedId: 't3', reviewRequired: false, confidence: 0.7 },
        selectedTopic: { id: 't3', title: '话题三' }, cache: items, cacheError: null, evicted: 0,
        candidates: items.map((item, i) => ({ id: `c${i + 1}`, text: item.text, checkNotes: item.checkNotes })) };
      if (message.type === 'POST_CACHE_OP') {
        return { ok: true, items: items.map((item) => item.id === message.id && message.op === 'mark'
          ? { ...item, usedAt: 3000 } : item) };
      }
      return { ok: true };
    }
  });
}

test('post mode fills one cached candidate into the compose box without sending', async () => {
  const a = postApp();
  try {
    assert.equal(a.open('OPEN_QUICK_POST').ok, true, a.status());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(a.panel().querySelector('[data-action="post-batch"]'), '发帖场景只显示发帖面板');
    assert.equal(a.panel().querySelector('[data-action="generate"]'), null, '发帖面板不混入回复组件');
    const fillButtons = a.panel().querySelectorAll('[data-action="post-fill"]');
    assert.equal(fillButtons.length, 2);
    let sent = 0;
    a.w.document.querySelector('[data-testid="tweetButton"]').onclick = () => sent++;
    fillButtons[0].click();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent, '帖文一：你会怎么选？四选一。');
    assert.equal(sent, 0);
    assert.match(a.status(), /已填入发帖框草稿/);
    assert.ok(a.calls.some((message) => message.type === 'POST_CACHE_OP' && message.op === 'mark' && message.id === 'k1'));
  } finally { a.close(); }
});

test('switching to another cached candidate swaps the draft and returns the previous one', async () => {
  const a = postApp();
  try {
    a.open('OPEN_QUICK_POST');
    await new Promise(resolve => setTimeout(resolve, 20));
    a.panel().querySelectorAll('[data-action="post-fill"]')[0].click();
    await new Promise(resolve => setTimeout(resolve, 600));
    // k1 is now marked as used, so the remaining fill button belongs to k2.
    const remaining = a.panel().querySelectorAll('[data-action="post-fill"]');
    assert.equal(remaining.length, 1);
    remaining[0].click();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(a.w.document.querySelector('[role="textbox"]').textContent, '帖文二：说说你的边界。');
    const ops = a.calls.filter((message) => message.type === 'POST_CACHE_OP').map((message) => message.op);
    assert.deepEqual(ops, ['mark', 'unmark', 'mark']);
    assert.equal(a.calls.filter((message) => message.type === 'POST_CACHE_OP' && message.op === 'unmark')[0].id, 'k1');
  } finally { a.close(); }
});

test('post batch loads the cache pool and never presents used items as fillable', async () => {
  const a = postApp({ items: [cacheItem('k1', '帖文一：你会怎么选？四选一。', true)] });
  try {
    a.open('OPEN_QUICK_POST');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(a.panel().querySelectorAll('[data-action="post-fill"]').length, 0);
    assert.match(a.panel().querySelector('[data-role="cache"]').textContent, /已发过/);
    a.w.document.querySelector('[data-action="post-batch"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(a.calls.some((message) => message.type === 'GENERATE_POST_BATCH'));
  } finally { a.close(); }
});

test('reply and post entries refuse the wrong scene instead of opening a mixed panel', async () => {
  const compose = postApp();
  try {
    const wrong = compose.open('OPEN_QUICK_REPLY');
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /发帖助手|发帖场景/);
  } finally { compose.close(); }
  const a = app();
  try {
    const wrong = a.open('OPEN_QUICK_POST');
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /发帖弹窗|compose/);
  } finally { a.close(); }
});

test('the panel offers the hot tweets board as an explicit second action', async () => {
  const a = postApp();
  try {
    a.open('OPEN_QUICK_POST');
    await new Promise(resolve => setTimeout(resolve, 20));
    const ghost = a.panel().querySelector('[data-action="post-batch-tweets"]');
    assert.ok(ghost, '需要显式的热门推文榜入口');
    assert.match(ghost.textContent, /热门推文榜/);
    ghost.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const batch = a.calls.find((message) => message.type === 'GENERATE_POST_BATCH');
    assert.equal(batch.source, 'tweets');
  } finally { a.close(); }
});
