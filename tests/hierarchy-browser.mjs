#!/usr/bin/env node
/** Offline integration of nested diagrams, scoped catalogues and preserved playback. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
if(!process.argv[2])throw new Error('Usage: node tests/hierarchy-browser.mjs COMPILED_INDEX_HTML. Use python3 tests/smoke.py --browser for a temporary hierarchy fixture.');
const files=[path.resolve(process.argv[2])];
const chromePath=process.env.IAD_CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const groups=[],browserErrors=[],report={status:'running',groups,browserErrors,screenshots:[]};
const reportPath=process.env.IAD_BROWSER_REPORT || path.join(tmpdir(),'iad-kit-hierarchy-browser-report.json');
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
async function dragPoint(point,dx,dy){
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
 await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx/2,y:point.y+dy/2,button:'left',buttons:1});
 await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx,y:point.y+dy,button:'left',buttons:1});
 await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});
 await pause(50);
}
async function targetPoint(selector){
 const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect();for(const p of [{x:b.x+b.width/2,y:b.y+b.height/2},{x:b.x+Math.min(10,b.width/2),y:b.y+Math.min(10,b.height/2)}]){const h=document.elementFromPoint(p.x,p.y);if(h&&(h===e||e.contains(h)))return p;}return null})()`);
 assert.ok(point,`The pointer target is not visible: ${selector}`);return point;
}
async function pressKey(selector,key,code){
 const found=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return document.activeElement===e})()`);
 assert.ok(found,`Missing focusable target: ${selector}`);
 await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:key==='Enter'?13:32});
 await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:key==='Enter'?13:32});
 await pause(35);
}
async function selectScenario(id){await click(`[data-scenario=${JSON.stringify(id)}]`);}
async function setSpeed(value){await evaluate(`(()=>{const e=document.getElementById('speed');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function until(predicate,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){if(await predicate())return;await pause(100);}throw new Error('Timed out waiting for browser state');}
async function group(name,run){try{const details=await run();groups.push({name,status:'passed',...(details?{details}:{})});console.log(`PASS ${name}`);}catch(error){const failureScreenshot=path.join(tmpdir(),'iad-kit-failure-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,70)+'.png');try{await screenshot(failureScreenshot);}catch{}groups.push({name,status:'failed',error:error.message,failureScreenshot});console.log(`FAIL ${name}: ${error.message}`);}}
async function screenshot(destination){const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(destination,Buffer.from(result.data,'base64'));report.screenshots.push(destination);}
async function dimensions(width,height,mobile=false){await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:height});}

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

 const file=files[0];await readFile(file);await dimensions(1600,1000);
 await cdp('Page.navigate',{url:pathToFileURL(file).href});await ready();
 const model=await evaluate("JSON.parse(document.getElementById('iad-model').textContent)");
 const byId=new Map(model.nodes.map(n=>[n.id,n])),roots=model.nodes.filter(n=>!n.parent);
 const children=id=>model.nodes.filter(n=>n.parent===id);
 const nested=model.nodes.find(n=>n.parent&&roots.some(r=>r.id===n.parent&&r.kind==='repository')&&children(n.id).length>=2&&model.scenarios.some(s=>s.scope===n.id&&s.steps.find(t=>t.id===s.entry)?.branch?.options.length>=2));
 assert.ok(nested,'The hierarchy test needs a repository with a nested container and a branched scoped scenario');
 const primary=byId.get(nested.parent),branched=model.scenarios.find(s=>s.scope===nested.id&&s.steps.find(t=>t.id===s.entry)?.branch?.options.length>=2);
 const background=model.scenarios.find(s=>roots.some(r=>r.id===s.scope&&r.id!==primary.id)&&s.steps.length>=3&&!s.steps.some(t=>t.branch));
 const secondary=byId.get(background?.scope);
 assert.ok(secondary&&children(primary.id).length>=3,'The hierarchy test needs another repository with a linear three-step scenario and at least three primary children');
 assert.ok(roots.length>=2&&roots.every(r=>r.kind==='repository'));
 const playback=s=>({scenario:s.scenario,step:s.step,index:s.index,choices:s.choices,preview:s.preview});
 const nodeSelector=id=>`[data-node=${JSON.stringify(id)}]`;
 const headerSelector=id=>`[data-node-header=${JSON.stringify(id)}]`;
 const setScope=id=>evaluate(`IADViewer.setScope(${JSON.stringify(id)})`);
 const chooseScenario=id=>evaluate(`IADViewer.selectScenario(${JSON.stringify(id)})`);
 let branchProgress;
 await group('Hierarchy: overview contains repositories and user journeys at one architecture level',async()=>{
  const initial=await state(),layout=await evaluate('IADViewer.getLayout()');
  assert.equal(initial.scope,null);assert.equal(layout.boxes.length,roots.length);
  assert.deepEqual(layout.boxes.map(b=>b.id).sort(),roots.map(n=>n.id).sort());
  assert.ok(layout.boxes.every(b=>!b.group&&b.h===118));
  const rootJourneys=model.scenarios.filter(s=>(s.scope??null)===null);
  assert.deepEqual(initial.visibleScenarios,rootJourneys.map(s=>s.id));
  assert.ok(rootJourneys.every(s=>s.trigger?.kind==='user'));
  assert.ok(rootJourneys.length>0);
  assert.ok(!initial.visibleScenarios.includes(background.id));
  assert.equal(initial.scenario,model.view?.initialScenario||rootJourneys[0].id);
  return {roots:layout.boxes.map(b=>b.id),overviewJourneys:initial.visibleScenarios};
 });
 await group('Hierarchy: expanding a repository creates a full diagram inside larger bounds without moving playback',async()=>{
  const before=await state(),closed=(await evaluate('IADViewer.getLayout()')).boxes.find(b=>b.id===primary.id);
  await click(headerSelector(primary.id),{dom:true});
  const after=await state(),layout=await evaluate('IADViewer.getLayout()'),parent=layout.boxes.find(b=>b.id===primary.id),children=layout.boxes.filter(b=>b.parent===primary.id);
  assert.deepEqual(playback(after),playback(before));assert.equal(after.scope,primary.id);
  assert.ok(parent.w>=closed.w*2);assert.ok(parent.h>closed.h*2);assert.ok(parent.headerHeight>=80);
  assert.ok(children.length>2&&new Set(children.map(b=>b.x)).size>=2);
  assert.ok(children.every(b=>b.w>=285&&b.h===118));
  assert.ok(children.every(b=>b.x>=parent.contentBounds.x&&b.y>=parent.contentBounds.y&&b.x+b.w<=parent.contentBounds.x+parent.contentBounds.w&&b.y+b.h<=parent.contentBounds.y+parent.contentBounds.h));
  await click(headerSelector(nested.id),{dom:true});
  const nestedBoxes=(await evaluate('IADViewer.getLayout()')).boxes,nestedBox=nestedBoxes.find(b=>b.id===nested.id),nestedChildren=nestedBoxes.filter(b=>b.parent===nested.id);
  assert.equal((await state()).scope,nested.id);assert.ok(nestedBox.w>closed.w);assert.ok(nestedBox.h>closed.h*2);assert.ok(nestedChildren.length>=2&&new Set(nestedChildren.map(b=>b.x)).size===1,'A simple reciprocal pair uses one compact column');
  assert.ok(nestedChildren.every(b=>b.h===118&&b.w>=285));assert.deepEqual(playback(await state()),playback(before));
  return {parentBounds:{w:parent.w,h:parent.h},nestedChildren:nestedChildren.map(b=>b.id)};
 });
 await group('Hierarchy: empty expanded content pans without collapsing; only headers toggle their own container',async()=>{
  await setScope(primary.id);
  const before=await state();
  assert.ok(before.expanded.includes(primary.id)&&before.expanded.includes(nested.id));
  await click(`[data-node-body=${JSON.stringify(primary.id)}]`,{dom:true});
  assert.deepEqual((await state()).expanded,before.expanded,'A body click must not collapse an expanded diagram');
  const point=await evaluate(`(()=>{
   const body=document.querySelector('[data-node-body='+${JSON.stringify(JSON.stringify(primary.id))}+']'),map=document.getElementById('map');if(!body)return null;
   const b=body.getBoundingClientRect(),m=map.getBoundingClientRect(),left=Math.max(b.left+6,m.left+10),right=Math.min(b.right-6,m.right-70),top=Math.max(b.top+8,m.top+125),bottom=Math.min(b.bottom-8,m.bottom-30);
   for(let y=top;y<bottom;y+=13)for(let x=left;x<right;x+=13){const e=document.elementFromPoint(x,y);if(e===body)return {x,y};}return null;
  })()`);
  assert.ok(point,'An expanded diagram must expose canvas space for a real pointer drag');
  await dragPoint(point,45,25);
  const moved=await state();
  assert.ok(Math.abs(moved.camera.x-before.camera.x-45)<2&&Math.abs(moved.camera.y-before.camera.y-25)<2,'Dragging inside the container must pan the camera');
  assert.deepEqual(moved.expanded,before.expanded);assert.deepEqual(playback(moved),playback(before));assert.equal(moved.scope,before.scope);
  const headerBefore=await state();
  await dragPoint(await targetPoint(headerSelector(nested.id)),18,12);
  const headerMoved=await state();
  assert.deepEqual(headerMoved.expanded,headerBefore.expanded,'Dragging from a header must pan, not toggle');
  assert.ok(Math.abs(headerMoved.camera.x-headerBefore.camera.x-18)<2&&Math.abs(headerMoved.camera.y-headerBefore.camera.y-12)<2);
  await click(headerSelector(nested.id),{dom:true});
  const childClosed=await state();assert.ok(childClosed.expanded.includes(primary.id));assert.ok(!childClosed.expanded.includes(nested.id));
  await pressKey(headerSelector(nested.id),'Enter','Enter');
  assert.ok((await state()).expanded.includes(nested.id));assert.ok((await state()).expanded.includes(primary.id));
  await pressKey(headerSelector(nested.id),' ','Space');
  assert.ok(!(await state()).expanded.includes(nested.id));assert.ok((await state()).expanded.includes(primary.id));
  await click(headerSelector(nested.id),{dom:true});
  assert.deepEqual(playback(await state()),playback(before));
 });
 await group('Hierarchy: branch choices survive scope changes, collapsing and independent scoped playback',async()=>{
  await chooseScenario(branched.id);await click('#restart');
  const entry=branched.steps.find(s=>s.id===branched.entry),valid=entry.branch.options.find(o=>o.next);assert.ok(valid);
  await click(`[data-option=${JSON.stringify(valid.id)}]`,{dom:true});await click('#confirm-option',{dom:true});
  branchProgress=playback(await state());assert.equal(branchProgress.choices[entry.id],valid.id);
  await setScope(secondary.id);assert.deepEqual(playback(await state()),branchProgress);
  assert.ok((await state()).visibleScenarios.includes(background.id));
  await chooseScenario(background.id);await click('#restart');await setSpeed(600);await click('#play',{dom:true});
  await until(async()=>(await state()).index>=2,6000);if((await state()).playing)await click('#play',{dom:true});
  assert.equal((await state()).scope,secondary.id,'Automatic playback must not select a detail scope');
  await chooseScenario(branched.id);assert.deepEqual(playback(await state()),branchProgress);assert.equal((await state()).scope,nested.id);
  await click(headerSelector(nested.id),{dom:true});assert.equal((await state()).scope,primary.id);assert.ok(!(await state()).expanded.includes(nested.id));assert.deepEqual(playback(await state()),branchProgress);
  await click(headerSelector(nested.id),{dom:true});assert.equal((await state()).scope,nested.id);assert.deepEqual(playback(await state()),branchProgress);
  await click('#home',{dom:true});assert.equal((await state()).scope,null);assert.ok(!(await state()).visibleScenarios.includes(background.id));assert.deepEqual(playback(await state()),branchProgress);
  await chooseScenario(branched.id);assert.deepEqual(playback(await state()),branchProgress);
 });
 await group('Hierarchy: visible nested routes and captions stay in their common container',async()=>{
  await chooseScenario(branched.id);await setScope(nested.id);await click('#all-edges',{dom:true});
  const geometry=await evaluate(`(()=>{
   const model=JSON.parse(document.getElementById('iad-model').textContent),layout=IADViewer.getLayout(),state=IADViewer.getState(),byId=new Map(model.nodes.map(n=>[n.id,n])),boxes=new Map(layout.boxes.map(b=>[b.id,b]));
   const visible=id=>{while(!boxes.has(id))id=byId.get(id)?.parent;return id;};
   const allSteps=new Map(model.scenarios.find(s=>s.id===state.scenario).steps.map(s=>[s.id,s]));
   return {diagnostics:state.routingDiagnostics,boxes:layout.boxes,ports:IADViewer.getPorts(),markers:[...document.querySelectorAll('[data-api-port]')].map(e=>e.dataset.apiPort),routes:[...document.querySelectorAll('path.edge.active-route')].map(path=>{
    const step=allSteps.get(path.dataset.edge),from=boxes.get(visible(step.from)),to=boxes.get(visible(step.to)),common=[from.id,...from.ancestors.slice().reverse()].find(id=>{const b=boxes.get(id);return b?.group&&(id===to.id||to.ancestors.includes(id));});
    const values=path.getAttribute('d').match(/-?[0-9]+(?:\\.[0-9]+)?/g).map(Number),points=[];for(let i=0;i<values.length;i+=2)points.push({x:values[i],y:values[i+1]});
    const caption=[...document.querySelectorAll('text.edge-label')].find(e=>e.dataset.edge===path.dataset.edge),bb=caption?.getBBox();
    return {id:step.id,from:from.id,to:to.id,domain:common||null,points,label:bb?{x:bb.x,y:bb.y,w:bb.width,h:bb.height}:null,marker:path.getAttribute('marker-end'),sourcePort:path.dataset.sourcePort,targetPort:path.dataset.targetPort};
   })};
  })()`);
  assert.deepEqual(geometry.diagnostics,[]);assert.ok(geometry.routes.length>0);
  const boxes=new Map(geometry.boxes.map(b=>[b.id,b])),ports=new Map(geometry.ports.map(p=>[p.id,p]));let bounded=0;
  for(const route of geometry.routes){
   assert.equal(route.marker,'url(#arrow-active)');assert.ok(route.label,`${route.id} has a visible caption`);
   for(const [id,point] of [[route.sourcePort,route.points[0]],[route.targetPort,route.points.at(-1)]]){
    const port=ports.get(id);assert.ok(port&&geometry.markers.includes(id),`${route.id} attaches to a visible named port`);
    assert.ok(Math.abs(port.point.x-point.x)<.1&&Math.abs(port.point.y-point.y)<.1,`${route.id} endpoint matches its displayed API marker`);
   }
   if(!route.domain)continue;bounded++;
   const b=boxes.get(route.domain).contentBounds,within=p=>p.x>=b.x-1&&p.x<=b.x+b.w+1&&p.y>=b.y-1&&p.y<=b.y+b.h+1;
   route.points.forEach((p,i)=>{if(!(i===0&&route.from===route.domain)&&!(i===route.points.length-1&&route.to===route.domain))assert.ok(within(p),`${route.id} leaves ${route.domain}`);});
   assert.ok(within(route.label)&&within({x:route.label.x+route.label.w,y:route.label.y+route.label.h}),`${route.id} rendered caption leaves ${route.domain}`);
  }
  assert.ok(bounded>0,'At least one nested interaction must be visibly inside its container');
  await screenshot(path.join(tmpdir(),'iad-kit-nested-hierarchy-desktop.png'));await click('#all-edges',{dom:true});
  return {routes:geometry.routes.length,bounded};
 });
 await group('Hierarchy: component and expanded repository API ports expose operations and preserve playback',async()=>{
  const overview=model.scenarios.find(s=>(s.scope??null)===null&&s.steps.some(t=>t.to===secondary.id));assert.ok(overview);
  await chooseScenario(overview.id);await setScope(secondary.id);
  await click('#close-details',{dom:true});await click('#fit',{dom:true});
  const before=await state(),ports=await evaluate('IADViewer.getPorts()'),layout=await evaluate('IADViewer.getLayout()');
  const contract=model.contracts.find(c=>c.node===secondary.id);assert.ok(contract);
  const port=ports.find(p=>p.kind==='provided'&&p.contract===contract.id&&p.node===secondary.id&&!p.internal);assert.ok(port,'An expanded repository exposes its own API on the outer boundary');
  const box=layout.boxes.find(b=>b.id===secondary.id);assert.ok(box.group);
  assert.ok(Math.abs(port.border.x-box.x)<1||Math.abs(port.border.x-box.x-box.w)<1||Math.abs(port.border.y-box.y)<1||Math.abs(port.border.y-box.y-box.h)<1,'The API port lies on the actual expanded border');
  await click(`[data-api-port=${JSON.stringify(port.id)}]`);
  let inspector=await evaluate('document.querySelector("#modal .api-inspector")?.textContent');
  assert.ok(inspector?.includes(contract.name)&&inspector.includes(secondary.label));
  assert.ok(await evaluate(`Boolean(document.querySelector('#modal [data-api-contract='+${JSON.stringify(JSON.stringify(contract.id))}+']'))`));
  assert.ok(inspector.includes(contract.operations[0].description));
  const hasSource=await evaluate('Boolean(document.querySelector("#modal .api-inspector [data-source]"))');assert.ok(hasSource,'API details retain source links');
  await click('#close-modal',{dom:true});
  assert.deepEqual(playback(await state()),playback(before));assert.deepEqual((await state()).expanded,before.expanded);

  await chooseScenario(branched.id);await setScope(nested.id);await click('#close-details',{dom:true});await click('#fit',{dom:true});
  const localBefore=await state(),localPorts=await evaluate('IADViewer.getPorts()'),localContract=model.contracts.find(c=>children(nested.id).some(n=>n.id===c.node));assert.ok(localContract);
  const localPort=localPorts.find(p=>p.kind==='provided'&&p.contract===localContract.id&&p.node===localContract.node);assert.ok(localPort);
  const portSelector=`[data-api-port=${JSON.stringify(localPort.id)}]`,portBefore=await state();
  await dragPoint(await targetPoint(portSelector),20,10);
  const portMoved=await state();
  assert.equal(await evaluate('document.getElementById("modal").open'),false,'Dragging from an API marker must not open its inspector');
  assert.deepEqual(portMoved.expanded,portBefore.expanded);assert.deepEqual(playback(portMoved),playback(portBefore));
  assert.ok(Math.abs(portMoved.camera.x-portBefore.camera.x-20)<2&&Math.abs(portMoved.camera.y-portBefore.camera.y-10)<2);
  await pressKey(`[data-api-port=${JSON.stringify(localPort.id)}]`,'Enter','Enter');
  inspector=await evaluate('document.querySelector("#modal .api-inspector")?.textContent');
  assert.ok(inspector?.includes(localContract.name)&&inspector.includes(localContract.operations[0].description));
  await click('#close-modal',{dom:true});
  const fallback=localPorts.find(p=>p.kind==='connection'&&!p.contract);assert.ok(fallback);
  await pressKey(`[data-api-port=${JSON.stringify(fallback.id)}]`,' ','Space');
  assert.ok((await evaluate('document.querySelector("#modal .api-inspector")?.textContent'))?.includes('API не указан'));
  await click('#close-modal',{dom:true});
  assert.deepEqual(playback(await state()),playback(localBefore));assert.deepEqual((await state()).expanded,localBefore.expanded);
  while((await state()).camera.k<.9)await click('#zoom-in',{dom:true});
  await setScope(nested.id);await click('#close-details',{dom:true});
  await screenshot(path.join(tmpdir(),'iad-kit-api-ports-desktop.png'));
  await pressKey(`[data-api-port=${JSON.stringify(localPort.id)}]`,'Enter','Enter');
  await screenshot(path.join(tmpdir(),'iad-kit-api-inspector-desktop.png'));
  await click('#close-modal',{dom:true});
 });
 await group('Hierarchy: source API, copyable questions and scoped API remain usable offline',async()=>{
  await click('#tab-step',{dom:true});
  const before=playback(await state()),scenario=model.scenarios.find(s=>s.id===before.scenario),step=scenario.steps.find(s=>s.id===before.step),ref=model.evidence.find(e=>e.id===step.sources[0]);assert.ok(ref);
  const question=await evaluate('document.querySelector(".question-template-text").value');assert.ok(question.includes(scenario.title)&&question.includes(step.title)&&question.endsWith('Вопрос: '));
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__hierarchyCopied=text}}})");
  await click('[data-copy-question]',{dom:true});assert.equal(await evaluate('window.__hierarchyCopied'),question);assert.deepEqual(playback(await state()),before);
  await evaluate(`IADViewer.openSource(${JSON.stringify(ref.id)})`);
  const metadata=await evaluate('document.querySelector(".source-meta").textContent');assert.ok(metadata.includes(ref.revision)&&metadata.includes(ref.repo));assert.equal(await evaluate('document.querySelector(".code-line.target .line-no").textContent'),String(ref.line));
  await click('[data-full-source]',{dom:true});assert.ok(await evaluate('document.querySelectorAll(".code-line").length')>=ref.line);await click('#close-modal',{dom:true});
  assert.deepEqual(playback(await state()),before);
  const apiScoped=await evaluate(`IAD.getScenarios({scope:${JSON.stringify(secondary.id)}}).map(s=>s.id)`);assert.ok(apiScoped.includes(background.id));
 });
 await group('Hierarchy: mobile retains readable compact nested cards and scoped navigation',async()=>{
  await dimensions(390,844,true);await reload();await setScope(nested.id);
  const layout=await evaluate('IADViewer.getLayout()'),children=layout.boxes.filter(b=>b.parent===nested.id);
  assert.ok(new Set(children.map(b=>b.x)).size===1&&children.every(b=>b.w>=285&&b.h===118));
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);assert.equal((await state()).scope,nested.id);
  assert.deepEqual((await state()).routingDiagnostics,[]);
  await screenshot(path.join(tmpdir(),'iad-kit-nested-hierarchy-mobile.png'));
 });
 await group('Hierarchy: the initial scope opens its diagram before the first interaction',async()=>{
  const html=await readFile(file,'utf8'),pattern=/(<script id="iad-model" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const configured=structuredClone(model);configured.view={...configured.view,initialScope:nested.id,initialScenario:branched.id};
  syntheticDirectory=await mkdtemp(path.join(tmpdir(),'iad-kit-initial-scope-'));
  const destination=path.join(syntheticDirectory,'index.html');
  await writeFile(destination,html.replace(pattern,(_all,before,_data,after)=>before+JSON.stringify(configured).replace(/</g,'\\u003c')+after));
  await dimensions(1600,1000);await cdp('Page.navigate',{url:pathToFileURL(destination).href});await ready();
  const initial=await state(),layout=await evaluate('IADViewer.getLayout()'),entry=branched.steps.find(s=>s.id===branched.entry);
  assert.equal(initial.scope,nested.id);assert.equal(initial.scenario,branched.id);assert.equal(initial.step,branched.entry);
  assert.ok(initial.expanded.includes(primary.id)&&initial.expanded.includes(nested.id));
  assert.ok(layout.boxes.some(b=>b.id===entry.from)&&layout.boxes.some(b=>b.id===entry.to));
  assert.ok(initial.visibleScenarios.includes(branched.id));assert.deepEqual(initial.routingDiagnostics,[]);
  assert.ok(await evaluate('document.querySelectorAll("path.edge.active-route").length')>0);
  await click(`[data-option=${JSON.stringify(entry.branch.options[0].id)}]`);await click('#confirm-option');
  assert.equal((await state()).choices[entry.id],entry.branch.options[0].id);
  await screenshot(path.join(tmpdir(),'iad-kit-initial-scope-desktop.png'));
 });
 await group('Hierarchy: no uncaught browser errors',async()=>assert.deepEqual(browserErrors,[]));
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
