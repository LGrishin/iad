#!/usr/bin/env node
/** Offline browser integration for every supplied compiled IAD; no npm dependencies. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const file=process.argv[2] && path.resolve(process.argv[2]);
if(!file){console.error('Usage: node tests/comparison-browser.mjs /path/to/comparison/build/index.html');process.exit(2);}
const chromePath=process.env.IAD_CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const groups=[],browserErrors=[],report={status:'running',groups,browserErrors,screenshots:[]};
const reportPath=process.env.IAD_BROWSER_REPORT || path.join(tmpdir(),'iad-comparison-browser-report.json');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let chrome,profile,websocket,sessionId,browserVersion,stderrTail='',serial=0;
const pending=new Map();
function cdp(method,params={},session=sessionId) {
 return new Promise((resolve,reject)=>{
  const id=++serial;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},20000);
  pending.set(id,{resolve,reject,timer});
  websocket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));
 });
}
async function evaluate(expression) {
 const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
 return result.result.value;
}
async function ready(){
 for(let i=0;i<100;i++){
  try{if(await evaluate('Boolean(window.IADComparison && IADComparison.getState().ready.before && IADComparison.getState().ready.after)'))return;}catch{}
  await pause(100);
 }
 throw new Error('IAD comparison did not initialize');
}
async function reload(){await cdp('Page.reload',{ignoreCache:true});await pause(100);await ready();}
async function state(){return evaluate('window.IADComparison.getState()');}
async function click(selector,{dom=false}={}){
 const encoded=JSON.stringify(selector);
 if(dom){
  const found=await evaluate(`(()=>{const e=document.querySelector(${encoded});if(!e)return false;e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return true})()`);
  assert.ok(found,`Missing DOM click target: ${selector}`);await pause(35);return;
 }
 let box;
 for(let attempt=0;attempt<3;attempt++){
  box=await evaluate(`(async()=>{let e=document.querySelector(${encoded});if(!e)throw Error('Missing click target '+${encoded});if(e.disabled)throw Error('Disabled click target '+${encoded});e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));e=document.querySelector(${encoded});if(!e)throw Error('Click target disappeared '+${encoded});const b=e.getBoundingClientRect(),candidates=[{x:b.x+b.width/2,y:b.y+b.height/2},{x:b.x+Math.min(12,b.width/2),y:b.y+Math.min(12,b.height/2)},{x:b.x+b.width/2,y:b.bottom-Math.min(12,b.height/2)}];for(const p of candidates){const hit=document.elementFromPoint(p.x,p.y);if(b.width>0&&b.height>0&&hit&&(e===hit||e.contains(hit)))return {...p,valid:true};}const p=candidates[0],hit=document.elementFromPoint(p.x,p.y);return {valid:false,box:{x:b.x,y:b.y,w:b.width,h:b.height},hit:hit?hit.tagName+'#'+hit.id+'.'+hit.className:null,closedAncestors:[...function*(n){while(n){if(n.matches?.('details')&&!n.open)yield n.dataset.disclosure||n.className;n=n.parentElement}}(e)],selector:${encoded}}})()`);
  if(box.valid)break;
  await pause(60);
 }
 assert.ok(box.valid,`Click target is hidden or covered: ${JSON.stringify(box)}`);
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
 await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1});
 await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1});
 await pause(35);
}
async function seek(value){await evaluate(`(()=>{const e=document.getElementById('scrubber');e.value=${Number(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(30);}
async function selectScenario(id){await click(`[data-scenario=${JSON.stringify(id)}]`);}
async function setSpeed(value){await evaluate(`(()=>{const e=document.getElementById('speed');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function until(predicate,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){if(await predicate())return;await pause(100);}throw new Error('Timed out waiting for browser state');}
async function group(name,run){try{const details=await run();groups.push({name,status:'passed',...(details?{details}:{})});console.log(`PASS ${name}`);}catch(error){const failureScreenshot=path.join(tmpdir(),'iad-comparison-failure-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,70)+'.png');try{await screenshot(failureScreenshot);}catch{}groups.push({name,status:'failed',error:error.message,failureScreenshot});console.log(`FAIL ${name}: ${error.message}`);}}
async function screenshot(destination){const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(destination,Buffer.from(result.data,'base64'));report.screenshots.push(destination);}
async function dimensions(width,height,mobile=false){await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:height});}

try {
 profile=await mkdtemp(path.join(tmpdir(),'iad-comparison-chrome-'));
 const debuggerUrl=new Promise((resolve,reject)=>{
  chrome=spawn(chromePath,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const timeout=setTimeout(()=>reject(new Error(`Chrome debugger did not start. ${stderrTail}`)),15000);
  chrome.once('error',error=>{clearTimeout(timeout);reject(error);});
  chrome.once('exit',(code,signal)=>{clearTimeout(timeout);reject(new Error(`Chrome exited before debugger: code=${code} signal=${signal}. ${stderrTail}`));});
  chrome.stderr.on('data',data=>{stderrTail=(stderrTail+data.toString()).slice(-12000);const match=stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
 });
 const url=await debuggerUrl;
 websocket=new WebSocket(url);
 await new Promise((resolve,reject)=>{websocket.addEventListener('open',resolve,{once:true});websocket.addEventListener('error',reject,{once:true});});
 websocket.addEventListener('message',event=>{
  const message=JSON.parse(event.data);
  if(message.id){const task=pending.get(message.id);if(!task)return;clearTimeout(task.timer);pending.delete(message.id);if(message.error)task.reject(new Error(message.error.message));else task.resolve(message.result);return;}
  if(message.method==='Runtime.exceptionThrown') browserErrors.push({type:'exception',text:message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text});
  if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')browserErrors.push({type:'console.error',text:message.params.args.map(a=>a.value||a.description).join(' ')});
 });
 browserVersion=await cdp('Browser.getVersion',{},null);report.browser=browserVersion.product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},null);
 sessionId=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
 await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Network.enable');
 await cdp('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await readFile(file);await dimensions(1600,1000);
 await cdp('Page.navigate',{url:pathToFileURL(file).href});await ready();
 const payload=await evaluate("JSON.parse(document.getElementById('iad-comparison-data').textContent)"),{config,models}=payload;
 const frameExpression=side=>`document.getElementById(${JSON.stringify('frame-'+side)}).contentWindow`;
 const innerState=side=>evaluate(`${frameExpression(side)}.IADViewer.getState()`);
 const stable=value=>({scenario:value.scenario,step:value.step,index:value.index,choices:value.choices,expanded:value.expanded,playing:value.playing});
 const comparisonError=()=>evaluate('document.getElementById("comparison-error").hidden?null:document.getElementById("comparison-error").textContent');
 const scenarioChange=async id=>{
  await evaluate(`(()=>{const e=document.getElementById('scenario-select');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(async()=>{const s=await state();return s.scenario===id;});
 };
 await group('Comparison: offline file initializes both exact versions and defaults to after',async()=>{
  const status=await state();assert.equal(status.side,'after');assert.deepEqual(status.ready,{before:true,after:true});
  assert.equal(await evaluate('document.getElementById("tab-after").getAttribute("aria-selected")'),'true');
  assert.equal(await evaluate('document.getElementById("frame-before").hidden'),true);
  assert.equal(await evaluate('document.getElementById("frame-after").hidden'),false);
  assert.equal(await evaluate('document.querySelectorAll("[data-change]").length'),config.changes.length);
  assert.equal(await evaluate('document.querySelectorAll("#scenario-select option").length'),new Set([...models.before.scenarios,...models.after.scenarios].map(s=>s.id)).size);
  const revisions=await evaluate('document.getElementById("revisions").textContent');
  for(const side of ['before','after']){
   assert.ok(revisions.includes(models[side].manifest.revision));
   assert.equal(await evaluate(`${frameExpression(side)}.IAD.getManifest().revision`),models[side].manifest.revision);
   assert.equal(await evaluate(`document.getElementById(${JSON.stringify('frame-'+side)}).hasAttribute('src')`),false);
  }
  assert.notEqual(models.before.manifest.revision,models.after.manifest.revision);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await screenshot(path.join(tmpdir(),'iad-comparison-overview.png'));
 });
 await group('Comparison: native version tabs preserve scenario positions',async()=>{
  const before=stable(await innerState('before')),after=stable(await innerState('after'));
  await click('#tab-before');await until(async()=>(await state()).side==='before');
  assert.equal(await evaluate('document.getElementById("frame-before").hidden'),false);
  assert.equal(await evaluate('document.getElementById("frame-after").hidden'),true);
  await click('#tab-after');await until(async()=>(await state()).side==='after');
  assert.deepEqual(stable(await innerState('before')),before);assert.deepEqual(stable(await innerState('after')),after);
 });
 const diff=await evaluate('IADComparison.getDiff()');
 await group('Comparison: every first divergence navigates each map to its actual branch',async()=>{
  let changed=0;
  for(const scenario of diff.scenarios){
   await scenarioChange(scenario.id);
   if(!scenario.firstDivergence){assert.equal(await evaluate('document.getElementById("first-divergence").disabled'),true);continue;}
   changed++;
   await click('#first-divergence');await pause(80);
   for(const side of ['before','after']){
    const entry=scenario.firstDivergence[side];if(!entry)continue;
    await until(async()=>(await innerState(side)).step===entry.step.id);
    const current=await innerState(side);assert.equal(current.scenario,scenario.id);assert.equal(current.step,entry.step.id);
    for(const [key,value] of Object.entries(entry.choices || {}))assert.equal(current.choices[key],value);
    assert.equal(current.playing,false);
   }
   assert.equal(await comparisonError(),null);
  }
  assert.ok(changed>0,'At least one architectural scenario must differ');return {changedScenarios:changed};
 });
 await group('Comparison: scenario return preserves progress and inner sidebar synchronizes the wrapper',async()=>{
  const common=diff.scenarios.filter(s=>models.before.scenarios.some(t=>t.id===s.id)&&models.after.scenarios.some(t=>t.id===s.id));if(common.length<2)return {skipped:'Needs two common scenarios; remaining browser checks still run.'};
  await scenarioChange(common[0].id);await evaluate('IADComparison.jumpToDivergence()');
  const saved=Object.fromEntries(await Promise.all(['before','after'].map(async side=>[side,stable(await innerState(side))])));
  await scenarioChange(common[1].id);await evaluate('IADComparison.jumpToDivergence()');await scenarioChange(common[0].id);
  for(const side of ['before','after'])assert.deepEqual(stable(await innerState(side)),saved[side]);
  await evaluate('IADComparison.selectSide("after")');
  await evaluate(`${frameExpression('after')}.document.querySelector('[data-scenario='+${JSON.stringify(JSON.stringify(common[1].id))}+']').click()`);
  await until(async()=>(await state()).scenario===common[1].id);
  assert.equal((await innerState('before')).scenario,common[1].id);assert.equal((await innerState('after')).scenario,common[1].id);
 });
 await group('Comparison: change cards select context and open pinned offline source on both sides',async()=>{
  for(const change of config.changes){
   await click(`[data-change=${JSON.stringify(change.id)}]`);await until(async()=>(await state()).selectedChange===change.id);
   assert.equal((await state()).scenario,change.scenarioId);
   const card=`[data-change-card=${JSON.stringify(change.id)}]`;
   if(!await evaluate(`document.querySelector(${JSON.stringify(card+' details')}).open`))await click(card+' details > summary');
   for(const side of ['before','after']){
    const ref=models[side].evidence.find(e=>e.id===change[side+'Sources'][0]);assert.ok(ref);
    const source=`${card} [data-source-side=${JSON.stringify(side)}][data-source-id=${JSON.stringify(ref.id)}]`;
    const previous=stable(await innerState(side));await click(source);
    await until(()=>evaluate(`${frameExpression(side)}.document.getElementById('modal').open`));
    assert.equal((await state()).side,side);
    const metadata=await evaluate(`${frameExpression(side)}.document.querySelector('.source-meta').textContent`);
    for(const text of [ref.revision,ref.repo,ref.path,ref.sourceIntegrity.status])assert.ok(metadata.includes(text),text);
    assert.equal(await evaluate(`${frameExpression(side)}.document.querySelector('.code-line.target .line-no').textContent`),String(ref.line));
    const expected=await evaluate(`(()=>{const w=${frameExpression(side)},sources=JSON.parse(w.document.getElementById('iad-sources').textContent);return sources[${JSON.stringify(ref.sourceKey)}].text.split('\\n')[${ref.line-1}]})()`);
    assert.equal(await evaluate(`${frameExpression(side)}.document.querySelector('.code-line.target').children[1].textContent`),expected);
    if(ref.url)assert.equal(await evaluate(`${frameExpression(side)}.document.querySelector('.source-meta a').href`),ref.url);
    await evaluate(`${frameExpression(side)}.document.querySelector('[data-full-source]').click()`);
    assert.ok((await evaluate(`${frameExpression(side)}.document.querySelectorAll('.code-line').length`))>=ref.line);
    await evaluate(`${frameExpression(side)}.document.getElementById('close-modal').click()`);
    assert.deepEqual(stable(await innerState(side)),previous);
   }
  }
 });
 await group('Comparison: change question copies both revisions and has a manual fallback',async()=>{
  const change=config.changes[0],card=`[data-change-card=${JSON.stringify(change.id)}]`;
  if(!await evaluate(`document.querySelector(${JSON.stringify(card+' details')}).open`))await click(card+' details > summary');
  const initial=await state();
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedComparison=text}}})");
  await click(`${card} [data-copy-change]`);
  const copied=await evaluate('window.__copiedComparison');assert.ok(copied.includes(change.title));assert.match(copied,/Вопрос:\s*$/);
  for(const side of ['before','after'])assert.ok(copied.includes(models[side].manifest.revision));
  assert.deepEqual(await state(),initial);
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied')}}});document.execCommand=()=>false");
  await click(`${card} [data-copy-change]`);
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(card+' .copy-status')}).textContent`)).includes('Ctrl+C'));
  assert.deepEqual(await state(),initial);
 });
 await group('Viewer: invalid local navigation leaves both iframe states unchanged',async()=>{
  for(const side of ['before','after']){
   const result=await evaluate(`(()=>{const api=${frameExpression(side)}.IADViewer,before=api.getState();let failure;try{api.navigateTo({scenario:before.scenario,stepId:'__missing_comparison_step__'})}catch(error){failure=error.code||error.message}return {before,after:api.getState(),failure}})()`);
   assert.ok(result.failure);assert.deepEqual(result.after,result.before);
  }
 });
 await group('Comparison: responsive mobile layout and tabs stay usable',async()=>{
  await dimensions(390,844,true);await reload();
  assert.equal((await state()).side,'after');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await click('#tab-before');await until(async()=>(await state()).side==='before');
  assert.ok((await evaluate('document.getElementById("frame-before").getBoundingClientRect().width'))<=390);
  assert.equal(await evaluate(`${frameExpression('before')}.document.documentElement.scrollWidth>${frameExpression('before')}.innerWidth`),false);
  await evaluate('window.scrollTo(0,0)');await screenshot(path.join(tmpdir(),'iad-comparison-mobile.png'));
 });
 await group('Browser: no comparison errors or uncaught script exceptions',async()=>{
  assert.deepEqual(browserErrors,[]);assert.equal(await comparisonError(),null);
 });
 report.status=groups.some(g=>g.status==='failed')?'failed':'passed';
} catch(error) {report.status='failed';report.startupError=error.stack;console.error(error.stack);}
finally {
 report.passed=groups.filter(g=>g.status==='passed').length;report.failed=groups.filter(g=>g.status==='failed').length;
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
 if(websocket?.readyState===WebSocket.OPEN){try{await cdp('Browser.close',{},null);}catch{}websocket.close();}
 if(chrome&&!chrome.killed)chrome.kill('SIGTERM');
 for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error('Browser check complete'));}pending.clear();
 if(profile){await pause(300);await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});}
 console.log(`${report.passed}/${groups.length} comparison browser groups passed; report: ${reportPath}`);process.exitCode=report.status==='passed'?0:1;
}
