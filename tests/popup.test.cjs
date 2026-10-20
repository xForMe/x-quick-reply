// Explicit Chrome API test doubles: no browser permissions or model calls are exercised here.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const reactRuntime=[
  fs.readFileSync(path.join(__dirname,'../extension/src/vendor/react.production.min.js'),'utf8'),
  fs.readFileSync(path.join(__dirname,'../extension/src/vendor/react-dom.production.min.js'),'utf8')
].join('\n');
const source=fs.readFileSync(path.join(__dirname,'../extension/src/popup.js'),'utf8');
async function clickOpen({scriptError, messageError, response={ok:true}, bootstrapResult={ok:true,version:'0.4.4'}}={}) {
  const dom=new JSDOM('<div id="app"></div>',{runScripts:'outside-only'});
  const w=dom.window, calls=[];
  let injected=false, closed=false;
  const dispose=w.close.bind(w);
  w.close=()=>{closed=true;};
  w.chrome={runtime:{openOptionsPage(){}}, tabs:{async query(){return [{id:123,url:'https://x.com/compose/post'}];},async sendMessage(id,message){calls.push(['message',id,message]);if(messageError)throw new Error(messageError);if(!injected)throw new Error('Could not establish connection. Receiving end does not exist.');return response;}},
    scripting:{async executeScript(options){calls.push(['script',options]);if(scriptError)throw new Error(scriptError);injected=true;return [{frameId:0,result:bootstrapResult}];},async insertCSS(options){calls.push(['css',options]);}}};
  w.eval(reactRuntime);w.eval(source);w.document.getElementById('open').click();
  await new Promise(resolve=>setTimeout(resolve,10));
  const result={calls,closed,status:w.document.getElementById('status').textContent};
  dispose();
  return result;
}
test('click initializes current document before messaging, including after an extension reload',async()=>{
  const a=await clickOpen();
  assert.equal(a.closed,true,a.status);
  assert.deepEqual(a.calls.map(c=>c[0]),['script','css','message']);
  assert.deepEqual(Array.from(a.calls[0][1].files),['src/vendor/react.production.min.js','src/vendor/react-dom.production.min.js','src/content.js']);
});
test('injection failure stops and exposes actual stage and error without retry',async()=>{
  const a=await clickOpen({scriptError:'Cannot access contents of the page. Extension manifest must request permission.'});
  assert.equal(a.closed,false);assert.deepEqual(a.calls.map(c=>c[0]),['script']);
  assert.match(a.status,/注入/);assert.match(a.status,/Cannot access/);
});
test('content startup or message error is not disguised as reload advice',async()=>{
  const a=await clickOpen({bootstrapResult:{ok:false,error:'startup rejected'}});
  assert.equal(a.closed,false);assert.match(a.status,/startup rejected/);assert.equal(a.calls.length,1);
  const b=await clickOpen({messageError:'The message port closed before a response was received.'});
  assert.equal(b.closed,false);assert.match(b.status,/message port closed/);
});

test('an invalidated popup connection gives a refresh instruction without retrying',async()=>{
  const a=await clickOpen({messageError:'Extension context invalidated.'});
  assert.equal(a.closed,false);assert.match(a.status,/刷新 X 页面/);
  assert.doesNotMatch(a.status,/Extension context invalidated/);
  assert.equal(a.calls.length,3);
});

test('actual popup and actual content script connect on an already open reply page',async()=>{
  const content=`${reactRuntime}\n${fs.readFileSync(path.join(__dirname,'../extension/src/content.js'),'utf8')}`;
  const page=new JSDOM('<aside id="quick-reply-panel">stale</aside><div role="dialog"><article data-testid="tweet"><a href="/user/status/123">now</a><div data-testid="tweetText">这是目标帖子</div></article><div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div></div>',{url:'https://x.com/compose/post',runScripts:'outside-only'});
  const popup=new JSDOM('<div id="app"></div>',{runScripts:'outside-only'});
  const disposePopup=popup.window.close.bind(popup.window);
  let listener, closed=false;
  const htmlDescriptor=Object.getOwnPropertyDescriptor(page.window.Element.prototype,'innerHTML');
  page.window.Element.prototype.getClientRects=()=>[{}];
  Object.defineProperty(page.window.Element.prototype,'innerHTML',{set(){throw new TypeError('TrustedHTML required');}});
  page.window.chrome={runtime:{onMessage:{addListener(fn){listener=fn;},removeListener(fn){if(listener===fn)listener=null;}}}};
  popup.window.chrome={runtime:{},scripting:{async executeScript(){return [{frameId:0,result:page.window.eval(content)}];},async insertCSS(){}},tabs:{async query(){return [{id:7,url:'https://x.com/compose/post'}];},async sendMessage(_id,message){return new Promise(resolve=>listener(message,{},resolve));}}};
  popup.window.close=()=>{closed=true;};
  try {
    popup.window.eval(reactRuntime);popup.window.eval(source);popup.window.document.getElementById('open').click();
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(closed,true,popup.window.document.getElementById('status').textContent);
    assert.equal(page.window.document.querySelectorAll('#quick-reply-panel').length,1);
    assert.equal(page.window.document.getElementById('quick-reply-panel').hidden,false);
    assert.match(page.window.document.querySelector('[data-role="status"]').textContent,/已识别/);
  } finally {
    Object.defineProperty(page.window.Element.prototype,'innerHTML',htmlDescriptor);page.window.close();
    disposePopup();
  }
});
