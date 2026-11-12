#!/usr/bin/env node
/** Offline browser integration for every supplied compiled IAD; no npm dependencies. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const files=process.argv.slice(2).map(f=>path.resolve(f));
if(!files.length)throw new Error('Usage: node tests/browser.mjs COMPILED_INDEX_HTML [COMPILED_INDEX_HTML ...]. Use python3 tests/smoke.py --browser for temporary fixtures.');
const chromePath=process.env.IAD_CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const groups=[],browserErrors=[],report={status:'running',groups,browserErrors,screenshots:[]};
const reportPath=process.env.IAD_BROWSER_REPORT || path.join(tmpdir(),'iad-kit-browser-report.json');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let chrome,profile,syntheticDirectory,websocket,sessionId,browserVersion,stderrTail='',serial=0;
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
  try{if(await evaluate('Boolean(window.IAD && window.IADViewer && document.querySelector("[data-scenario]"))'))return;}catch{}
  await pause(100);
 }
 throw new Error('IAD did not initialize');
}
async function reload(){await cdp('Page.reload',{ignoreCache:true});await pause(100);await ready();}
async function state(){return evaluate('window.IADViewer.getState()');}
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
async function group(name,run){try{const details=await run();groups.push({name,status:'passed',...(details?{details}:{})});console.log(`PASS ${name}`);}catch(error){const failureScreenshot=path.join(tmpdir(),'iad-kit-failure-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,70)+'.png');try{await screenshot(failureScreenshot);}catch{}groups.push({name,status:'failed',error:error.message,failureScreenshot});console.log(`FAIL ${name}: ${error.message}`);}}
async function screenshot(destination){const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(destination,Buffer.from(result.data,'base64'));report.screenshots.push(destination);}
async function dimensions(width,height,mobile=false){await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:height});}
async function openSynthetic(name,changeModel,changeSources=null) {
 const html=await readFile(files.at(-1),'utf8'),pattern=/(<script id="iad-model" type="application\/json">)([\s\S]*?)(<\/script>)/;
 const match=html.match(pattern);assert.ok(match);const model=JSON.parse(match[2]);changeModel(model);
 const encode=value=>JSON.stringify(value).replace(/</g,'\\u003c');
 let compiled=html.replace(pattern,(_all,before,_data,after)=>before+encode(model)+after);
 if(changeSources)compiled=compiled.replace(/(<script id="iad-sources" type="application\/json">)([\s\S]*?)(<\/script>)/,(_all,before,data,after)=>{
  const sources=JSON.parse(data);changeSources(sources,model);return before+encode(sources)+after;
 });
 if(!syntheticDirectory)syntheticDirectory=await mkdtemp(path.join(tmpdir(),'iad-kit-browser-fixtures-'));
 const destination=path.join(syntheticDirectory,name+'.html');await writeFile(destination,compiled);
 await dimensions(1600,1000);const started=Date.now();await cdp('Page.navigate',{url:pathToFileURL(destination).href});await ready();
 return {model,loadMilliseconds:Date.now()-started};
}

try {
 profile=await mkdtemp(path.join(tmpdir(),'iad-kit-chrome-'));
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
 for (const file of files) {
  await readFile(file);
  await dimensions(1600,1000);
  await cdp('Page.navigate',{url:pathToFileURL(file).href});await ready();
  const model=await evaluate("JSON.parse(document.getElementById('iad-model').textContent)");
  const name=model.manifest.target.name, prefix=model.manifest.target.id;
  const selector=(attribute,value)=>`[${attribute}=${JSON.stringify(value)}]`;
  await group(`${prefix}: offline initialization and generic configuration`,async()=>{
   assert.equal(await evaluate('document.title'),`${name} · IAD`);
   assert.equal(await evaluate('document.querySelectorAll("[data-scenario]").length'),model.scenarios.length);
   assert.equal((await state()).scenario,model.view?.initialScenario || model.scenarios[0].id);
   assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
   assert.equal(await evaluate('IAD.compareSnapshots(IAD.buildSnapshot(),IAD.buildSnapshot()).changes.length'),0);
   await click('#about');assert.ok((await evaluate('document.getElementById("modal-content").textContent')).includes(model.manifest.revision));await click('#close-modal');
  });
  await group(`${prefix}: every participant has collapsed detail and a contextual question`,async()=>{
   for (const node of model.nodes) {
    // Inspection through the public map/components keeps hierarchy expansion real.
    const parents=[];let parent=model.nodes.find(n=>n.id===node.parent);
    while(parent){parents.unshift(parent);parent=model.nodes.find(n=>n.id===parent.parent);}
    for(const p of parents)if(!(await state()).expanded.includes(p.id))await click(selector('data-node-header',p.id),{dom:true});
    await click(selector(model.nodes.some(n=>n.parent===node.id)?'data-node-header':'data-node',node.id),{dom:true});
    const info=await evaluate(`(()=>{const p=document.getElementById('detail-content'),q=p.querySelector('.question-template'),f=q.querySelector('textarea');return {title:p.querySelector('h2').textContent,question:f.value,last:q===p.lastElementChild,short:p.querySelector('.node-description summary').textContent,open:p.querySelector('.node-description').open}})()`);
    assert.equal(info.title,node.label);assert.equal(info.last,true);assert.equal(info.open,false);
    assert.ok(info.short.includes(node.role));assert.ok(info.question.includes(name));assert.ok(info.question.includes(node.label));assert.ok(info.question.includes(model.manifest.revision.slice(0,7)));assert.match(info.question,/Вопрос:\s*$/);
    await click('#detail-content .node-description > summary');
    assert.equal(await evaluate('document.querySelector(".node-description").open'),true);
    // Native details toggles work without moving the scenario.
    const before=await state();await click('#detail-content .node-description > summary');assert.deepEqual(await state(),before);
    const multiple=node.ownedData?.find(item=>item.sources?.length>1);
    if(multiple){
     const dataKey=selector('data-disclosure',`${node.id}:data`),itemKey=selector('data-disclosure',`${node.id}:data:${multiple.name}`);
     await click(dataKey+' > summary');await click(itemKey+' > summary');
     const refs=await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(itemKey+' [data-source]')}),e=>e.dataset.source)`);
     for(const ref of multiple.sources)assert.ok(refs.includes(ref),'Every owned-data evidence anchor remains accessible');
     await click(itemKey+' > summary');await click(dataKey+' > summary');
    }
   }
   return {participants:model.nodes.length};
  });
  await group(`${prefix}: branches preview, commit and independent progress`,async()=>{
   const scenario=model.scenarios.find(s=>s.steps.some(t=>t.branch));assert.ok(scenario);
   await selectScenario(scenario.id);await click('#restart');await seek(9999);
   const initial=await state(),step=scenario.steps.find(s=>s.id===initial.step);assert.ok(step.branch);
   const [first,second]=step.branch.options;assert.ok(second);
   await click(selector('data-option',first.id));
   assert.equal((await state()).step,initial.step);assert.deepEqual((await state()).choices,initial.choices);
   await click(selector('data-option',second.id));await click('#confirm-option');
   const committed=await state();assert.equal(committed.choices[step.id],second.id);assert.equal(committed.step,second.next || step.id);
   const other=model.scenarios.find(s=>s.id!==scenario.id);assert.ok(other);
   await selectScenario(other.id);await selectScenario(scenario.id);
   assert.equal((await state()).step,committed.step);assert.deepEqual((await state()).choices,committed.choices);
   await seek(initial.index);await click(selector('data-option',first.id));await click('#confirm-option');assert.equal((await state()).choices[step.id],first.id);
   const q=await evaluate('document.querySelector(".question-template-text").value');assert.ok(q.includes(scenario.title));assert.ok(q.includes(scenario.steps.find(s=>s.id===(first.next || step.id)).title));
   await click('#restart');
  });
  await group(`${prefix}: copy fallback and offline pinned source viewer`,async()=>{
   const before=await state();
   await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}})");
   await click('[data-copy-question]');assert.deepEqual(await state(),before);
   assert.equal(await evaluate('window.__copied'),await evaluate('document.querySelector(".question-template-text").value'));
   await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied')}}});document.execCommand=()=>false");
   await click('[data-copy-question]');assert.ok((await evaluate('document.querySelector(".question-copy-status").textContent')).includes('Ctrl+C'));
   const step=model.scenarios.find(s=>s.id===(before.scenario)).steps.find(s=>s.id===before.step),ref=model.evidence.find(e=>e.id===step.sources[0]);assert.ok(ref);
   await click(selector('data-source',ref.id));
   const metadata=await evaluate('document.querySelector(".source-meta").textContent');assert.ok(metadata.includes(ref.revision));assert.ok(metadata.includes(ref.repo));assert.ok(metadata.includes(ref.sourceIntegrity.status));
   assert.equal(await evaluate('document.querySelector(".code-line.target .line-no").textContent'),String(ref.line));
   if(ref.url)assert.equal(await evaluate('document.querySelector(".source-meta a").href'),ref.url);
   else assert.equal(await evaluate('document.querySelector(".source-meta a")'),null);
   await click('[data-full-source]');
   const lineCount=await evaluate('document.querySelectorAll(".code-line").length');assert.ok(lineCount>=ref.line);
   await click('#close-modal');assert.deepEqual(await state(),before);
  });
  await group(`${prefix}: directed geometry at expanded scale and mobile controls`,async()=>{
   const data=await evaluate(`(()=>{const rows=[...document.querySelectorAll('path.edge.active-route')];return rows.map(p=>({d:p.getAttribute('d'),marker:p.getAttribute('marker-end'),source:[...document.querySelectorAll('.edge-source')].some(c=>c.dataset.edge===p.dataset.edge)}))})()`);
   assert.ok(data.length>0);assert.ok(data.every(r=>r.marker==='url(#arrow-active)'&&r.source&&!/NaN|Infinity/.test(r.d)));
   const oldZoom=(await state()).camera.k;await click('#zoom-in');assert.ok((await state()).camera.k>oldZoom);
   await screenshot(path.join(tmpdir(),`iad-kit-${prefix}-desktop.png`));
   await dimensions(390,844,true);await reload();
   assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
   assert.equal(await evaluate('document.querySelector(".workspace").classList.contains("details-hidden")'),true);
   const scenario=model.scenarios.find(s=>s.steps.find(t=>t.id===s.entry).next);await selectScenario(scenario.id);
   await click('#next');assert.equal((await state()).index,1);if(!await evaluate('document.querySelector(".workspace").classList.contains("details-hidden")'))await click('#close-details');await click('#back');assert.equal((await state()).index,0);
   await screenshot(path.join(tmpdir(),`iad-kit-${prefix}-mobile.png`));
  });
 }
 await group('Generic layout: ten nested levels keep readable positive card widths',async()=>{
  await openSynthetic('deep',model=>{
   const root=model.nodes.find(n=>!n.parent);
   for(let i=0;i<10;i++)model.nodes.push({id:`deep-${i}`,parent:i?`deep-${i-1}`:root.id,kind:'component',label:`Nested level ${i}`,role:'Synthetic layout regression.',sources:[]});
   model.view.initialScenario=model.scenarios[0].id;
   model.scenarios[0].steps.find(s=>s.id===model.scenarios[0].entry).to='deep-9';
  });
  assert.ok((await state()).expanded.includes('deep-8'),'The initial step reveals its nested participants');
  const cards=await evaluate(`Array.from(document.querySelectorAll('[data-node]'),e=>({id:e.dataset.node,width:+e.querySelector('rect').getAttribute('width')}))`);
  assert.equal(cards.filter(c=>c.id.startsWith('deep-')).length,10);assert.ok(cards.every(c=>c.width>=240));
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('path.edge')).some(p=>/NaN|Infinity/.test(p.getAttribute('d')))`),false);
 });
 await group('Player: reconverging forks open and navigate without enumerating every route',async()=>{
  const count=25,{loadMilliseconds}=await openSynthetic('reconverging',model=>{
   const scenario=model.scenarios[0],step=scenario.steps.find(s=>s.id===scenario.entry);
   scenario.entry='fork-0';scenario.steps=Array.from({length:count},(_,i)=>({...step,id:`fork-${i}`,next:null,branch:{options:['left','right'].map(id=>({id,label:id,condition:'A synthetic decision.',result:'Continue to the shared successor.',next:i+1<count?`fork-${i+1}`:null}))}}));
   model.scenarios=[scenario];model.view.initialScenario=scenario.id;
  });
  assert.ok(loadMilliseconds<3000,`25 shared forks took ${loadMilliseconds} ms to open`);
  assert.equal(await evaluate('Number(document.getElementById("scrubber").max)'),count-1);
  await click('[data-option="left"]');const started=Date.now();await click('#confirm-option');const navigationMilliseconds=Date.now()-started;
  assert.equal((await state()).step,'fork-1');assert.ok(navigationMilliseconds<3000,`Confirming a fork took ${navigationMilliseconds} ms`);
  return {steps:count,loadMilliseconds,navigationMilliseconds};
 });
 await group('Player: long linear scenarios do not consume the JavaScript call stack',async()=>{
  const count=5000,{loadMilliseconds}=await openSynthetic('long-linear',model=>{
   const scenario=model.scenarios[0],{branch,...step}=scenario.steps.find(s=>s.id===scenario.entry),node=model.nodes.find(n=>!n.parent);
   scenario.entry='linear-0';scenario.steps=Array.from({length:count},(_,i)=>({...step,id:`linear-${i}`,from:node.id,to:node.id,next:i+1<count?`linear-${i+1}`:null}));
   model.nodes=[node];model.edges=[];model.contracts=[];model.scenarios=[scenario];model.view={initialScenario:scenario.id};
  });
  assert.ok(loadMilliseconds<3000,`5000 steps took ${loadMilliseconds} ms to open`);
  assert.equal(await evaluate('Number(document.getElementById("scrubber").max)'),count-1);
  await click('#next');assert.equal((await state()).step,'linear-1');
  return {steps:count,loadMilliseconds};
 });
 await group('Sources: LF line numbers retain Unicode separators and omit the empty trailing row',async()=>{
  let ref;
  await openSynthetic('source-lines',model=>{ref=model.evidence[0];ref.line=2;},sources=>{
   sources[ref.sourceKey].text="message = 'alpha\u2028beta\fgamma'\nsecond = 2\n";
  });
  await evaluate(`IADViewer.openSource(${JSON.stringify(ref.id)})`);await click('[data-full-source]');
  assert.equal(await evaluate('document.querySelectorAll(".code-line").length'),2);
  assert.equal(await evaluate('document.querySelector(".code-line.target .line-no").textContent'),'2');
  assert.equal(await evaluate('document.querySelector(".code-line.target span:last-child").textContent'),'second = 2');
  assert.ok((await evaluate('document.querySelector(".code-line span:last-child").textContent')).includes('alpha\u2028beta\fgamma'));
  await click('#close-modal');
 });
 await group('Browser: no uncaught script errors in supplied diagrams',async()=>assert.deepEqual(browserErrors,[]));
 report.status=groups.some(g=>g.status==='failed')?'failed':'passed';
} catch(error) {report.status='failed';report.startupError=error.stack;console.error(error.stack);}
finally {
 report.passed=groups.filter(g=>g.status==='passed').length;report.failed=groups.filter(g=>g.status==='failed').length;
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
 if(websocket?.readyState===WebSocket.OPEN){try{await cdp('Browser.close',{},null);}catch{}websocket.close();}
 if(chrome&&!chrome.killed)chrome.kill('SIGTERM');
 for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error('Browser check complete'));}pending.clear();
 if(profile){await pause(300);await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});}
 if(syntheticDirectory)await rm(syntheticDirectory,{recursive:true,force:true});
 console.log(`${report.passed}/${groups.length} browser groups passed; report: ${reportPath}`);process.exitCode=report.status==='passed'?0:1;
}
