#!/usr/bin/env node
/** Reproducible IAD checks. No engine code or external service is executed. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(directory,'..');
const require=createRequire(import.meta.url);
const core=require('../iadkit/assets/player.js');
const groups=[];
const clone=value=>JSON.parse(JSON.stringify(value));
const group=(name,run)=>{try {const details=run();groups.push({name,status:'passed',...(details?{details}:{})});}catch(error){groups.push({name,status:'failed',error:error.message});}};
const errorCode=(run,code)=>assert.throws(run,error=>error.code===code,`Expected IadError(${code})`);
const fixture=()=>({schemaVersion:1,manifest:{target:{id:'fixture'},repositories:[{id:'fixture',revision:'a'.repeat(40)}]},
  nodes:[{id:'a',label:'Entry'},{id:'group',label:'Group'},{id:'b',label:'Node B',parent:'group'},{id:'c',label:'Node C',parent:'group'}],
  edges:[{id:'a-b',from:'a',to:'b',label:'calls'},{id:'b-c',from:'b',to:'c',label:'checks'}],
  contracts:[{id:'api.fixture',node:'b',operation:'execute',inputs:'value',output:'committed',errors:'invalid value'}],
  scenarios:[{id:'alpha',title:'Alpha',goal:'Branching session',entry:'s0',steps:[
    {id:'s0',from:'a',to:'b',title:'Enter',output:'started',next:'s1'},
    {id:'s1',from:'b',to:'c',title:'Choose',contracts:['api.fixture'],branch:{options:[{id:'left',label:'Left',condition:'allowed',result:'continue',next:'s2'},{id:'right',label:'Right',condition:'refused',result:'finish',next:'s5'}]}},
    {id:'s2',from:'c',to:'b',title:'Revisit',output:'visited again',next:'s3'},
    {id:'s3',from:'b',to:'c',title:'Choose again',branch:{options:[{id:'continue',label:'Continue',condition:'ready',result:'complete',next:'s4'},{id:'stop',label:'Stop',condition:'stopped',result:'cancelled',next:'s6'}]}},
    {id:'s4',from:'c',to:'b',title:'Done',output:'success',next:null},
    {id:'s5',from:'c',to:'a',title:'Rejected',output:'rejection',next:null},
    {id:'s6',from:'c',to:'c',title:'Cancelled',output:'cancelled',next:null}
  ]},{id:'beta',title:'Beta',goal:'Independent session',entry:'b0',steps:[{id:'b0',from:'a',to:'c',title:'Other entry',next:'b1'},{id:'b1',from:'c',to:'b',title:'Other completion',next:null}]}]});

group('Player: independent scenario sessions',()=>{
 const p=core.createPlayer(fixture());p.seek(99);assert.equal(p.current().id,'s1');p.preview('left');p.confirm();p.next();p.preview('continue');p.confirm();
 const saved=clone(p.session());p.select('beta');assert.equal(p.current().id,'b0');p.next();p.select('alpha');assert.deepEqual(p.session(),saved);assert.equal(p.current().id,'s4');p.select('beta');assert.equal(p.current().id,'b1');
});
group('Player: one-step forward/back, bounded seeking, restart',()=>{
 const p=core.createPlayer(fixture());assert.equal(p.back().id,'s0');assert.equal(p.next().id,'s1');assert.equal(p.next().id,'s1');assert.equal(p.back().id,'s0');assert.equal(p.seek(-100).id,'s0');assert.equal(p.seek(100).id,'s1');assert.equal(p.restart().id,'s0');errorCode(()=>p.seek(NaN),'INVALID_ARGUMENT');
});
group('Player: preview leaves position, path and progress unchanged',()=>{
 const p=core.createPlayer(fixture());p.next();const position=p.session().index,pathIds=p.path().map(s=>s.id),progress=p.progress('group');
 assert.equal(p.preview('left').id,'left');assert.equal(p.preview('right').id,'right');assert.equal(p.current().id,'s1');assert.equal(p.session().index,position);assert.deepEqual(p.path().map(s=>s.id),pathIds);assert.deepEqual(p.session().choices,{});assert.equal(p.progress('group'),progress);assert.equal(p.waiting(),true);
 assert.equal(p.confirm().id,'s5');assert.equal(p.session().choices.s1,'right');
});
group('Player: seek stops at the first unchosen branch',()=>{
 const p=core.createPlayer(fixture());assert.equal(p.seek(10000).id,'s1');p.confirm('left');assert.equal(p.seek(10000).id,'s3');p.confirm('continue');assert.equal(p.seek(10000).id,'s4');
});
group('Player: changing a previous branch truncates its continuation',()=>{
 const p=core.createPlayer(fixture());p.next();p.confirm('left');p.next();p.confirm('continue');assert.equal(p.current().id,'s4');assert.ok(p.session().choices.s3);
 p.seek(1);p.preview('right');p.confirm();assert.equal(p.current().id,'s5');assert.deepEqual(p.session().choices,{s1:'right'});assert.deepEqual(p.path().map(s=>s.id),['s0','s1','s5']);
 p.seek(1);p.confirm('left');assert.equal(p.current().id,'s2');assert.equal(p.seek(999).id,'s3');assert.equal(p.waiting(),true);
});
group('Player: confirming the same branch preserves downstream decisions',()=>{
 const p=core.createPlayer(fixture());p.next();p.confirm('left');p.next();p.confirm('continue');const choices=clone(p.session().choices),route=p.path().map(s=>s.id);
 p.seek(1);p.preview('left');assert.equal(p.confirm().id,'s2');assert.deepEqual(p.session().choices,choices);assert.deepEqual(p.path().map(s=>s.id),route);assert.equal(p.seek(999).id,'s4');assert.equal(p.waiting(),false);
});
group('Player: repeated module visits and nested progress survive rewinding',()=>{
 const p=core.createPlayer(fixture());p.next();p.confirm('left');p.next();p.confirm('continue');assert.equal(p.progress('b'),5);assert.equal(p.progress('group'),5);p.back();assert.equal(p.progress('b'),4);p.seek(0);assert.equal(p.progress('group'),1);p.seek(999);assert.equal(p.progress('b'),5);
});
group('API: catalog, children, directed edges, paths and options',()=>{
 const api=core.createApi(fixture());assert.deepEqual(api.getScenarios().map(s=>s.id),['alpha','beta']);assert.deepEqual(api.getChildren('group').map(n=>n.id),['b','c']);assert.equal(api.getEdges('a')[0].from,'a');assert.equal(api.getEdges('a')[0].to,'b');
 assert.deepEqual(api.getSteps('alpha').map(s=>s.id),['s0','s1']);assert.deepEqual(api.getSteps('alpha',{s1:'left',s3:'stop'}).map(s=>s.id),['s0','s1','s2','s3','s6']);assert.equal(api.getOptions('alpha','s1').length,2);assert.deepEqual(api.getOptions('alpha','s0'),[]);
 const children=api.getChildren('group');children[0].label='mutated';assert.equal(api.getChildren('group')[0].label,'Node B');
});
group('API: useful errors and ambiguous target candidates',()=>{
 const model=fixture(),api=core.createApi(model);assert.equal(api.resolveTarget('Node').status,'ambiguous');assert.equal(api.resolveTarget('Node').candidates.length,2);assert.equal(api.resolveTarget('Entry').status,'resolved');assert.equal(api.resolveTarget('absent').status,'not-found');
 errorCode(()=>api.resolveTarget(''),'INVALID_ARGUMENT');errorCode(()=>api.getChildren('absent'),'NOT_FOUND');errorCode(()=>api.getEdges('absent'),'NOT_FOUND');errorCode(()=>api.getSteps('absent'),'NOT_FOUND');errorCode(()=>api.getOptions('alpha','absent'),'NOT_FOUND');errorCode(()=>api.getSteps('alpha',{s1:'unknown'}),'INVALID_CHOICE');errorCode(()=>api.buildSnapshot('absent'),'NOT_FOUND');
 const cycle=clone(model.scenarios[0]);cycle.steps[0].next='s0';errorCode(()=>core.pathFor(cycle),'CYCLE');const invalid=clone(model.scenarios[0]);invalid.steps[0].next='missing';errorCode(()=>core.pathFor(invalid),'INVALID_MODEL');
 const p=core.createPlayer(model);errorCode(()=>p.select('absent'),'NOT_FOUND');errorCode(()=>p.preview('left'),'INVALID_CHOICE');errorCode(()=>p.confirm(),'INVALID_CHOICE');
});
group('Snapshots: deterministic copies, equivalent source revisions ignored',()=>{
 const api=core.createApi(fixture()),before=api.buildSnapshot();assert.deepEqual(before,api.buildSnapshot());const after=clone(before);after.manifest.repositories[0].revision='b'.repeat(40);after.scenarios[0].steps[0].sources=[{revision:'b'.repeat(40),line:999}];
 const diff=api.compareSnapshots(before,after);assert.deepEqual(diff.changes,[]);assert.ok(diff.scenarios.every(s=>s.status==='same'&&s.firstDivergence===null));
 const small=api.buildSnapshot('group');assert.deepEqual(small.nodes.map(n=>n.id),['group','b','c']);before.nodes[0].label='mutated';assert.equal(api.buildSnapshot().nodes[0].label,'Entry');errorCode(()=>api.compareSnapshots({},{}),'INVALID_SNAPSHOT');errorCode(()=>api.compareSnapshots(api.buildSnapshot(),small),'TARGET_MISMATCH');
});
group('Snapshots: output and branch-condition changes expose the first divergence',()=>{
 const api=core.createApi(fixture()),before=api.buildSnapshot(),output=clone(before);output.scenarios[0].steps[0].output='queued';let diff=api.compareSnapshots(before,output);assert.equal(diff.scenarios[0].status,'changed');assert.equal(diff.scenarios[0].firstDivergence.before.step.id,'s0');
 const branch=clone(before);branch.scenarios[0].steps[1].branch.options[0].condition='allowed only before dispatch';diff=api.compareSnapshots(before,branch);assert.equal(diff.scenarios[0].status,'changed');assert.equal(diff.scenarios[0].firstDivergence.before.step.id,'s1');
});
group('Snapshots: contract guarantees affect their consuming scenario',()=>{
 const api=core.createApi(fixture()),before=api.buildSnapshot(),after=clone(before);after.contracts[0].output='queued';const diff=api.compareSnapshots(before,after);assert.ok(diff.changes.some(c=>c.kind==='contracts'&&c.id==='api.fixture'));assert.equal(diff.scenarios[0].status,'changed');assert.equal(diff.scenarios[0].firstDivergence.before.step.id,'s1');
});
group('Snapshots: explicit endpoint APIs and edge APIs survive scoped snapshots',()=>{
 const model=fixture();model.nodes.push({id:'outside',label:'External API owner'});
 for(const id of ['source-api','target-api','edge-source-api','edge-target-api','edge-api'])model.contracts.push({id,node:'outside',operations:[{name:'execute',description:'Execute',input:'value',output:'committed'}]});
 Object.assign(model.scenarios[0].steps[0],{sourceContract:'source-api',targetContract:'target-api',contracts:['source-api']});
 Object.assign(model.edges[0],{sourceContract:'edge-source-api',targetContract:'edge-target-api',contracts:['edge-api']});
 const api=core.createApi(model),before=api.buildSnapshot('a');
 assert.deepEqual(new Set(before.contracts.map(contract=>contract.id)),new Set(model.contracts.map(contract=>contract.id)));
 for(const id of ['source-api','target-api']){
  const after=clone(before);after.contracts.find(contract=>contract.id===id).operations[0].output='queued';
  const first=api.compareSnapshots(before,after).scenarios.find(scenario=>scenario.id==='alpha').firstDivergence;
  assert.equal(first.before.step.id,'s0');assert.deepEqual(first.before.contracts.map(contract=>contract.id),['source-api','target-api']);
 }
});

const comparisonModel=(count,branching=false)=>{
 const model=fixture();
 model.scenarios=[{id:'flow',title:'Flow',goal:'Walk a finite graph',entry:'step-0',steps:Array.from({length:count},(_,index)=>{
  const next=index+1<count?`step-${index+1}`:null;
  return {id:`step-${index}`,from:'a',to:'b',title:`Step ${index}`,input:'value',action:'Process value',output:'done',next:branching?null:next,...(branching&&next?{branch:{options:['left','right'].map(id=>({id,label:id,condition:id,result:'Continue',next}))}}:{})};
 })}];
 return model;
};
group('Comparison: reconverging branches skip shared paths and retain exact DFS ordinals',()=>{
 for(const count of [26,54]){
  const model=comparisonModel(count,true),scenario=model.scenarios[0];
  scenario.entry='choose';scenario.steps.unshift({id:'choose',from:'a',to:'b',title:'Choose',next:null,branch:{options:[{id:'shared',label:'Shared',condition:'shared',result:'Walk graph',next:'step-0'},{id:'last',label:'Last',condition:'last',result:'Finish',next:'tail'}]}});
  scenario.steps.push({id:'tail',from:'a',to:'b',title:'Finish',output:'old',next:null});
  const api=core.createApi(model),before=api.buildSnapshot(),after=clone(before);
  assert.equal(api.compareSnapshots(before,before).scenarios[0].status,'same');
  after.scenarios[0].steps.at(-1).output='new';
  const first=api.compareSnapshots(before,after).scenarios[0].firstDivergence,ordinal=(1n<<BigInt(count))+1n;
  assert.equal(first.ordinal,ordinal<=BigInt(Number.MAX_SAFE_INTEGER)?Number(ordinal):ordinal.toString());
  assert.equal(first.before.key,'/choose:last/tail');assert.deepEqual(first.before.choices,{choose:'last'});assert.equal(first.after.step.output,'new');
 }
});
group('Comparison: long linear paths are iterative and retain insertion semantics',()=>{
 const model=comparisonModel(5000),api=core.createApi(model),before=api.buildSnapshot(),after=clone(before);
 after.scenarios[0].steps.at(-1).output='Changed last action';
 let first=api.compareSnapshots(before,after).scenarios[0].firstDivergence;
 assert.equal(first.ordinal,5000);assert.equal(first.before.step.id,'step-4999');assert.deepEqual(first.before.choices,{});
 const inserted=clone(before);inserted.scenarios[0].steps[4998].next='inserted';inserted.scenarios[0].steps.push({id:'inserted',from:'a',to:'b',title:'Inserted',next:'step-4999'});
 first=api.compareSnapshots(before,inserted).scenarios[0].firstDivergence;
 assert.equal(first.ordinal,5000);assert.equal(first.before.step.id,'step-4999');assert.equal(first.after.step.id,'inserted');
});
group('Comparison: early differences never hide invalid reachable graph references',()=>{
 for(const side of ['before','after'])for(const invalid of ['cycle','step','contract','sourceContract','targetContract']){
  const api=core.createApi(fixture()),before=api.buildSnapshot(),after=clone(before);after.scenarios[0].steps[0].output='Early change';
  const target=({before,after})[side].scenarios[0].steps.find(step=>step.id==='s6');
  if(invalid==='cycle')target.next='s6';else if(invalid==='step')target.next='missing-step';else if(invalid==='contract')target.contracts=['missing-contract'];else target[invalid]='missing-contract';
  errorCode(()=>api.compareSnapshots(before,after),invalid==='cycle'?'CYCLE':'INVALID_SNAPSHOT');
 }
});
group('Comparison: DAG zipper matches the original DFS order on small graphs',()=>{
 const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>!['sources','evidence','revision','url','line','generatedAt'].includes(key)).map(key=>[key,stable(value[key])])):value;
 const reference=(before,after)=>{
  const signatures=snapshot=>{
   const scenario=snapshot.scenarios[0],list=[];
   const walk=(id,route,choices)=>{
    if(!id)return;const step=scenario.steps.find(item=>item.id===id),ids=[...new Set([...(step.contracts||[]),step.sourceContract,step.targetContract].filter(id=>id!==undefined&&id!==null))];
    list.push({key:`${route}/${step.id}`,step,contracts:ids.map(id=>snapshot.contracts.find(contract=>contract.id===id)),choices:clone(choices)});
    if(step.branch)for(const option of step.branch.options)walk(option.next,`${route}/${step.id}:${option.id}`,{...choices,[step.id]:option.id});else walk(step.next,route,choices);
   };
   walk(scenario.entry,'',{});return list;
  };
  const left=signatures(before),right=signatures(after),signature=entry=>{if(!entry)return null;const {next,...step}=entry.step;return stable({...entry,step});};
  for(let index=0;index<Math.max(left.length,right.length);index++)if(JSON.stringify(signature(left[index]))!==JSON.stringify(signature(right[index])))return {ordinal:index+1,before:left[index]||null,after:right[index]||null};
  return null;
 };
 let seed=24681357;const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 for(let sample=0;sample<160;sample++){
  const model=comparisonModel(4+random(6)),scenario=model.scenarios[0];
  for(let index=0;index<scenario.steps.length-1;index++)if(random(2)){
   scenario.steps[index].next=null;scenario.steps[index].branch={options:['left','right'].map(id=>({id,label:id,condition:id,result:'Continue',next:random(4)?`step-${index+1+random(scenario.steps.length-index-1)}`:null}))};
  }
  const api=core.createApi(model),before=api.buildSnapshot(),after=clone(before),target=after.scenarios[0].steps[random(scenario.steps.length)];
  switch(sample%6){
   case 0:target.output='Changed';break;
   case 1:if(target.branch)target.branch.options.reverse();else target.next=null;break;
   case 2:after.scenarios[0].entry=target.id;break;
   case 3:if(target.branch)target.branch.options[0].condition='Changed';else {const next=target.next;target.next='inserted';after.scenarios[0].steps.push({id:'inserted',from:'a',to:'b',title:'Inserted',next});}break;
   case 4:after.scenarios[0].steps.reverse();break;
   case 5:after.scenarios[0].steps.at(-1).sources=['new-evidence'];break;
  }
  assert.deepEqual(api.compareSnapshots(before,after).scenarios[0].firstDivergence,reference(before,after),`DFS sample ${sample}`);
 }
});

group('Player: empty models give an actionable error',()=>{errorCode(()=>core.createPlayer({scenarios:[]}),'INVALID_MODEL');});
group('Player/API: prototype-like IDs are ordinary authored identifiers',()=>{
 for(const id of ['constructor','toString','__proto__']){
  const m=fixture();m.scenarios[0].entry=id;m.scenarios[0].steps[0].id=id;m.scenarios[0].steps[0].next=null;
  m.scenarios[0].steps[0].branch={options:[{id:'yes',label:'Yes',next:'s1'},{id:'no',label:'No',next:null}]};
  const p=core.createPlayer(m);assert.equal(p.current().id,id);assert.equal(p.waiting(),true);p.preview('yes');p.confirm();assert.equal(p.current().id,'s1');
  p.seek(0);assert.equal(p.waiting(),false);p.confirm('no');assert.equal(p.current().id,id);assert.equal(p.waiting(),false);assert.equal(p.session().choices[id],'no');
  assert.equal(core.pathFor(m.scenarios[0]).length,1);assert.equal(core.createApi(m).getScenarios()[0].mode,'code');
 }
 errorCode(()=>core.pathFor(fixture().scenarios[0],null),'INVALID_ARGUMENT');
});
group('Player: explicit navigation reaches a branch path atomically',()=>{
 const p=core.createPlayer(fixture());p.navigateTo({scenario:'alpha',stepId:'s4',choices:{s1:'left',s3:'continue'}});
 assert.equal(p.current().id,'s4');assert.equal(p.session().index,4);assert.equal(p.session().preview,null);
 const saved=clone(p.sessions),selected=p.selected();
 errorCode(()=>p.navigateTo({scenario:'beta',stepId:'absent'}),'NOT_FOUND');assert.deepEqual(p.sessions,saved);assert.equal(p.selected(),selected);
 errorCode(()=>p.navigateTo({scenario:'alpha',stepId:'s4'}),'INVALID_PATH');assert.deepEqual(p.sessions,saved);
 errorCode(()=>p.navigateTo({scenario:'alpha',stepId:'s1',choices:{absent:'left'}}),'INVALID_CHOICE');assert.deepEqual(p.sessions,saved);
 p.navigateTo({scenario:'beta'});assert.equal(p.current().id,'b0');p.select('alpha');assert.equal(p.current().id,'s4');
});
group('Comparison: first divergence preserves structured branch choices',()=>{
 const m=fixture(),branch=m.scenarios[0].steps.find(s=>s.id==='s1');branch.id='choice:/one';m.scenarios[0].steps[0].next=branch.id;
 const api=core.createApi(m),before=api.buildSnapshot(),after=clone(before);
 after.scenarios[0].steps.find(s=>s.id==='s4').output='Changed completion';
 const divergence=api.compareSnapshots(before,after).scenarios.find(s=>s.id==='alpha').firstDivergence;
 assert.equal(divergence.before.step.id,'s4');assert.deepEqual(divergence.before.choices,{'choice:/one':'left',s3:'continue'});
 const p=core.createPlayer(m);p.navigateTo({scenario:'alpha',stepId:divergence.before.step.id,choices:divergence.before.choices});assert.equal(p.current().id,'s4');
});
group('Comparison: inserted action focuses the changed action after a common prefix',()=>{
 const m=fixture(),api=core.createApi(m),before=api.buildSnapshot(),after=clone(before);
 after.scenarios[0].steps[0].next='inserted';
 after.scenarios[0].steps.push({id:'inserted',from:'a',to:'a',title:'Added action',next:'s1'});
 const diff=api.compareSnapshots(before,after),first=diff.scenarios.find(s=>s.id==='alpha').firstDivergence;
 assert.equal(first.before.step.id,'s1');assert.equal(first.after.step.id,'inserted');assert.equal(first.ordinal,2);
 assert.ok(diff.changes.some(change=>change.kind==='scenarios'&&change.id==='alpha'));
});
group('Scope: overview and nested catalogues follow architecture boundaries',()=>{
 const model=fixture();model.nodes.push({id:'other',label:'Other repository'});
 model.scenarios[0].scope='group';model.scenarios[1].scope=null;
 model.scenarios.push({id:'other-flow',title:'Other flow',scope:'other',entry:'only',steps:[{id:'only',from:'other',to:'other',next:null}]});
 assert.deepEqual(core.scenariosForScope(model,null).map(s=>s.id),['beta']);
 assert.deepEqual(core.scenariosForScope(model,'group').map(s=>s.id),['alpha','beta']);
 assert.deepEqual(core.scenariosForScope(model,'other').map(s=>s.id),['other-flow']);
 assert.equal(core.createApi(model).getScenarios().length,3);
 assert.deepEqual(core.createApi(model).getScenarios({scope:null}).map(s=>s.id),['beta']);
 errorCode(()=>core.scenariosForScope(model,'missing'),'NOT_FOUND');
 const player=core.createPlayer(model);player.next();player.confirm('left');const saved=clone(player.session());
 core.scenariosForScope(model,'other');assert.deepEqual(player.session(),saved);
});
for(const item of groups) console.log(`${item.status==='passed'?'PASS':'FAIL'} ${item.name}${item.error?': '+item.error:''}`);
console.log(`${groups.filter(g=>g.status==='passed').length}/${groups.length} player/API groups passed`);
process.exitCode=groups.some(g=>g.status==='failed')?1:0;
