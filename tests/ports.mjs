#!/usr/bin/env node
/* Semantic connectors bind APIs to stable perimeter positions and real routes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ports=require('../iadkit/assets/ports.js'),routing=require('../iadkit/assets/routing.js');
const nodes=[{id:'client'},{id:'server'},{id:'worker',parent:'server'},{id:'observer'}];
const contracts=[{id:'request-api',node:'server',name:'Request API'},{id:'status-api',node:'server',name:'Status API'}];
const relationships=[
 {id:'submit',from:'client',to:'server',targetContract:'request-api'},
 {id:'status',from:'client',to:'server',targetContract:'status-api'},
 {id:'observe',from:'observer',to:'server',targetContract:'request-api'},
 {id:'unresolved',from:'client',to:'observer'},
];
const model={nodes,contracts,edges:relationships,scenarios:[{steps:[{id:'step',from:'client',to:'server',contracts:['request-api']}]}]};
const boxes=[{id:'client',x:0,y:0,w:285,h:118},{id:'server',x:430,y:0,w:285,h:118},{id:'observer',x:0,y:220,w:285,h:118}];
const plan=ports.plan(model,boxes),attached=plan.attach(relationships);
assert.notEqual(attached[0].targetApiPort.id,attached[1].targetApiPort.id,'Different APIs between the same participants remain distinct');
assert.equal(attached[0].targetApiPort.id,attached[2].targetApiPort.id,'Consumers share the same provided API port');
assert.equal(attached[0].sourceApiPort.kind,'required');
assert.equal(attached[0].sourceApiPort.owner,'client','Required connector belongs to its consumer');
assert.equal(attached[0].sourceApiPort.contractOwner,'server','Required API records its actual provider separately');
assert.equal(attached[0].targetApiPort.kind,'provided');
assert.equal(attached[3].sourceApiPort.kind,'connection');
assert.equal(attached[3].sourceApiPort.contract,null,'Missing contract never becomes an invented API');
const step=plan.attach([{...model.scenarios[0].steps[0]}])[0];
assert.equal(step.targetApiPort.id,attached[0].targetApiPort.id,'Scenario contract references use the structural API port');
const coordinates=planner=>planner.ports.map(port=>[port.id,port.border]);
assert.deepEqual(coordinates(ports.plan({...model,edges:[...relationships].reverse()},boxes)),coordinates(plan),'Relationship order does not move API ports');
assert.deepEqual(plan.attach([relationships[2],relationships[0]])[1].targetApiPort.border,attached[0].targetApiPort.border,'Playback subset does not move API ports');
for(const route of routing.routeAll(boxes,attached.map(edge=>({...edge,activeRoute:false})))){
 assert.ok(!route.unavailable,route.error?.message);
 const edge=attached.find(edge=>edge.id===route.id);
 assert.equal(route.sourceApiPortId,edge.sourceApiPort.id);
 assert.equal(route.targetApiPortId,edge.targetApiPort.id);
 assert.deepEqual(route.sourcePort,edge.sourceApiPort.border);
 assert.deepEqual(route.targetPort,edge.targetApiPort.border);
 assert.deepEqual(route.points[0],edge.sourceApiPort.point,'Path begins at its visible connector');
 assert.deepEqual(route.points.at(-1),edge.targetApiPort.point,'Path ends at its visible connector');
}
const compoundNodes=[{id:'a'},{id:'inner',parent:'a'},{id:'b'},{id:'inner-b',parent:'b'}];
const compoundBoxes=[
 {id:'a',parent:null,x:0,y:0,w:500,h:500,group:true,headerHeight:80,contentBounds:{x:24,y:100,w:452,h:376}},
 {id:'inner',parent:'a',x:80,y:150,w:285,h:118},
 {id:'b',parent:null,x:750,y:0,w:500,h:500,group:true,headerHeight:80,contentBounds:{x:774,y:100,w:452,h:376}},
 {id:'inner-b',parent:'b',x:830,y:150,w:285,h:118},
];
const compoundEdges=[{id:'external',from:'a',to:'b',targetContract:'remote-api'},{id:'internal',from:'a',to:'inner'}];
const compound={nodes:compoundNodes,contracts:[{id:'remote-api',node:'b',name:'Remote API'}],edges:compoundEdges,scenarios:[]};
const compoundPlan=ports.plan(compound,compoundBoxes),compoundAttached=compoundPlan.attach(compoundEdges),routes=routing.routeAll(compoundBoxes,compoundAttached.map(edge=>({...edge,activeRoute:false})));
routes.forEach(route=>assert.ok(!route.unavailable,route.error?.message));
assert.equal(compoundAttached[0].targetApiPort.border.x,750,'Expanded API lies on the complete module perimeter');
assert.ok(compoundAttached[0].targetApiPort.border.y>80,'Expanded API is not forced into the module header');
assert.equal(compoundAttached[1].sourceApiPort.internal,true);
assert.equal(compoundAttached[1].sourceApiPort.border.y,80,'Parent/child connectors use an explicitly rendered inner divider');
assert.equal(routes[1].domain,'a');
assert.ok(routes[0].points.every(point=>point.x>500&&point.x<750),'External API path stays outside both expanded modules');
const collapsedModel={nodes:compoundNodes,contracts:[{id:'worker-api',node:'inner-b',name:'Worker API'}],edges:[{id:'hidden-call',from:'inner',to:'inner-b',targetContract:'worker-api'}],scenarios:[]};
const projected=id=>id==='inner'?'a':id==='inner-b'?'b':id;
const collapsed=ports.plan(collapsedModel,compoundBoxes.filter(box=>box.group),projected);
const hidden=collapsed.attach([{...collapsedModel.edges[0],originalFrom:'inner',originalTo:'inner-b',from:'a',to:'b'}])[0];
assert.equal(hidden.targetApiPort.node,'b');
assert.equal(hidden.targetApiPort.owner,'inner-b','Collapsed boundary preserves the actual contract owner');
assert.equal(hidden.targetApiPort.contract,'worker-api');
const gateways={nodes:compoundNodes,contracts:[{id:'outbound',node:'a',name:'Outbound API'},{id:'inbound',node:'b',name:'Inbound API'}],edges:[{id:'gateway',from:'inner',to:'inner-b',sourceContract:'outbound',targetContract:'inbound'}],scenarios:[]};
const gateway=ports.plan(gateways,compoundBoxes).attach(gateways.edges)[0];
assert.equal(gateway.from,'a');assert.equal(gateway.to,'b');
assert.equal(gateway.sourceApiPort.node,'a');assert.equal(gateway.targetApiPort.node,'b');
assert.equal(gateway.originalFrom,'inner');assert.equal(gateway.originalTo,'inner-b');
assert.ok(!routing.routeAll(compoundBoxes,[{...gateway,activeRoute:false}])[0].unavailable,'Enclosing API owner is the visible routing boundary');
const siblings={nodes:[{id:'repo'},{id:'a',parent:'repo'},{id:'b',parent:'repo'}],contracts:[{id:'shared-api',node:'repo',name:'Shared enclosing API'}],edges:[{id:'sibling-call',from:'a',to:'b',contracts:['shared-api']}],scenarios:[]};
const siblingBoxes=[{id:'repo',x:0,y:0,w:800,h:400,group:true,headerHeight:80},{id:'a',parent:'repo',x:50,y:150,w:285,h:118},{id:'b',parent:'repo',x:450,y:150,w:285,h:118}];
const sibling=ports.plan(siblings,siblingBoxes).attach(siblings.edges)[0];
assert.equal(sibling.from,'a');assert.equal(sibling.to,'b','Shared-ancestor context must not erase a real internal relationship');
assert.equal(sibling.sourceApiPort.kind,'connection');assert.equal(sibling.targetApiPort.kind,'connection');
const compactBoxes=[{id:'scope',parent:null,x:0,y:0,w:381,h:488,group:true,headerHeight:80,contentBounds:{x:24,y:100,w:333,h:364}},{id:'check',parent:'scope',x:48,y:128,w:285,h:118},{id:'apply',parent:'scope',x:48,y:322,w:285,h:118}];
const compactEdges=[{id:'choose',from:'check',to:'apply',targetContract:'apply-api',displayLabel:'1. Check the local value',activeRoute:true},{id:'applied',from:'apply',to:'check',displayLabel:'2. Return the accepted result',activeRoute:true,current:true}];
const compactModel={nodes:[{id:'scope'},{id:'check',parent:'scope'},{id:'apply',parent:'scope'}],contracts:[{id:'apply-api',node:'apply',name:'Apply API'}],edges:compactEdges,scenarios:[]};
const compactRoutes=routing.routeAll(compactBoxes,ports.plan(compactModel,compactBoxes).attach(compactEdges));
for(const route of compactRoutes){
 assert.ok(!route.unavailable,route.error?.message);assert.ok(route.labelRect,'Compact reciprocal arrows each have a caption');
 assert.ok(route.labelLines.length>1,'Compact captions wrap into readable short lines');
 const length=route.points.slice(1).reduce((sum,p,i)=>sum+Math.abs(p.x-route.points[i].x)+Math.abs(p.y-route.points[i].y),0);
 assert.ok(length<200,'Caption wrapping keeps short reciprocal paths local');
}
console.log('PASS semantic API ports: stable identities, distinct contracts, shared provider, explicit unresolved links, full expanded perimeter, internal divider, hidden-owner projection, fixed routed endpoints.');
