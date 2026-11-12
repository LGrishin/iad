/* Pure local navigation. No project operation is executed by this player. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const choiceFor = (choices,id) => Object.prototype.hasOwnProperty.call(choices,id) ? choices[id] : undefined;
  const contractIds = item => [...new Set([...(item.contracts || []), item.sourceContract, item.targetContract].filter(id => id !== undefined && id !== null))];
  class IadError extends Error {
    constructor(code, message, details) { super(message); this.name = 'IadError'; this.code = code; this.details = details; }
  }
  const fail = (code, message, details) => { throw new IadError(code, message, details); };
  const getScenario = (model, id) => model.scenarios.find(s => s.id === id) || fail('NOT_FOUND', `Unknown scenario: ${id}`);
  function pathFor(scenario, choices = {}) {
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) fail('INVALID_ARGUMENT', 'Choices must be an object keyed by step ID');
    const byId = new Map(scenario.steps.map(s => [s.id, s]));
    const path = [], visited = new Set();
    let id = scenario.entry;
    while (id) {
      if (visited.has(id)) fail('CYCLE', `Scenario must have a finite explanatory path: ${id}`);
      visited.add(id);
      const step = byId.get(id) || fail('INVALID_MODEL', `Unknown step: ${id}`);
      path.push(step);
      if (step.branch) {
        const choice = choiceFor(choices,id);
        if (!choice) break;
        const option = step.branch.options.find(o => o.id === choice);
        if (!option) fail('INVALID_CHOICE', `Unknown option: ${choice}`);
        id = option.next;
      } else id = step.next;
    }
    return path;
  }
  function scenariosForScope(model, scope = null) {
    if (scope === null) return model.scenarios.filter(scenario=>(scenario.scope ?? null) === null);
    const byId=new Map(model.nodes.map(node=>[node.id,node]));
    if(!byId.has(scope))fail('NOT_FOUND', `Unknown scope: ${scope}`);
    const descendants=new Set([scope]);
    let count;
    do {count=descendants.size;for(const node of model.nodes)if(descendants.has(node.parent))descendants.add(node.id);} while(count!==descendants.size);
    const ancestors=new Set([null]);let node=byId.get(scope);
    while(node?.parent){ancestors.add(node.parent);node=byId.get(node.parent);}
    return model.scenarios.filter(scenario=>{
      const owner=scenario.scope ?? null;
      if(descendants.has(owner))return true;
      return ancestors.has(owner) && scenario.steps.some(step=>descendants.has(step.from)||descendants.has(step.to));
    });
  }
  function createPlayer(model) {
    if (!model.scenarios?.length) fail('INVALID_MODEL', 'At least one scenario is required');
    const sessions = Object.fromEntries(model.scenarios.map(s => [s.id, {index: 0, choices: {}, preview: null}]));
    let selected = model.scenarios[0].id;
    const session = () => sessions[selected];
    const scenario = () => getScenario(model, selected);
    const path = () => pathFor(scenario(), session().choices);
    const current = () => path()[session().index];
    const seek = index => {
      if (!Number.isFinite(index)) fail('INVALID_ARGUMENT', 'Step index must be finite');
      session().index = Math.max(0, Math.min(Math.trunc(index), path().length - 1));
      session().preview = null;
      return current();
    };
    return {
      sessions, session, scenario, path, current,
      select(id) { getScenario(model, id); selected = id; session().preview = null; return current(); },
      selected: () => selected,
      seek,
      next() { return seek(session().index + 1); },
      back() { return seek(session().index - 1); },
      restart() { return seek(0); },
      navigateTo(request) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_ARGUMENT', 'Navigation requires a request object');
        const {scenario: id = selected, stepId, choices = {}} = request;
        const target = getScenario(model, id), targetId = stepId ?? target.entry;
        if (!target.steps.some(step=>step.id===targetId)) fail('NOT_FOUND', `Unknown step: ${targetId}`);
        const route = pathFor(target, choices);
        for (const [key, optionId] of Object.entries(choices)) {
          const step=target.steps.find(item=>item.id===key);
          if (!step?.branch?.options.some(option=>option.id===optionId)) fail('INVALID_CHOICE', `Invalid decision: ${key} / ${optionId}`);
          if (!route.some(item=>item.id===key)) fail('INVALID_CHOICE', `Decision is outside the selected path: ${key}`);
        }
        const index=route.findIndex(step=>step.id===targetId);
        if (index<0) fail('INVALID_PATH', `Step ${targetId} is outside the selected path; provide the preceding branch choices`);
        selected=id;
        session().choices=Object.fromEntries(Object.entries(choices));
        session().index=index; session().preview=null;
        return current();
      },
      waiting() { return !!current().branch && !choiceFor(session().choices,current().id); },
      preview(id) {
        const option = current().branch?.options.find(o => o.id === id) || fail('INVALID_CHOICE', 'Current step has no such option');
        session().preview = id;
        return option;
      },
      confirm(id = session().preview) {
        const step = current();
        const option = step.branch?.options.find(o => o.id === id) || fail('INVALID_CHOICE', 'Preview an option first');
        // Keep earlier decisions; discard every decision after the fork being changed.
        const prior = path().slice(0, session().index).map(s => s.id);
        if (choiceFor(session().choices,step.id) !== option.id) {
          session().choices = Object.fromEntries(Object.entries(session().choices).filter(([key]) => prior.includes(key)));
        }
        Object.defineProperty(session().choices,step.id,{value:option.id,enumerable:true,writable:true,configurable:true});
        session().preview = null;
        if (option.next) session().index += 1;
        return current();
      },
      progress(nodeId) {
        const descendants = new Set([nodeId]);
        let size;
        do { size = descendants.size; model.nodes.filter(n => descendants.has(n.parent)).forEach(n => descendants.add(n.id)); } while (size !== descendants.size);
        return path().slice(0, session().index + 1).filter(s => descendants.has(s.from) || descendants.has(s.to)).length;
      }
    };
  }
  function createApi(model) {
    const node = id => model.nodes.find(n => n.id === id) || fail('NOT_FOUND', `Unknown node: ${id}`);
    function snapshot(target = model.manifest.target.id) {
      const selected = target === model.manifest.target.id ? model.nodes : (() => {
        node(target);
        const ids = new Set([target]);
        let size;
        do { size = ids.size; model.nodes.filter(n => ids.has(n.parent)).forEach(n => ids.add(n.id)); } while (size !== ids.size);
        return model.nodes.filter(n => ids.has(n.id));
      })();
      const ids = new Set(selected.map(n => n.id));
      const scenarios = model.scenarios.filter(s => s.steps.some(t => ids.has(t.from) || ids.has(t.to)));
      const edges = model.edges.filter(e => ids.has(e.from) || ids.has(e.to));
      const consumed = new Set([...scenarios.flatMap(s => s.steps), ...edges].flatMap(contractIds));
      return copy({schemaVersion: model.schemaVersion, target, manifest: model.manifest,
        nodes: selected, edges,
        contracts: model.contracts.filter(c => ids.has(c.node) || consumed.has(c.id)),
        scenarios, evidence: model.evidence || []});
    }
    const stable = value => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => !['sources', 'evidence', 'revision', 'url', 'line', 'generatedAt'].includes(k)).map(k => [k, stable(value[k])]));
      return value;
    };
    function compareSnapshots(before, after) {
      if (!before?.nodes || !after?.nodes || !before?.scenarios || !after?.scenarios) fail('INVALID_SNAPSHOT', 'Snapshots must contain nodes and scenarios');
      if (before.target !== after.target) fail('TARGET_MISMATCH', 'Snapshot targets differ');
      const changes = [];
      for (const kind of ['nodes', 'edges', 'contracts', 'scenarios']) {
        const a = new Map((before[kind] || []).map(x => [x.id, x]));
        const b = new Map((after[kind] || []).map(x => [x.id, x]));
        for (const id of new Set([...a.keys(), ...b.keys()])) {
          const status = !a.has(id) ? 'added' : !b.has(id) ? 'removed' : JSON.stringify(stable(a.get(id))) !== JSON.stringify(stable(b.get(id))) ? 'changed' : null;
          if (status) changes.push({kind, id, status, before: a.get(id) || null, after: b.get(id) || null});
        }
      }
      const scenarios = [];
      for (const id of new Set([...before.scenarios.map(s => s.id), ...after.scenarios.map(s => s.id)])) {
        const a = before.scenarios.find(s => s.id === id), b = after.scenarios.find(s => s.id === id);
        if (!a || !b) { scenarios.push({id, status: a ? 'removed' : 'added', firstDivergence: null}); continue; }
        // Intern bottom-up DAG summaries instead of materializing every fork
        // path. The shared table gives equal semantic subtrees an exact identity
        // (no hash collisions), and counts retain their expanded DFS ordinals.
        const summaries = new Map();
        const summarize = (s, snapshot) => {
          const steps = new Map(), contractsById = new Map();
          for (const step of s.steps) if (!steps.has(step.id)) steps.set(step.id, step);
          for (const contract of snapshot.contracts || []) if (!contractsById.has(contract.id)) contractsById.set(contract.id, contract);
          const nodes = new Map(), active = new Set(), pending = [{id:s.entry, finish:false}];
          while (pending.length) {
            const request = pending.pop();
            if (!request.id || nodes.has(request.id)) continue;
            const step = steps.get(request.id) || fail('INVALID_SNAPSHOT', `Unknown step: ${request.id}`);
            if (!request.finish) {
              if (active.has(step.id)) fail('CYCLE', `Cyclic snapshot scenario: ${step.id}`);
              active.add(step.id);
              pending.push({id:step.id, finish:true});
              const children = step.branch ? step.branch.options.map(option => option.next) : [step.next];
              for (let index=children.length-1; index>=0; index--) if (children[index]) pending.push({id:children[index], finish:false});
              continue;
            }
            const contracts = contractIds(step).map(id => contractsById.get(id) || fail('INVALID_SNAPSHOT', `Missing contract: ${id}`));
            // Linear successor links define traversal, rather than the action:
            // an inserted action must not focus its unchanged predecessor.
            const {next, ...action} = step;
            const signature = JSON.stringify(stable({step:action, contracts}));
            const children = step.branch ? step.branch.options.filter(option => option.next).map(option => ({node:nodes.get(option.next), decision:[step.id, option.id]})) : step.next ? [{node:nodes.get(step.next), decision:null}] : [];
            const summary = JSON.stringify([signature, children.map(child => [child.decision, child.node.summary])]);
            if (!summaries.has(summary)) summaries.set(summary, summaries.size);
            nodes.set(step.id, {step, contracts, signature, children, summary:summaries.get(summary), count:1n+children.reduce((count,child)=>count+child.node.count,0n)});
            active.delete(step.id);
          }
          return nodes.get(s.entry) || null;
        };
        // Validate both complete reachable graphs before looking for a mismatch,
        // so an early change never hides a later cycle or broken reference.
        const roots = [summarize(a, before), summarize(b, after)];
        const contexts = new Map(), rootContext = {id:0, parent:null};
        const decisionContext = (parent, decision) => {
          const key = JSON.stringify([parent.id, ...decision]);
          if (!contexts.has(key)) contexts.set(key, {id:contexts.size+1, parent, decision});
          return contexts.get(key);
        };
        const contextValue = context => {
          if (!context.value) {
            const decisions=[];
            for (let current=context; current.parent; current=current.parent) decisions.push(current.decision);
            decisions.reverse();
            context.value={route:decisions.map(([step,option])=>`/${step}:${option}`).join(''), choices:Object.fromEntries(decisions)};
          }
          return context.value;
        };
        const sameContext = (left, right) => {
          if (left===right) return true;
          const a=contextValue(left), b=contextValue(right);
          return a.route===b.route && JSON.stringify(stable(a.choices))===JSON.stringify(stable(b.choices));
        };
        const entry = task => {
          if (!task) return null;
          const {route, choices} = contextValue(task.context);
          return {key:`${route}/${task.node.step.id}`, step:task.node.step, contracts:task.node.contracts, choices:copy(choices)};
        };
        const streams = roots.map(node => node ? [{node, context:rootContext, expanded:false}] : []);
        const expand = stream => {
          const task=stream.pop();
          for (let index=task.node.children.length-1; index>=0; index--) {
            const child=task.node.children[index];
            stream.push({node:child.node, context:child.decision?decisionContext(task.context,child.decision):task.context, expanded:false});
          }
          stream.push({...task, expanded:true});
        };
        let divergence = null, ordinal = 1n;
        while (streams[0].length || streams[1].length) {
          const left=streams[0].at(-1), right=streams[1].at(-1);
          if (left && right && !left.expanded && !right.expanded && left.node.summary===right.node.summary && sameContext(left.context,right.context)) {
            ordinal+=left.node.count;streams[0].pop();streams[1].pop();continue;
          }
          if (left && !left.expanded) {expand(streams[0]);continue;}
          if (right && !right.expanded) {expand(streams[1]);continue;}
          if (!left || !right || left.node.signature!==right.node.signature || !sameContext(left.context,right.context)) {
            divergence={ordinal:ordinal<=BigInt(Number.MAX_SAFE_INTEGER)?Number(ordinal):ordinal.toString(), before:entry(left), after:entry(right)};break;
          }
          streams[0].pop();streams[1].pop();ordinal++;
        }
        scenarios.push({id, status: divergence ? 'changed' : 'same', firstDivergence: divergence});
      }
      return {before: before.manifest?.repositories, after: after.manifest?.repositories, changes, scenarios};
    }
    return {
      getManifest: () => copy(model.manifest),
      getScenarios: options => (options && Object.prototype.hasOwnProperty.call(options,'scope') ? scenariosForScope(model,options.scope) : model.scenarios).map(({id, title, goal, entry, mode, basis, scope, trigger}) => ({id, title, goal, entry, mode:mode || basis || 'code',scope:scope ?? null,...(trigger?{trigger:copy(trigger)}:{})})),
      resolveTarget(query) {
        if (typeof query !== 'string' || !query.trim()) fail('INVALID_ARGUMENT', 'Target query must be a nonempty string');
        const q = query.toLowerCase();
        const candidates = model.nodes.filter(n => n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)).map(n => ({id:n.id,label:n.label}));
        return {status: candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'not-found', candidates};
      },
      getChildren(id = null) { if (id) node(id); return copy(model.nodes.filter(n => (n.parent || null) === id)); },
      getEdges(id) { if (id) node(id); return copy(model.edges.filter(e => !id || e.from === id || e.to === id)); },
      getSteps(id, choices = {}) { return copy(pathFor(getScenario(model, id), choices)); },
      getOptions(id, stepId) {
        const step = getScenario(model, id).steps.find(s => s.id === stepId) || fail('NOT_FOUND', `Unknown step: ${stepId}`);
        return copy(step.branch?.options || []);
      },
      buildSnapshot: snapshot, compareSnapshots
    };
  }
  root.IADCore = {IadError, pathFor, scenariosForScope, createPlayer, createApi};
  if (typeof module !== 'undefined') module.exports = root.IADCore;
})(globalThis);
