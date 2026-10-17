// Simulated Chrome storage; no browser or model calls are made by these tests.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {readScript}=require('./extension-fixture.cjs');
async function app(settings={}, {getError,setError}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../extension/src/options.html'),'utf8'),{runScripts:'outside-only'});
  const w=dom.window,writes=[];
  w.chrome={storage:{local:{async get(){if(getError)throw Error(getError);return settings;},async set(value){if(setError)throw Error(setError);writes.push(JSON.parse(JSON.stringify(value)));}}}};
  w.eval(readScript('options.js'));
  await new Promise(resolve=>w.document.addEventListener('DOMContentLoaded',()=>setTimeout(resolve,0),{once:true}));
  return {w,writes,field:id=>w.document.getElementById(id),async save(){w.document.getElementById('save').click();await new Promise(resolve=>setTimeout(resolve,0));},close(){w.close();}};
}
test('first use shows the chosen humorous prompt and saves the full edited preference',async()=>{
  const a=await app();
  try{
    assert.match(a.field('replyPrompt').value,/真实用户看到内容后顺手回一句/);
    assert.match(a.field('replyPrompt').value,/别拿痛处开玩笑/);
    a.field('replyPrompt').value='  随口聊天，不用表情，别劝坚持。  ';
    a.field('replyExamples').value='  这句我会回：先忙你的。  ';
    await a.save();
    assert.equal(a.writes.length,1);assert.equal(a.writes[0].replyPrompt,'随口聊天，不用表情，别劝坚持。');
    assert.equal(a.writes[0].replyExamples,'这句我会回：先忙你的。');
    assert.match(a.field('status').textContent,/下次生成生效/);
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
      a.field('replyPrompt').value=value;await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/提示词/);
    }
    a.field('resetPrompt').click();
    a.field('replyExamples').value='字'.repeat(3001);await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/回复示例/);
    for(const value of ['','1','6','2.5']){
      a.field('candidateCount').value=value;await a.save();assert.equal(a.writes.length,0);assert.match(a.field('status').textContent,/候选数量/);
    }
  }finally{a.close();}
});
test('storage read or write errors remain visible without reporting success',async()=>{
  const a=await app({}, {getError:'storage read failed'});
  try{assert.equal(a.field('save').disabled,true);assert.match(a.field('status').textContent,/读取设置失败/);assert.equal(a.writes.length,0);}finally{a.close();}
  const b=await app({}, {setError:'storage write failed'});
  try{await b.save();assert.match(b.field('status').textContent,/保存设置失败/);assert.equal(b.field('save').disabled,false);assert.equal(b.writes.length,0);}finally{b.close();}
});
