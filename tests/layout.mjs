#!/usr/bin/env node
/** Compound diagram invariants, independent of its DOM representation. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{layout}=require('../iadkit/assets/layout.js'),router=require('../iadkit/assets/routing.js');
const nodes=[{id:'client'},{id:'service'},...Array.from({length:7},(_,i)=>({id:`c${i}`,parent:'client'})),{id:'nested',parent:'client'},{id:'n1',parent:'nested'},{id:'n2',parent:'nested'},...Array.from({length:3},(_,i)=>({id:`s${i}`,parent:'service'}))];
const opened=new Set(['client','service','nested']),options={layout:{columns:2,cardWidth:285,columnGap:145,rowGap:140,childGap:22}};
const result=layout(nodes,opened,options),boxes=result.boxes,byId=new Map(boxes.map(b=>[b.id,b]));
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const contains=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.w<=outer.x+outer.w&&inner.y+inner.h<=outer.y+outer.h;
for(const box of boxes){
 assert.ok([box.x,box.y,box.w,box.h].every(Number.isFinite));assert.ok(box.w>=285);assert.ok(box.h>=118);
 if(box.parent){const parent=byId.get(box.parent);assert.ok(contains(parent.contentBounds,box),`${box.id} stays within its owner's diagram`);assert.equal(box.depth,parent.depth+1);}
 for(const peer of boxes.filter(b=>b.parent===box.parent&&b.id!==box.id))assert.ok(!overlap(box,peer),`${box.id}/${peer.id} sibling diagrams overlap`);
}
for(const parent of boxes.filter(b=>b.group)){
 const children=boxes.filter(b=>b.parent===parent.id);
 if(children.length>1){assert.ok(new Set(children.map(b=>b.x)).size>=2,'A multi-component group must be a 2D diagram, not a vertical list');assert.ok(parent.w>=285*2+80+128,'Expanded bounds provide space for readable cards and routes');}
 assert.ok(parent.headerHeight>=80);
}
assert.deepEqual(layout(nodes,opened,options),result,'The same hierarchy and expansion state have stable coordinates');
assert.deepEqual(layout(nodes,opened,{...options,viewportWidth:390}).boxes.filter(b=>b.parent==='nested').map(b=>b.x-byId.get('nested').x),boxes.filter(b=>b.parent==='nested').map(b=>b.x-byId.get('nested').x),'Mobile does not turn a nested graph into a list');
const edges=[{id:'inside',from:'c0',to:'c2',displayLabel:'1. Проверить запрос'},{id:'deep',from:'n1',to:'n2',displayLabel:'2. Передать данные'},{id:'outside',from:'c0',to:'s1',displayLabel:'3. Отправить запрос'},{id:'parent',from:'client',to:'c0',displayLabel:'4. Открыть компонент'}];
const routes=router.routeAll(boxes,edges),eps=.02;
const collision=(a,b,r)=>Math.abs(a.y-b.y)<eps?a.y>r.y+eps&&a.y<r.y+r.h-eps&&Math.max(a.x,b.x)>r.x+eps&&Math.min(a.x,b.x)<r.x+r.w-eps:a.x>r.x+eps&&a.x<r.x+r.w-eps&&Math.max(a.y,b.y)>r.y+eps&&Math.min(a.y,b.y)<r.y+r.h-eps;
for(let i=0;i<routes.length;i++){
 const route=routes[i],edge=edges[i];assert.ok(!route.unavailable,route.error?.message);assert.ok(route.labelRect,`${edge.id} has a label`);
 if(route.domain){
  const bounds=byId.get(route.domain).contentBounds;
  const relevant=route.points.filter((_,index)=>!(edge.from===route.domain&&index===0)&&!(edge.to===route.domain&&index===route.points.length-1));
  for(const point of relevant)assert.ok(contains(bounds,{...point,w:0,h:0}),`${edge.id} leaves its internal routing domain`);
  assert.ok(contains(bounds,route.labelRect),`${edge.id} label leaves its internal routing domain`);
 }
 const source=byId.get(edge.from),target=byId.get(edge.to);
 for(const group of boxes.filter(b=>b.group&&!source.ancestors.includes(b.id)&&!target.ancestors.includes(b.id)&&b.id!==edge.from&&b.id!==edge.to))for(let p=1;p<route.points.length;p++)assert.ok(!collision(route.points[p-1],route.points[p],group),`${edge.id} trespasses unrelated ${group.id}`);
}
assert.equal(routes[0].domain,'client');assert.equal(routes[1].domain,'nested');assert.equal(routes[2].domain,null);
// A deeply nested single-child hierarchy grows its bounds instead of shrinking
// descendant cards or producing negative dimensions.
const deep=Array.from({length:12},(_,i)=>({id:`d${i}`,...(i?{parent:`d${i-1}`}:{})}));
const deepLayout=layout(deep,new Set(deep.map(n=>n.id)),options);
assert.ok(deepLayout.boxes.every(b=>b.w>=285&&b.h>=118));assert.equal(deepLayout.boxes.length,12);
const impossible=router.routeAll([{id:'a',x:0,y:0,w:285,h:118}], [{id:'broken',from:'a',to:'missing'}])[0];
assert.equal(impossible.unavailable,true);assert.equal(impossible.error.code,'route-unavailable');assert.deepEqual(impossible.points,[]);
assert.deepEqual(layout([],new Set(),options),{boxes:[],dimensions:{w:1,h:1}});
// Small path-shaped diagrams use compact readable cards, not a wide grid. The
// graph is projected through descendants so a cross-component call is visible
// to the parent layout even when its concrete endpoints are nested.
const chainNodes=[{id:'third'},{id:'first'},{id:'second'}];
const chainEdges=[{id:'one',from:'first',to:'second',displayLabel:'1. Parse input'},{id:'two',from:'second',to:'third',displayLabel:'2. Store result'}];
const compact=layout(chainNodes,new Set(),{edges:chainEdges});
assert.equal(new Set(compact.boxes.map(b=>b.x)).size,1,'A small simple map uses one vertical column');
assert.deepEqual(compact.boxes.map(b=>b.id),['first','second','third'],'A path is ordered by connected neighbors');
assert.equal(compact.boxes[1].y-compact.boxes[0].y-compact.boxes[0].h,76,'Compact gap reserves routing stubs and labels');
assert.ok(compact.dimensions.w<layout(chainNodes,new Set()).dimensions.w,'Compact map occupies less width than the old grid');
assert.deepEqual(layout(chainNodes,new Set(),{edges:[...chainEdges].reverse()}),compact,'Reordering edges does not shuffle cards');
assert.deepEqual(layout(chainNodes,new Set(),{edges:chainEdges,rootOrder:['third','second','first']}).boxes.map(b=>b.id),['third','second','first'],'Explicit root order is respected');
const explicit=layout(chainNodes,new Set(),{edges:chainEdges,layout:{columns:3,rowGap:99}});
assert.equal(new Set(explicit.boxes.map(b=>b.x)).size,3,'Explicit root columns override automatic orientation');
const spaced=layout(chainNodes,new Set(),{edges:chainEdges,layout:{rowGap:99}});
assert.equal(spaced.boxes[1].y-spaced.boxes[0].y-spaced.boxes[0].h,99,'Explicit row spacing is retained');
assert.equal(new Set(layout(chainNodes,new Set(),{edges:[]}).boxes.map(b=>b.x)).size,1,'A few independent cards are also compact');
const branching=[{id:'hub'},...Array.from({length:3},(_,i)=>({id:`arm${i}`}))];
const branches=branching.slice(1).map(n=>({from:'hub',to:n.id}));
assert.ok(new Set(layout(branching,new Set(),{edges:branches}).boxes.map(b=>b.x)).size>1,'Branching graphs retain a two-dimensional grid');
const cycle=[...chainEdges,{from:'third',to:'first'}];
assert.ok(new Set(layout([...chainNodes,{id:'isolated'}],new Set(),{edges:cycle}).boxes.map(b=>b.x)).size>1,'A cycle plus isolated card is not misclassified as a forest');
const large=Array.from({length:6},(_,i)=>({id:`large${i}`}));
assert.ok(new Set(layout(large,new Set(),{edges:[]}).boxes.map(b=>b.x)).size>1,'Larger diagrams retain their routing grid');
const owned=[{id:'owner'},...chainNodes.map(n=>({...n,parent:'owner'})),{id:'implementation',parent:'first'}];
const ownedEdges=[{id:'inside',from:'implementation',to:'second',displayLabel:'1. Parse input'},chainEdges[1]];
const ownedLayout=layout(owned,new Set(['owner']),{edges:ownedEdges});
const ownedBoxes=ownedLayout.boxes.filter(b=>b.parent==='owner'),owner=ownedLayout.boxes.find(b=>b.id==='owner');
assert.equal(new Set(ownedBoxes.map(b=>b.x)).size,1,'Expanded containers use the same compact topology heuristic');
assert.deepEqual(ownedBoxes.map(b=>b.id),['first','second','third'],'Nested endpoints project onto direct sibling owners');
assert.ok(ownedBoxes.every(b=>contains(owner.contentBounds,b)),'Compact children remain within routing bounds');
assert.equal(owner.w,285+96,'Compact containers preserve card width and use tighter padding');
for(const route of router.routeAll(ownedLayout.boxes,chainEdges)){
 assert.ok(!route.unavailable,route.error?.message);
 assert.ok(route.labelRect,'Compact routing retains a readable caption');
 assert.ok(contains(owner.contentBounds,route.labelRect),'Compact caption stays in the expanded owner');
}
console.log('PASS compact topology: paths, forests, projections, explicit settings, dense/large fallback, readable routes.');
console.log('PASS compound layout: readable two-dimensional children, expanding bounds, sibling separation, stable/mobile geometry, deep hierarchy, bounded internal routes, unrelated container avoidance, route diagnostics.');
