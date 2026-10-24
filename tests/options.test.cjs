// Simulated Chrome storage; no browser or model calls are made by these tests.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {readScript}=require('./extension-fixture.cjs');
const reactRuntime=[
  fs.readFileSync(path.join(__dirname,'../extension/src/vendor/react.production.min.js'),'utf8'),
  fs.readFileSync(path.join(__dirname,'../extension/src/vendor/react-dom.production.min.js'),'utf8')
].join('\n');
async function app(settings={}, {getError,setError}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../extension/src/options.html'),'utf8'),{runScripts:'outside-only'});
  const w=dom.window,writes=[];
  w.chrome={storage:{local:{async get(){if(getError)throw Error(getError);return settings;},async set(value){if(setError)throw Error(setError);writes.push(JSON.parse(JSON.stringify(value)));}}}};
  w.eval(reactRuntime);w.eval(readScript('options.js'));
  await new Promise(resolve=>w.document.addEventListener('DOMContentLoaded',()=>setTimeout(resolve,0),{once:true}));
  return {w,writes,field:id=>w.document.getElementById(id),set(id,value){const node=w.document.getElementById(id);if(node.type==='checkbox'){if(node.checked!==value)node.click();}else{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set;setter.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));node.dispatchEvent(new w.Event('change',{bubbles:true}));}},async save(){w.document.getElementById('save').click();await new Promise(resolve=>setTimeout(resolve,0));},close(){w.close();}};
}
test('first use shows the chosen humorous prompt and saves the full edited preference',async()=>{
  const a=await app();
  try{
    assert.match(a.field('replyPrompt').value,/真实用户看到内容后顺手回一句/);
    assert.match(a.field('replyPrompt').value,/别拿痛处开玩笑/);
    assert.equal(a.field('autoLikeAfterReply').checked,false);
    assert.equal(a.field('oneClickReply').checked,false);
    a.set('replyPrompt','  随口聊天，不用表情，别劝坚持。  ');
    a.set('replyExamples','  这句我会回：先忙你的。  ');
    a.set('autoLikeAfterReply',true);
    a.set('oneClickReply',true);
    await a.save();
    assert.equal(a.writes.length,1);assert.equal(a.writes[0].replyPrompt,'随口聊天，不用表情，别劝坚持。');
    assert.equal(a.writes[0].replyExamples,'这句我会回：先忙你的。');
    assert.equal(a.writes[0].autoLikeAfterReply,true);
    assert.equal(a.writes[0].oneClickReply,true);
    assert.equal(a.writes[0].oneClickCountdownSeconds,10);
    assert.match(a.field('status').textContent,/下次生成生效/);
  }finally{a.close();}
});
test('one-click countdown is disabled while off and saves only 3-60 whole seconds',async()=>{
  const a=await app();
  try{
    assert.equal(a.field('oneClickCountdownSeconds').value,'10');
    assert.equal(a.field('oneClickCountdownSeconds').disabled,true);
    a.set('oneClickReply',true);
    assert.equal(a.field('oneClickCountdownSeconds').disabled,false);
    for(const value of ['','2','61','2.5','abc']){
      a.set('oneClickCountdownSeconds',value);await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/倒计时/);
    }
    a.set('oneClickCountdownSeconds','15');await a.save();
    assert.equal(a.writes.length,1);assert.equal(a.writes[0].oneClickCountdownSeconds,15);
  }finally{a.close();}
});
test('stored custom prompt is preserved; resetting requires an explicit save',async()=>{
  const a=await app({replyPrompt:'这是我保存的口吻。'});
  try{
    assert.equal(a.field('replyPrompt').value,'这是我保存的口吻。');
    a.field('resetPrompt').click();assert.equal(a.writes.length,0);
    assert.match(a.field('replyPrompt').value,/真实用户看到内容后顺手回一句/);
    await a.save();assert.equal(a.writes.length,1);
  }finally{a.close();}
});
test('invalid prompt or count is rejected instead of silently replaced or clamped',async()=>{
  const a=await app();
  try{
    for(const value of ['', ' ', '字'.repeat(3001)]){
      a.set('replyPrompt',value);await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/提示词/);
    }
    a.field('resetPrompt').click();
    a.set('replyExamples','字'.repeat(3001));await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/回复示例/);
    for(const value of ['','1','6','2.5']){
      a.set('candidateCount',value);await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/候选数量/);
    }
  }finally{a.close();}
});
test('storage read or write errors remain visible without reporting success',async()=>{
  const a=await app({}, {getError:'storage read failed'});
  try{assert.equal(a.field('save').disabled,true);assert.match(a.field('status').textContent,/读取设置失败/);assert.equal(a.writes.length,0);}finally{a.close();}
  const b=await app({}, {setError:'storage write failed'});
  try{await b.save();assert.match(b.field('status').textContent,/保存设置失败/);assert.equal(b.field('save').disabled,false);assert.equal(b.writes.length,0);}finally{b.close();}
});
