// Real React 17 + Draft.js in jsdom; layout/clipboard APIs are simulated.
// This verifies framework state as well as DOM text, not the live X application.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {installClipboard}=require('./clipboard-fixture.cjs');
const wait=()=>new Promise(resolve=>setTimeout(resolve,400));

test('controlled Draft editor receives each candidate once and replaces its own draft',async()=>{
  const dom=new JSDOM('<body><div role="dialog"><article data-testid="tweet"><div data-testid="tweetText">合成测试帖子</div></article><div id="mount"></div></div></body>',{url:'https://x.com/compose/post',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  for(const key of ['window','document','Node','HTMLElement','Element','HTMLInputElement','HTMLTextAreaElement','MutationObserver','getComputedStyle']) globalThis[key]=key==='window'?w:w[key];
  Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});
  globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);
  globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
  // Node's MessageChannel otherwise leaves React 17's browser scheduler alive.
  globalThis.MessageChannel=undefined;
  const React=require('react');
  const ReactDOM=require('react-dom');
  w.React=React;
  w.ReactDOM=ReactDOM;
  const {Editor,EditorState}=require('draft-js');
  let current=EditorState.createEmpty();
  function Controlled(){
    const [state,setState]=React.useState(current);
    return React.createElement(Editor,{editorState:state,onChange:value=>{current=value;setState(value);},webDriverTestID:'tweetTextarea_0'});
  }
  w.Element.prototype.getClientRects=function(){return [{}];};
  // jsdom does not implement this reflected property used by React's onSelect.
  Object.defineProperty(w.HTMLElement.prototype,'contentEditable',{get(){return this.getAttribute('contenteditable')||'inherit';}});
  w.scrollTo=()=>{};
  installClipboard(w);
  w.chrome={runtime:{onMessage:{addListener(){},removeListener(){}},async sendMessage(){return {ok:true,candidates:[{id:'c1',text:'第一条合成回复。'},{id:'c2',text:'另一条合成回复。'}],decision:{selectedId:'c1',confidence:1,reviewRequired:false}};}},storage:{local:{async get(){return {oneClickReply:false,autoLikeAfterReply:false};}}}};
  let pastes=0,nativeWrites=0;
  w.document.addEventListener('paste',()=>pastes++,true);
  w.document.execCommand=()=>{nativeWrites++;throw Error('Native DOM insertion must not bypass the controlled editor');};
  ReactDOM.render(React.createElement(Controlled),w.document.getElementById('mount'));
  const status=()=>w.document.querySelector('[data-role="status"]').textContent;
  try{
    w.eval(fs.readFileSync(path.join(__dirname,'../extension/src/content.js'),'utf8'));
    w.document.querySelector('[data-action="generate"]').click();await wait();
    const editor=w.document.querySelector('[role="textbox"]');
    assert.equal(editor.textContent,'第一条合成回复。',status());
    assert.equal(current.getCurrentContent().getPlainText(),'第一条合成回复。');
    assert.equal(pastes,1);assert.equal(nativeWrites,0);
    w.document.querySelector('[data-candidate="c2"]').click();
    w.document.querySelector('[data-action="fill"]').click();await wait();
    assert.equal(editor.textContent,'另一条合成回复。',status());
    assert.equal(current.getCurrentContent().getPlainText(),'另一条合成回复。');
    assert.equal(pastes,2);
    w.document.querySelector('[data-action="fill"]').click();await wait();
    assert.equal(pastes,2,'same candidate must not issue another paste');
    assert.match(status(),/已回填/);
  }finally{
    w.__xQuickReplyRuntime?.dispose();
    ReactDOM.unmountComponentAtNode(w.document.getElementById('mount'));
    w.close();
  }
});
