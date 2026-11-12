#!/usr/bin/env node
/** Geometric regressions for the visible IAD connections, independent of route search. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url),router=require('../iadkit/assets/routing.js'),core=require('../iadkit/assets/player.js'),diagramLayout=require('../iadkit/assets/layout.js'),semanticPorts=require('../iadkit/assets/ports.js');
if(!process.argv[2])throw new Error('Usage: node tests/routing.mjs COMPILED_MODEL_JSON. Use python3 tests/smoke.py for temporary fixtures.');
const model=JSON.parse(readFileSync(path.resolve(process.argv[2]),'utf8'));
const kids=id=>model.nodes.filter(n=>(n.parent||null)===id);
function layout(expanded=new Set()){return diagramLayout.layout(model.nodes,expanded,model.view||{}).boxes;}

const eps=.02;
const collides=(a,b,r)=>Math.abs(a.y-b.y)<eps?a.y>r.y+eps&&a.y<r.y+r.h-eps&&Math.max(a.x,b.x)>r.x+eps&&Math.min(a.x,b.x)<r.x+r.w-eps:a.x>r.x+eps&&a.x<r.x+r.w-eps&&Math.max(a.y,b.y)>r.y+eps&&Math.min(a.y,b.y)<r.y+r.h-eps;
const onSegment=(p,a,b)=>(Math.abs(a.y-b.y)<eps?Math.abs(p.y-a.y)<eps&&p.x>=Math.min(a.x,b.x)-eps&&p.x<=Math.max(a.x,b.x)+eps:Math.abs(p.x-a.x)<eps&&p.y>=Math.min(a.y,b.y)-eps&&p.y<=Math.max(a.y,b.y)+eps);
const rectangleOverlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const distanceToRect=(p,r)=>Math.hypot(Math.max(r.x-p.x,0,p.x-r.x-r.w),Math.max(r.y-p.y,0,p.y-r.y-r.h));
const segments=points=>points.slice(1).map((b,i)=>[points[i],b]);
function checkGeometry(boxes,edges,routes){
 const obstacles=boxes.map(b=>({...b,h:b.group?(b.headerHeight??54):b.h}));assert.equal(routes.length,edges.length);
 for(let i=0;i<routes.length;i++){
  const route=routes[i],edge=edges[i];
  const sourceBox=boxes.find(b=>b.id===edge.from),targetBox=boxes.find(b=>b.id===edge.to);
  const source=edge.sourceApiPort&&!edge.sourceApiPort.internal?sourceBox:obstacles.find(b=>b.id===edge.from),target=edge.targetApiPort&&!edge.targetApiPort.internal?targetBox:obstacles.find(b=>b.id===edge.to);
  const enclosing=new Set([edge.from,edge.to,...(sourceBox.ancestors||[]),...(targetBox.ancestors||[])]);
  const externalEndpoints=new Set([...(sourceBox.group&&edge.sourceApiPort&&!edge.sourceApiPort.internal?[edge.from]:[]),...(targetBox.group&&edge.targetApiPort&&!edge.targetApiPort.internal?[edge.to]:[])]);
  const edgeObstacles=boxes.map(b=>({...b,h:b.group&&(externalEndpoints.has(b.id)||!enclosing.has(b.id)&&Object.prototype.hasOwnProperty.call(b,'parent'))?b.h:b.group?(b.headerHeight??54):b.h}));
  assert.equal(route.id,edge.id);
  assert.ok(!route.unavailable,route.error?.message);
  assert.ok(route.points.length>=2);
  for(const [a,b]of segments(route.points)){
   assert.ok(Math.abs(a.x-b.x)<eps||Math.abs(a.y-b.y)<eps,`${edge.id} must be orthogonal`);
   for(const obstacle of edgeObstacles)assert.ok(!collides(a,b,obstacle),`${edge.id} crosses ${obstacle.id}`);
  }
  const onBorder=(p,b)=>(Math.abs(p.x-b.x)<eps||Math.abs(p.x-b.x-b.w)<eps)&&p.y>=b.y-eps&&p.y<=b.y+b.h+eps||(Math.abs(p.y-b.y)<eps||Math.abs(p.y-b.y-b.h)<eps)&&p.x>=b.x-eps&&p.x<=b.x+b.w+eps;
  assert.ok(onBorder(route.sourcePort,source),`${edge.id} source port must belong to sender`);
  assert.ok(onBorder(route.targetPort,target),`${edge.id} target port must belong to receiver`);
  if(edge.sourceApiPort){
   assert.equal(route.sourceApiPortId,edge.sourceApiPort.id);
   assert.deepEqual(route.sourcePort,edge.sourceApiPort.border);
  }
  if(edge.targetApiPort){
   assert.equal(route.targetApiPortId,edge.targetApiPort.id);
   assert.deepEqual(route.targetPort,edge.targetApiPort.border);
  }
  if(edge.activeRoute!==false){
   assert.ok(route.labelRect,`${edge.id} has an explicitly attached label`);
   assert.ok(segments(route.points).some(([a,b])=>onSegment(route.labelAnchor,a,b)),`${edge.id} label anchor is on its own path`);
   if(route.labelMode==='leader')assert.ok(route.labelLeader?.startsWith(`M${route.labelAnchor.x},${route.labelAnchor.y}`),`${edge.id} visible leader starts on its own path`);
   // A caption above a segment can have several lines: its first baseline is
   // far away even though the bottom of the complete block is beside the line.
   else assert.ok(distanceToRect(route.labelAnchor,route.labelRect)<=24,`${edge.id} label stays beside its segment`);
   for(const obstacle of edgeObstacles)assert.ok(!rectangleOverlap(route.labelRect,obstacle),`${edge.id} label covers ${obstacle.id}`);
  }
  if(route.domain){
   const bounds=boxes.find(b=>b.id===route.domain).contentBounds;
   const within=p=>p.x>=bounds.x-eps&&p.x<=bounds.x+bounds.w+eps&&p.y>=bounds.y-eps&&p.y<=bounds.y+bounds.h+eps;
   for(let j=0;j<route.points.length;j++)if(!(j===0&&edge.from===route.domain)&&!(j===route.points.length-1&&edge.to===route.domain))assert.ok(within(route.points[j]),`${edge.id} leaves ${route.domain}`);
   if(route.labelRect)assert.ok(within(route.labelRect)&&within({x:route.labelRect.x+route.labelRect.w,y:route.labelRect.y+route.labelRect.h}),`${edge.id} caption leaves ${route.domain}`);
  }
 }
 const visible=routes.filter(r=>r.labelRect);
 for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++)assert.ok(!rectangleOverlap(visible[i].labelRect,visible[j].labelRect),`${visible[i].id} and ${visible[j].id} labels overlap`);
}
function projected(boxes,scenario,choices={},currentId=scenario.entry){
 const visible=new Set(boxes.map(b=>b.id)),byId=new Map(model.nodes.map(n=>[n.id,n]));
 const ancestor=id=>{let at=id;while(!visible.has(at))at=byId.get(at).parent;return at;};
 const dedup=new Map();for(const [index,step]of core.pathFor(scenario,choices).entries()){
  const from=ancestor(step.from),to=ancestor(step.to);if(from===to)continue;
  const caption=step.title.length>30?step.title.slice(0,29)+'…':step.title;
  const key=`${from}>${to}`,edge={id:step.id,from,to,activeRoute:true,current:step.id===currentId,displayLabel:`${index+1}. ${caption}`};
  if(!dedup.has(key)||edge.current)dedup.set(key,edge);
 }
 return [...dedup.values()];
}
function terminalChoices(scenario){
 const byId=new Map(scenario.steps.map(s=>[s.id,s])),out=[];
 function walk(id,choices){if(!id){out.push(choices);return;}const step=byId.get(id);if(step.branch)for(const option of step.branch.options)walk(option.next,{...choices,[id]:option.id});else walk(step.next,choices);}
 walk(scenario.entry,{});return out;
}
let total=0;
const parents=model.nodes.filter(n=>kids(n.id).length).map(n=>n.id);
// Multi-line captions above a horizontal segment stay attached as a block.
// Checking only labelY incorrectly rejected these valid routes.
const captionBoxes=[{id:'caption-left',x:0,y:120,w:285,h:118},{id:'caption-right',x:600,y:120,w:285,h:118}];
const captionEdge={id:'multiline-caption',from:'caption-left',to:'caption-right',activeRoute:true,displayLabel:'Read historical instrument definitions and validate their identifiers'};
const captionRoute=router.routeAll(captionBoxes,[captionEdge])[0];
assert.equal(captionRoute.labelMode,'segment');
assert.ok(captionRoute.labelLines.length>=4);
assert.ok(Math.abs(captionRoute.labelY-captionRoute.labelAnchor.y)>24,'Regression covers a first baseline far above the segment');
checkGeometry(captionBoxes,[captionEdge],[captionRoute]);
assert.throws(()=>checkGeometry(captionBoxes,[captionEdge],[{...captionRoute,labelRect:{...captionRoute.labelRect,y:captionRoute.labelRect.y-100}}]),/label stays beside its segment/,'A detached caption must still be rejected');
for(const expanded of [new Set(),new Set(parents.filter((_,i)=>i%2===0)),new Set(parents)]){
 const boxes=layout(expanded);
 for(const scenario of model.scenarios)for(const choices of [{},...terminalChoices(scenario)]){const edges=projected(boxes,scenario,choices),routes=router.routeAll(boxes,edges);checkGeometry(boxes,edges,routes);total+=routes.length;}
 const edges=model.edges.filter(e=>e.from!==e.to&&boxes.some(b=>b.id===e.from)&&boxes.some(b=>b.id===e.to)).map(e=>({...e,activeRoute:false}));
 checkGeometry(boxes,edges,router.routeAll(boxes,edges));total+=edges.length;
}
// Multiple outgoing arrows and a reciprocal arrow must not re-use the same boundary port.
const boxes=[{id:'a',x:0,y:0,w:285,h:118},{id:'b',x:430,y:0,w:285,h:118},{id:'c',x:860,y:0,w:285,h:118},{id:'d',x:430,y:258,w:285,h:118}];
const edges=[['a','b'],['b','a'],['b','c'],['b','d']].map(([from,to],i)=>({id:`fan-${i}`,from,to,displayLabel:`${i+1}. Проверить данные`,activeRoute:true}));
const routes=router.routeAll(boxes,edges);checkGeometry(boxes,edges,routes);
const ports=routes.flatMap((r,i)=>[...(edges[i].from==='b'?[r.sourcePort]:[]),...(edges[i].to==='b'?[r.targetPort]:[])]);
assert.equal(new Set(ports.map(p=>`${p.x},${p.y}`)).size,ports.length,'Boundary ports of separate interactions must be distinct');
const frameEdges=projected(layout(),model.scenarios[0]);
const frameRoutes=router.routeAll(layout(),frameEdges);
for(let i=0;i<frameRoutes.length;i++)for(let j=i+1;j<frameRoutes.length;j++)for(const [a,b]of segments(frameRoutes[i].points))for(const [c,d]of segments(frameRoutes[j].points)){
 let overlap=0;
 if(Math.abs(a.y-b.y)<eps&&Math.abs(c.y-d.y)<eps&&Math.abs(a.y-c.y)<eps)overlap=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x));
 if(Math.abs(a.x-b.x)<eps&&Math.abs(c.x-d.x)<eps&&Math.abs(a.x-c.x)<eps)overlap=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y));
 assert.ok(overlap<1,'Overview interactions must not share a line segment');
}
// Short interactions between adjacent children stay local, even when other
// expanded groups make the overall scene much larger. Both current and visited
// captions are covered without depending on any authored project's identifiers.
const localNodes=[{id:'container'},...Array.from({length:6},(_,i)=>({id:`child-${i}`,parent:'container'})),{id:'unrelated'},...Array.from({length:8},(_,i)=>({id:`other-${i}`,parent:'unrelated'}))];
const localLengths=[];
for(const expanded of [new Set(['container']),new Set(['container','unrelated'])])for(const current of ['near-forward','near-back']){
 const nestedBoxes=diagramLayout.layout(localNodes,expanded,{layout:{columns:2,cardWidth:285,columnGap:88,rowGap:100}}).boxes;
 const nestedEdges=[{id:'near-forward',from:'child-0',to:'child-1',displayLabel:'1. Проверить готовность',activeRoute:true,current:current==='near-forward'},{id:'near-back',from:'child-1',to:'child-0',displayLabel:'2. Вернуть результат',activeRoute:true,current:current==='near-back'}];
 const nestedRoutes=router.routeAll(nestedBoxes,nestedEdges);checkGeometry(nestedBoxes,nestedEdges,nestedRoutes);total+=nestedRoutes.length;
 for(const route of nestedRoutes){
  const edge=nestedEdges.find(e=>e.id===route.id),from=nestedBoxes.find(b=>b.id===edge.from),to=nestedBoxes.find(b=>b.id===edge.to);
  const size=segments(route.points).reduce((sum,[a,b])=>sum+Math.abs(a.x-b.x)+Math.abs(a.y-b.y),0),direct=Math.abs(from.x+from.w/2-to.x-to.w/2)+Math.abs(from.y+from.h/2-to.y-to.h/2);
  assert.ok(size<direct+600,`Adjacent children need a local route; got ${size} units for ${direct} center distance`);localLengths.push(size);
 }
}
// The smallest accepted root gutters must leave escape space for an interior card.
const tightBoxes=Array.from({length:9},(_,i)=>({id:`tight-${i}`,x:(i%3)*325,y:Math.floor(i/3)*158,w:285,h:118}));
const tightEdges=[5,1,7,3].map((to,i)=>({id:`tight-edge-${i}`,from:'tight-4',to:`tight-${to}`,activeRoute:false}));
checkGeometry(tightBoxes,tightEdges,router.routeAll(tightBoxes,tightEdges));total+=tightEdges.length;
console.log(`PASS ${total+routes.length} routes: orthogonal paths, source/target ports, no card intersections, attached nonoverlapping labels; adjacent-child route lengths ${localLengths.join(', ')}.`);

// Exercise the viewer's semantic path as well as the legacy dynamic router.
// Layout and port planning see every branch, regardless of playback position.
let semanticTotal=0;
const staticEdges=[...model.edges,...model.scenarios.flatMap(scenario=>scenario.steps)];
for(const expanded of [new Set(),new Set(parents.filter((_,i)=>i%2===0)),new Set(parents)]){
 const semanticBoxes=diagramLayout.layout(model.nodes,expanded,{...(model.view||{}),edges:staticEdges}).boxes;
 const visible=new Set(semanticBoxes.map(box=>box.id)),byId=new Map(model.nodes.map(node=>[node.id,node]));
 const ancestor=id=>{while(!visible.has(id))id=byId.get(id).parent;return id;};
 const planned=semanticPorts.plan(model,semanticBoxes,ancestor);
 function attach(rows){
  const dedup=new Map();
  for(const edge of planned.attach(rows)){
   if(edge.from===edge.to)continue;
   const key=[edge.from,edge.to,edge.sourceApiPort?.id,edge.targetApiPort?.id].join('|');
   if(!dedup.has(key)||edge.current||edge.activeRoute&&!dedup.get(key).activeRoute)dedup.set(key,edge);
  }
  return [...dedup.values()];
 }
 for(const scenario of model.scenarios)for(const choices of [{},...terminalChoices(scenario)]){
  const steps=core.pathFor(scenario,choices);
  for(const current of steps){
   const edges=attach(steps.map((step,index)=>({...step,originalFrom:step.from,originalTo:step.to,from:ancestor(step.from),to:ancestor(step.to),activeRoute:true,current:step.id===current.id,displayLabel:`${index+1}. ${step.title.length>30?step.title.slice(0,29)+'…':step.title}`})));
   checkGeometry(semanticBoxes,edges,router.routeAll(semanticBoxes,edges));semanticTotal+=edges.length;
  }
 }
 const edges=attach(model.edges.map(edge=>({...edge,originalFrom:edge.from,originalTo:edge.to,from:ancestor(edge.from),to:ancestor(edge.to),activeRoute:false})));
 checkGeometry(semanticBoxes,edges,router.routeAll(semanticBoxes,edges));semanticTotal+=edges.length;
}
console.log(`PASS ${semanticTotal} semantic routes: complete static topology, compact layouts, all branches/current steps, contract-bound endpoints, full container perimeters and readable captions.`);
