(function () {
  'use strict';
  const model = JSON.parse(document.getElementById('iad-model').textContent);
  const sources = JSON.parse(document.getElementById('iad-sources').textContent);
  const api = IADCore.createApi(model), player = IADCore.createPlayer(model);
  window.IAD = api;
  const $ = id => document.getElementById(id);
  const projectName = model.manifest.project?.name || model.manifest.target.name || model.manifest.target.id;
  const view = model.view || {};
  const scoped = model.scenarios.some(s=>Object.prototype.hasOwnProperty.call(s,'scope')) || model.nodes.some(n=>n.kind==='repository');
  let activeScope = view.initialScope ?? null, routeDiagnostics=[], apiPorts=new Map();
  const rootOrder = new Map((view.rootOrder || []).map((id, i) => [id, i]));
  if (view.initialScenario) player.select(view.initialScenario);
  for (const [token, value] of Object.entries(view.theme?.colors || {})) {
    // Authoring validation limits this to declared color tokens and hexadecimal colors.
    if (/^--[a-z][a-z-]+$/.test(token) && /^#[0-9a-f]{3,8}$/i.test(value)) document.documentElement.style.setProperty(token, value);
  }
  const webLink = url => /^https?:\/\//i.test(url || '') ? url : null;
  const reviewNames = {reviewed:'Проверено по коду',unreviewed:'Требует проверки по коду',uncertain:'Есть неопределённость'};
  function reviewDetails(item, key) {
    const status = item.verification?.status || 'unreviewed';
    return disclose(`${key}:review`, `<span class="group-heading">${esc(reviewNames[status] || status)}</span>`, `${paragraphs(item.verification?.note || 'Это статус проверки описания действия. Доступность исходного файла проверяется отдельно.')} ${sourceButtons(item.sources)}`, 'verification disclosure-group');
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const choiceFor = (choices,id) => Object.prototype.hasOwnProperty.call(choices,id) ? choices[id] : undefined;
  const nodes = new Map(model.nodes.map(n => [n.id, n]));
  const evidence = new Map(model.evidence.map(e => [e.id, e]));
  const children = id => { const result = model.nodes.filter(n => (n.parent || null) === id); return id === null ? result.sort((a,b) => (rootOrder.get(a.id) ?? Infinity) - (rootOrder.get(b.id) ?? Infinity)) : result; };
  const label = id => nodes.get(id)?.label || id;
  const fieldNames = {name:'Операция',input:'Вход',inputs:'Вход',output:'Результат',errors:'Ошибки',condition:'Условие',result:'Последствие',next:'Следующий шаг',label:'Вариант',options:'Варианты'};
  const pretty = value => Array.isArray(value) ? value.map(pretty).join('\n') : value && typeof value === 'object' ? Object.entries(value).map(([k,v]) => `${fieldNames[k] || k}: ${pretty(v)}`).join('\n') : String(value ?? '');
  const expanded = new Set();
  const disclosures = new Map();
  let tab = 'step', inspected = null, timer = null, allEdges = false, boxes = new Map(), dimensions = {w:1200,h:800};
  let camera = {x:0,y:0,k:1}, comparisonModel = null;
  const sourceButtons = refs => (refs || []).map(id => {
    const source = evidence.get(id);
    return source ? `<button class="source-link" data-source="${esc(id)}">↗ ${esc(source.path)}:${source.line}<br>${esc(source.symbol)}</button>` : '';
  }).join('');
  const block = (title, text) => text ? `<section class="detail-block"><h3>${esc(title)}</h3><p>${esc(pretty(text))}</p></section>` : '';
  const paragraphs = text => String(text || '').split(/\n\s*\n/).filter(Boolean).map(part=>`<p>${esc(part)}</p>`).join('');
  function disclose(key, summary, body, classes='') {
    return `<details class="explanation ${classes}" data-disclosure="${esc(key)}" ${disclosures.get(key)?'open':''}><summary>${summary}</summary><div class="explanation-body">${body}</div></details>`;
  }
  function sourceDetails(key,refs) {
    if(!refs?.length)return '';
    return disclose(key,`<span class="group-heading">Исходники</span><span class="group-count">${refs.length}</span>`,sourceButtons(refs),'source-disclosure');
  }
  function roleDetails(node) {
    return disclose(`${node.id}:role`,`<span class="detail-summary">${esc(node.role || node.description)}</span><span class="disclosure-cue">Подробнее</span>`,`${paragraphs(node.details)}${sourceButtons(node.sources)}`,'node-description');
  }
  function ownedData(node) {
    const items=node.ownedData || [];
    if(!items.length && !node.ownership && !node.ownershipNote)return '';
    const summary=`<span class="group-heading">Данные во владении</span>${items.length?`<span class="group-count">${items.length}</span>`:''}`;
    const body=`${paragraphs(node.ownershipNote || (!items.length?node.ownership:''))}${items.map(item=>disclose(`${node.id}:data:${item.name}`,`<span class="item-heading"><code>${esc(item.name)}</code></span><span class="item-summary">${esc(item.description)}</span>`,`${item.type?`<div class="data-type">${esc(item.type)}</div>`:''}${paragraphs(item.details)}${sourceButtons(item.sources)}${item.target?`<button class="inline-node-link" data-inspect="${esc(item.target)}">На карте →</button>`:''}`,'owned-data-item')).join('')}`;
    return disclose(`${node.id}:data`,summary,body,'owned-data disclosure-group');
  }
  function termDefinitions(node) {
    if(!node.typeExplanations?.length)return '';
    return disclose(`${node.id}:terms`,`<span class="group-heading">Типы и термины</span><span class="group-count">${node.typeExplanations.length}</span>`,node.typeExplanations.map(term=>disclose(`${node.id}:term:${term.name}`,`<span class="item-heading"><code>${esc(term.name)}</code></span><span class="item-summary">${esc(term.description)}</span>`,`${paragraphs(term.details)}${sourceButtons(term.sources)}`,'term-definition')).join(''),'term-definitions disclosure-group');
  }
  function contractDetails(contract) {
    const operations=contract.operations || (contract.operation?[{name:contract.operation,input:contract.inputs,output:contract.output,errors:contract.errors}]:[]);
    const body=operations.map(operation=>{
      const op=typeof operation==='string'?{name:operation}:operation;
      const shortName=op.name.split('(')[0];
      return disclose(`${contract.id}:operation:${op.name}`,`<span class="item-heading"><code>${esc(shortName)}</code></span><span class="item-summary operation-purpose">${esc(op.description)}</span>`,`<div class="operation-signature"><code>${esc(op.name)}</code></div>${paragraphs(op.details)}<dl>${op.input?`<dt>Вход</dt><dd>${esc(pretty(op.input))}</dd>`:''}${op.output?`<dt>Результат и изменения состояния</dt><dd>${esc(pretty(op.output))}</dd>`:''}${op.errors?`<dt>Условия и ограничения</dt><dd>${esc(pretty(op.errors))}</dd>`:''}</dl>${sourceButtons(op.sources || contract.sources)}`,'contract-operation');
    }).join('');
    return disclose(`${contract.id}:operations`,`<span class="group-heading">${esc(contract.name || contract.id)}</span><span class="group-count">${operations.length}</span>${contract.description?`<span class="item-summary">${esc(contract.description)}</span>`:''}`,`${body}${sourceDetails(`${contract.id}:sources`,contract.sources)}`,'contract-details disclosure-group');
  }
  function componentDetails(node) {
    const components=children(node.id);
    if(!components.length)return '';
    return disclose(`${node.id}:components`,`<span class="group-heading">Компоненты</span><span class="group-count">${components.length}</span>`,components.map(component=>`<button class="child-link" data-inspect="${esc(component.id)}"><strong>${esc(component.label)} →</strong><span>${esc(component.role)}</span></button>`).join(''),'component-details disclosure-group');
  }
  const catalogScenarios=()=>scoped?IADCore.scenariosForScope(model,activeScope):model.scenarios;
  function isWithin(id,parent) {
    let node=nodes.get(id);
    while(node){if(node.id===parent)return true;node=nodes.get(node.parent);}return false;
  }
  function scopePath(id) {
    const path=[];let node=nodes.get(id);
    while(node){path.unshift(node);node=nodes.get(node.parent);}return path;
  }
  function revealAncestors(id) {
    let parent=nodes.get(id)?.parent;
    while(parent){expanded.add(parent);parent=nodes.get(parent)?.parent;}
  }
  function descendantCount(id) {
    return model.nodes.filter(node=>node.id!==id && isWithin(node.id,id)).length;
  }
  function focusContainer(id) {
    const b=boxes.get(id);if(!b)return;
    camera.x=32-b.x*camera.k;camera.y=120-b.y*camera.k;transform();
  }
  function setScope(id) {
    if(id!==null && !nodes.has(id))throw new IADCore.IadError('NOT_FOUND',`Unknown scope: ${id}`);
    pause();activeScope=id;inspected=id;tab=id===null?'step':'node';
    if(id!==null){revealAncestors(id);if(children(id).length)expanded.add(id);}
    render();if(id!==null)focusContainer(id);else fit();return viewState();
  }
  function renderScopeNavigation(catalog) {
    const nav=$('scope-navigation');nav.hidden=!scoped;
    if(!scoped)return;
    const path=scopePath(activeScope);
    nav.innerHTML=`<div class="scope-heading">Уровень архитектуры</div><div class="scope-path"><button data-scope="" ${activeScope===null?'aria-current="location"':''}>Обзор</button>${path.map(n=>`<span>›</span><button data-scope="${esc(n.id)}" ${activeScope===n.id?'aria-current="location"':''}>${esc(n.label)}</button>`).join('')}</div>${activeScope===null?`<div class="scope-repositories">${children(null).filter(n=>n.kind==='repository').map(n=>`<button data-scope="${esc(n.id)}">Внутри ${esc(n.label)} →</button>`).join('')}</div>`:`<button class="scope-up" data-scope="${esc(nodes.get(activeScope)?.parent || '')}">↑ На уровень выше</button>`}`;
    const note=$('scope-route-note'),visible=catalog.some(s=>s.id===player.selected());note.hidden=visible;
    if(!visible)note.innerHTML=`Текущий маршрут относится к другому уровню. <button data-scope="${esc(player.scenario().scope || '')}">Показать его сценарии →</button>`;
  }
  function versionContext(node) {
    const ids=new Set();
    const addNode=id=>{let n=nodes.get(id);while(n){if(n.repository)ids.add(n.repository);n=nodes.get(n.parent);}};
    if(node)addNode(node.id);else{addNode(player.current().from);addNode(player.current().to);}
    if(!ids.size)return `версия ${primaryRevision.slice(0,7)}`;
    return [...ids].map(id=>{const r=model.manifest.repositories?.find(r=>r.id===id);return `${id}@${r?.revision?.slice(0,7) || '?'}`;}).join(', ');
  }
  function questionTemplate(node=null) {
    const project=projectName;
    const intro=`Помоги разобраться с вопросом по IAD проекта «${project}» (${versionContext(node)}): `;
    let context;
    if(node) {
      const path=[];
      let participant=node;
      while(participant){path.unshift(participant.label);participant=nodes.get(participant.parent);}
      context=`участник «${node.label}».\nПуть на карте: ${[project,...path].join(' → ')}.`;
    } else {
      const scenario=player.scenario(),step=player.current(),session=player.session();
      const number=model.scenarios.findIndex(s=>s.id===scenario.id)+1;
      context=`сценарий ${number} «${scenario.title}», шаг ${session.index+1} «${step.title}».`;
      if(scoped)context+=`\nУровень сценария: ${scopePath(scenario.scope).map(n=>n.label).join(' → ') || 'Обзор'}. ID: ${scenario.id}.`;
      const choices=player.path().slice(0,session.index+1).flatMap(item=>{
        const option=item.branch?.options.find(o=>o.id===choiceFor(session.choices,item.id));
        return option?[`«${item.title}» → «${option.label}»`]:[];
      });
      if(choices.length)context+=`\nВыбранные ветки: ${choices.join('; ')}.`;
    }
    const text=`${intro}${context}\nВопрос: `;
    return `<section class="question-template" data-question-kind="${node?'module':'step'}" aria-label="Шаблон вопроса"><div class="question-template-heading"><h3>Задать вопрос</h3><button type="button" data-copy-question>Скопировать</button></div><textarea id="question-template-text" class="question-template-text" readonly rows="5" spellcheck="false" aria-label="Шаблон вопроса — скопируйте и допишите вопрос">${esc(text)}</textarea><p class="question-copy-status" role="status" aria-live="polite"></p></section>`;
  }
  async function copyQuestion(button) {
    const section=button.closest('.question-template'),field=section.querySelector('textarea'),status=section.querySelector('.question-copy-status');
    const text=field.value;
    button.disabled=true;
    let copied=false;
    try {
      if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);copied=true;}
    } catch { /* Keep manual selection available if clipboard access is denied. */ }
    if(!copied && section.isConnected) {
      field.focus();field.select();
      try {copied=document.execCommand('copy');} catch { /* Manual copy remains available. */ }
    }
    if(section.isConnected) {
      status.textContent=copied?'Скопировано. Допишите свой вопрос.':'Текст выделен. Нажмите ⌘C или Ctrl+C и допишите вопрос.';
      button.disabled=false;
    }
  }
  const primaryRevision = model.manifest.revision || model.manifest.repositories?.find(r => r.id === model.manifest.primaryRepository)?.revision || '';
  $('revision').textContent = primaryRevision.slice(0,7);
  $('revision').title = (model.manifest.repositories || []).filter(r=>r.included!==false).map(r=>`${r.id}: ${r.revision}`).join('\n');
  $('scenario-count').textContent = `${model.scenarios.length} СЦЕНАРИЕВ`;
  if (innerWidth < 961) document.querySelector('.workspace').classList.add('details-hidden');
  const pathLengthCache = new WeakMap();
  function maxPathLength(scenario) {
    if(pathLengthCache.has(scenario))return pathLengthCache.get(scenario);
    // Process successors before their callers. Shared continuations are counted
    // once, and long finite scenarios do not consume the JavaScript call stack.
    const pending=new Map(), predecessors=new Map(), lengths=new Map(), ready=[];
    for(const step of scenario.steps) {
      const nexts=new Set((step.branch?step.branch.options.map(option=>option.next):[step.next]).filter(id=>id!=null));
      pending.set(step.id,nexts.size);lengths.set(step.id,1);
      if(!nexts.size)ready.push(step.id);
      for(const id of nexts) {
        if(!predecessors.has(id))predecessors.set(id,[]);
        predecessors.get(id).push(step.id);
      }
    }
    for(let index=0;index<ready.length;index++) {
      const id=ready[index];
      for(const previous of predecessors.get(id) || []) {
        lengths.set(previous,Math.max(lengths.get(previous),1+lengths.get(id)));
        pending.set(previous,pending.get(previous)-1);
        if(pending.get(previous)===0)ready.push(previous);
      }
    }
    if(ready.length!==scenario.steps.length)throw new IADCore.IadError('INVALID_MODEL','Scenario successors must form a finite graph');
    const length=lengths.get(scenario.entry) || 0;
    pathLengthCache.set(scenario,length);return length;
  }
  function pause() {
    if (timer) clearInterval(timer);
    timer = null;
    $('play').textContent = '▶ Пуск';
  }
  function showDetails() {
    document.querySelector('.workspace').classList.remove('details-hidden');
    $('details-toggle').setAttribute('aria-expanded','true');
    requestAnimationFrame(ensureVisible);
  }
  function renderSidebar() {
    const catalog=catalogScenarios();renderScopeNavigation(catalog);
    $('scenario-count').textContent = `${catalog.length} СЦЕНАРИЕВ`;
    $('scenario-list').innerHTML = catalog.map(scenario => {
      const i=model.scenarios.indexOf(scenario);
      const session = player.sessions[scenario.id], path = IADCore.pathFor(scenario,session.choices);
      const progress = session.index + 1;
      return `<button class="scenario-card ${scenario.id === player.selected()?'active':''}" data-scenario="${esc(scenario.id)}" aria-pressed="${scenario.id===player.selected()}"><span class="scenario-number">${String(i+1).padStart(2,'0')}</span><span class="scenario-name">${esc(scenario.title)}</span><span class="scenario-info">По коду · шаг ${progress} / ${path.length}${path.at(-1).branch && !choiceFor(session.choices,path.at(-1).id)?' +':''}</span><span class="scenario-progress"><i style="width:${progress/maxPathLength(scenario)*100}%"></i></span></button>`;
    }).join('') || '<p class="scope-empty">Для этого уровня отдельные сценарии ещё не описаны. Выберите соседний уровень или участника карты.</p>';
  }
  function renderDetails() {
    $('tab-step').classList.toggle('selected',tab==='step');
    $('tab-node').classList.toggle('selected',tab==='node');
    if (tab === 'node') {
      const id = inspected || visibleAncestor(player.current().to), node = nodes.get(id);
      if (!node) return;
      const contracts = model.contracts.filter(c=>c.node===id);
      $('detail-content').innerHTML = `<div class="detail-eyebrow">${node.kind==='external'?'ВНЕШНИЙ API':'УЧАСТНИК АРХИТЕКТУРЫ'}</div><h2 class="detail-title">${esc(node.label)}</h2>${roleDetails(node)}${ownedData(node)}${termDefinitions(node)}${node.availability || node.status?disclose(`${node.id}:availability`,'<span class="group-heading">Подключение</span>',paragraphs(pretty(node.availability || node.status)),'disclosure-group'):''}${componentDetails(node)}${contracts.map(contractDetails).join('')}${questionTemplate(node)}`;
      return;
    }
    const step = player.current(), session = player.session();
    const option = step.branch?.options.find(o=>o.id===session.preview);
    const next = option && player.scenario().steps.find(s=>s.id===option.next);
    $('detail-content').innerHTML = `<div class="detail-eyebrow">ШАГ ${session.index+1} · ПО КОДУ</div><h2 class="detail-title">${esc(step.title)}</h2><div class="flow-participants">${esc(label(step.from))}<span>↓ ${step.from===step.to?'локальная операция':'передаёт управление / данные'}</span>${esc(label(step.to))}</div>${player.scenario().preconditions?`<details class="scenario-context" ${session.index===0?'open':''}><summary>Условия сценария</summary><p>${esc(pretty(player.scenario().preconditions))}</p></details>`:''}${block('На входе',step.input)}${block('Что происходит',step.action)}${block('Результат',step.output)}${step.nuance?`<div class="nuance">${esc(step.nuance)}</div>`:''}${step.branch?`<section class="branch-box"><h3>◇ Точка выбора</h3><p class="branch-explanation">Откройте вариант, чтобы прочитать условие. Подтверждение меняет маршрут.</p>${step.branch.options.map(o=>`<button class="branch-option ${session.preview===o.id?'preview':''} ${choiceFor(session.choices,step.id)===o.id?'confirmed':''}" data-option="${esc(o.id)}" aria-pressed="${session.preview===o.id}">${esc(o.label)}</button>`).join('')}${option?`<div class="branch-preview"><strong>УСЛОВИЕ</strong>${esc(option.condition)}<strong>ПОСЛЕДСТВИЕ</strong>${esc(option.result)}<strong>СЛЕДУЮЩИЙ ШАГ</strong>${esc(next?.title || 'Завершение маршрута')}</div>`:''}<button id="confirm-option" class="primary" ${!option?'disabled':''}>Выбрать и продолжить →</button></section>`:''}<section class="detail-block"><h3>Основание в исходниках</h3>${sourceButtons(step.sources)}</section>${reviewDetails(step,player.scenario().id+':'+step.id)}`;
    $('detail-content').insertAdjacentHTML('beforeend',questionTemplate());
  }
  function visibleAncestor(id) {
    let node = nodes.get(id);
    while (node && !boxes.has(node.id)) node = nodes.get(node.parent);
    return node?.id || id;
  }
  function renderLayout() {
    const result=IADLayout.layout(model.nodes,expanded,{...view,edges:[...model.edges,...model.scenarios.flatMap(s=>s.steps)],viewportWidth:innerWidth});
    boxes=new Map(result.boxes.map(box=>[box.id,box]));dimensions=result.dimensions;
  }
  function short(text,limit=28) { return text.length>limit?text.slice(0,limit-1)+'…':text; }
  function routeNodes() { return new Set(player.path().flatMap(s=>[visibleAncestor(s.from),visibleAncestor(s.to)])); }
  function apiPortMarkup(port, currentPorts) {
    const {x,y}=port.border,vertical=port.side==='left'||port.side==='right',half=10;
    const line=vertical?`M${x},${y-half} V${y+half}`:`M${x-half},${y} H${x+half}`;
    const known=port.kind!=='connection',kind=port.kind==='provided'?'Предоставляет API':port.kind==='required'?'Использует API':'Связь · API не указан';
    const title=`${kind}: ${port.label} · ${label(port.node)}`;
    // Captions stay inside their card so routing corridors remain available.
    const tx=port.side==='left'?x+10:port.side==='right'?x-10:x;
    const ty=port.side==='top'?y+14:port.side==='bottom'?y-10:y-5;
    const anchor=port.side==='left'?'start':port.side==='right'?'end':'middle';
    const caption=known?short(port.label,23):'API не указан',cw=caption.length*5.5+12,cx=anchor==='start'?tx-6:anchor==='end'?tx-cw+6:tx-cw/2;
    return `<g class="api-port ${esc(port.kind)} ${currentPorts.has(port.id)?'current':''}" data-api-port="${esc(port.id)}" data-api-node="${esc(port.node)}" ${port.contract?`data-api-contract="${esc(port.contract)}"`:''} role="button" tabindex="0" aria-label="${esc(title)}"><title>${esc(title)}</title><path class="api-port-hit" d="${line}"/><path class="api-port-bar" d="${line}"/><g class="api-port-caption"><rect x="${cx}" y="${ty-12}" width="${cw}" height="18" rx="4"/><text class="api-port-label" x="${tx}" y="${ty}" text-anchor="${anchor}">${esc(caption)}</text></g></g>`;
  }
  function renderMap() {
    renderLayout();
    const portPlan=IADPorts.plan(model,[...boxes.values()],visibleAncestor);
    apiPorts=new Map(portPlan.ports.map(port=>[port.id,port]));
    const path=player.path(), current=player.current(), active=visibleAncestor(current.to), sender=visibleAncestor(current.from), route=routeNodes();
    const projected=[];
    for (const edge of model.edges) {
      const from=visibleAncestor(edge.from),to=visibleAncestor(edge.to);
      if (from===to || !boxes.has(from) || !boxes.has(to)) continue;
      if (!allEdges) continue;
      projected.push({...edge,originalFrom:edge.from,originalTo:edge.to,from,to,activeRoute:false});
    }
    for (const [ordinal,step] of path.entries()) {
      const from=visibleAncestor(step.from),to=visibleAncestor(step.to);
      if (from===to || !boxes.has(from)||!boxes.has(to)) continue;
      projected.push({...step,originalFrom:step.from,originalTo:step.to,from,to,label:step.title,ordinal:ordinal+1,current:step.id===current.id,activeRoute:true});
    }
    const dedup=new Map();
    for(const edge of portPlan.attach(projected)) {
      if(edge.from===edge.to)continue;
      const key=[edge.from,edge.to,edge.sourceApiPort?.id,edge.targetApiPort?.id].join('|');
      if (!dedup.has(key) || edge.current || (edge.activeRoute && !dedup.get(key).activeRoute)) dedup.set(key,edge);
    }
    const rows=[...dedup.values()].sort((a,b)=>Number(a.current)-Number(b.current)).map(edge=>({...edge,displayLabel:edge.activeRoute?`${edge.ordinal}. ${short(edge.label||'',30)}`:''}));
    let edgesHtml='', sourceMarkers='', labelsHtml='';
    const currentPorts=new Set(rows.filter(edge=>edge.current).flatMap(edge=>[edge.sourceApiPort?.id,edge.targetApiPort?.id]));
    const routedEdges=IADRouting.routeAll([...boxes.values()],rows);
    routeDiagnostics=[];
    rows.forEach((edge,i)=>{
      const routed=routedEdges[i];
      if(routed.unavailable || !routed.points?.length){routeDiagnostics.push({edge:edge.id,label:edge.label,from:edge.from,to:edge.to,message:routed.error?.message || 'Путь недоступен'});return;}
      const cls=`edge ${edge.activeRoute?'active-route':''} ${edge.current?'current':''} ${edge.kind==='dependency'?'dependency':''}`;
      const seekAttr=edge.activeRoute?`data-seek="${edge.ordinal-1}"`:'';
      edgesHtml+=`<path data-edge="${esc(edge.id)}" data-source-port="${esc(routed.sourceApiPortId || '')}" data-target-port="${esc(routed.targetApiPortId || '')}" ${seekAttr} d="${routed.path}" class="${cls}" marker-end="url(#arrow-${edge.activeRoute?'active':'muted'})"><title>${esc(label(edge.originalFrom || edge.from)+' → '+label(edge.originalTo || edge.to)+': '+edge.label)}</title></path>`;
      if(edge.activeRoute) {
        const start=routed.points[0];
        sourceMarkers+=`<circle class="edge-source ${edge.current?'current':''}" data-edge="${esc(edge.id)}" cx="${start.x}" cy="${start.y}" r="2.8"><title>${esc('Начало: '+label(edge.from))}</title></circle>`;
      }
      if(edge.activeRoute && routed.labelX===null)routeDiagnostics.push({edge:edge.id,label:edge.label,from:edge.from,to:edge.to,message:'Не найдено место для подписи в области этой связи.'});
      if(edge.activeRoute && routed.labelX!==null) {
        if(routed.labelLeader)labelsHtml+=`<path class="label-leader" data-edge="${esc(edge.id)}" d="${routed.labelLeader}"/>`;
        labelsHtml+=`<text data-edge="${esc(edge.id)}" ${seekAttr} x="${routed.labelX}" y="${routed.labelY}" class="edge-label ${edge.current?'current':''}"><title>${esc(edge.label)}</title>${(routed.labelLines || [edge.displayLabel]).map((line,index)=>`<tspan x="${routed.labelX}" dy="${index?14:0}">${esc(line)}</tspan>`).join('')}</text>`;
      }
    });
    let groupBackgrounds='';
    const nodeHtml=[...boxes.values()].map(b=>{
      const node=nodes.get(b.id),onRoute=route.has(b.id),isActive=b.id===active,hasKids=children(b.id).length;
      const repositoryVersion=node.repository?model.manifest.repositories?.find(r=>r.id===node.repository)?.revision:null;
      const kind=node.kind==='repository'?'РЕПОЗИТОРИЙ'+(repositoryVersion?' · '+repositoryVersion.slice(0,7):''):node.kind==='external'?'ВНЕШНИЙ API':node.kind==='actor'?'УЧАСТНИК':node.kind==='host'?'ВАРИАНТ ЗАПУСКА':node.kind==='application'?'ПРИЛОЖЕНИЕ':b.group?'МОДУЛЬ / ДИАГРАММА':node.kind==='component'?'КОМПОНЕНТ':node.kind==='group'?'ПОДСИСТЕМА':'МОДУЛЬ';
      const classes=`node ${b.group?'group':''} ${node.kind==='repository'?'repository':''} ${onRoute?'on-route':'dim'} ${isActive?'active':''} ${inspected===b.id&&tab==='node'?'inspected':''} ${node.kind==='external'?'external':''}`;
      const progress=player.progress(b.id),nodeName=short(node.label,Math.max(12,Math.floor((b.w-62)/8)));
      const subtitle=node.role || node.description || node.subtitle || '';
      const inside=hasKids?descendantCount(b.id):0;
      const badge=progress?'✓ пройдено '+progress+' шаг.'+(inside?' · '+inside+' узлов внутри':''):hasKids?hasKids+' компонентов · '+inside+' узлов внутри':'контракт и исходники';
      const content=`<text x="${b.x+17}" y="${b.y+21}" class="node-type">${esc(kind)}${b.group?' · '+hasKids+' узлов':''}</text><text x="${b.x+17}" y="${b.y+46}" class="node-title">${esc(nodeName)}</text><text x="${b.x+17}" y="${b.y+68}" class="node-subtitle">${esc(short(subtitle,Math.max(20,Math.floor((b.w-36)/6.8))))}</text>${!b.group?`<text x="${b.x+17}" y="${b.y+91}" class="node-badge">${esc(badge)}</text>`:''}`;
      const rectangle=`<rect class="card" ${b.group?`data-node-body="${esc(b.id)}"`:''} x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10"/>`;
      if(b.group)groupBackgrounds+=`<g class="${classes} group-background">${rectangle}<path class="group-divider" d="M${b.x},${b.y+b.headerHeight} H${b.x+b.w}"/></g>`;
      const name=esc(node.label),action=hasKids?(expanded.has(b.id)?'свернуть':'раскрыть'):'подробности';
      const headerStart=hasKids?`<g class="node-header" data-node-header="${esc(b.id)}" role="button" tabindex="0" aria-expanded="${expanded.has(b.id)}" aria-label="${name}, ${action}">`:'';
      const surface=b.group?`<rect class="node-header-surface" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.headerHeight}" rx="10" fill="transparent"/>`:rectangle;
      return `<g class="${classes}" data-node="${esc(b.id)}" data-header-height="${b.headerHeight || 0}" role="${hasKids?'group':'button'}" ${hasKids?'':'tabindex="0"'} aria-label="${name}${hasKids?'':', подробности'}"><title>${esc(node.label+' — '+node.role)}</title>${headerStart}${surface}${content}${hasKids?`<text x="${b.x+b.w-22}" y="${b.y+23}" class="node-badge">${expanded.has(b.id)?'⊟':'⊞'}</text></g>`:''}${isActive?`<circle cx="${b.x+b.w-25}" cy="${b.y+41}" r="12" class="step-badge"/><text x="${b.x+b.w-25}" y="${b.y+45}" class="step-badge-label">${player.session().index+1}</text>`:''}</g>`;
    }).join('');
    $('routing-status').hidden=!routeDiagnostics.length;
    $('routing-status').textContent=`Требуют проверки ${routeDiagnostics.length} связей · подробности`;
    $('scene').innerHTML=groupBackgrounds+edgesHtml+sourceMarkers+nodeHtml+labelsHtml+portPlan.ports.map(port=>apiPortMarkup(port,currentPorts)).join('');
    transform();
    const focus=inspected || active,ancestors=[];
    let cursor=nodes.get(focus);
    while(cursor){ancestors.unshift(cursor);cursor=nodes.get(cursor.parent);}
    $('breadcrumbs').innerHTML=`<button data-root>${esc(projectName)}</button>`+ancestors.map(n=>`<span>/</span><button data-inspect="${esc(n.id)}">${esc(n.label)}</button>`).join('');
  }
  function transform() {
    $('scene').setAttribute('transform',`translate(${camera.x} ${camera.y}) scale(${camera.k})`);
    $('zoom-value').textContent=Math.round(camera.k*100)+'%';
  }
  function availableRect() {
    const rect=$('map').getBoundingClientRect();
    const detail=$('details').getBoundingClientRect();
    const overlay=!document.querySelector('.workspace').classList.contains('details-hidden') && innerWidth<961;
    const width=overlay?Math.max(140,Math.min(rect.width,detail.left-rect.left)):rect.width;
    return {w:width,h:rect.height};
  }
  function fit(full=false) {
    const rect=availableRect();
    const overview=Math.max(.13,Math.min(1.1,(rect.w-95)/dimensions.w,(rect.h-215)/dimensions.h));
    camera.k=full?overview:Math.max(innerWidth<650?.85:.9,overview);
    camera.x=full?(rect.w-dimensions.w*camera.k)/2:30;
    camera.y=full?165+(rect.h-215-dimensions.h*camera.k)/2:185;
    transform();
    ensureVisible();
  }
  function ensureVisible(focusId=null) {
    if(typeof focusId!=='string')focusId=null;
    focusId=focusId || (tab==='node'?inspected:null);
    const rect=availableRect(),step=player.current(),receiver=boxes.get(visibleAncestor(focusId || step.to));
    if(!receiver)return;
    const header=110,footer=65;
    const anchor=box=>({x:box.x,y:box.y,w:box.w,h:box.group?Math.min(box.h,box.headerHeight || 80):box.h});
    let b=anchor(receiver);
    const sender=boxes.get(visibleAncestor(step.from));
    if(!focusId && sender && sender.id!==receiver.id) {
      const a=anchor(sender),left=Math.min(a.x,b.x),top=Math.min(a.y,b.y);
      const pair={x:left,y:top,w:Math.max(a.x+a.w,b.x+b.w)-left,h:Math.max(a.y+a.h,b.y+b.h)-top};
      if(pair.w*camera.k<=rect.w-40 && pair.h*camera.k<=rect.h-header-footer)b=pair;
    }
    const bw=b.w*camera.k,bh=b.h*camera.k;
    const x=b.x*camera.k+camera.x,y=b.y*camera.k+camera.y;
    if (x<20)camera.x+=20-x;
    else if(x+bw>rect.w-20)camera.x-=x+bw-rect.w+20;
    if(y<header)camera.y+=header-y;
    else if(y+bh>rect.h-footer)camera.y-=y+bh-rect.h+footer;
    transform();
  }
  function render() {
    const scenario=player.scenario(),step=player.current(),session=player.session(),path=player.path();
    $('map-title').textContent=scenario.title;
    $('map-subtitle').textContent=scenario.goal;
    $('step-title').textContent=step.title;
    $('step-counter').textContent=`${String(session.index+1).padStart(2,'0')} / ${String(path.length).padStart(2,'0')}${path.at(-1).branch&&!choiceFor(session.choices,path.at(-1).id)?' +':''}`;
    $('timeline').innerHTML=path.map((s,i)=>`<button class="${i<session.index?'visited':''} ${i===session.index?'current':''} ${s.branch?'fork':''}" data-seek="${i}" title="${i+1}. ${esc(s.title)}" aria-label="Шаг ${i+1}: ${esc(s.title)}" ${i===session.index?'aria-current="step"':''}></button>`).join('');
    $('scrubber').max=Math.max(maxPathLength(scenario),path.length)-1;
    $('scrubber').value=session.index;
    $('back').disabled=session.index===0;
    $('next').disabled=session.index===path.length-1;
    $('player-status').textContent=player.waiting()?'◇ Выберите ветку в деталях':session.index===path.length-1?'✓ Маршрут завершён':'Локальный просмотр · код не исполняется';
    $('play').textContent=timer?'Ⅱ Пауза':'▶ Пуск';
    renderSidebar();renderMap();renderDetails();ensureVisible();
    window.dispatchEvent(new CustomEvent('iad-view-change',{detail:viewState()}));
  }
  function start() {
    if(timer){pause();tab='step';render();return;}
    if(player.waiting()){tab='step';showDetails();render();return;}
    if(player.session().index===player.path().length-1) player.restart();
    timer=setInterval(()=>{
      if(player.waiting() || player.session().index===player.path().length-1){pause();render();return;}
      player.next();tab='step';
      if(player.current().branch){pause();showDetails();}
      render();
    },Number($('speed').value));
    render();
  }
  function navigate(action) {pause();action();tab='step';render();if(player.waiting())showDetails();}
  function inspect(id,toggle=false) {
    inspected=id;tab='node';
    let parent=nodes.get(id)?.parent;
    while(parent){expanded.add(parent);parent=nodes.get(parent)?.parent;}
    let opened=false;
    if(toggle && children(id).length){
      if(expanded.has(id)){expanded.delete(id);if(scoped && activeScope!==null && isWithin(activeScope,id))activeScope=nodes.get(id)?.parent || null;}
      else{expanded.add(id);opened=true;if(scoped)activeScope=id;}
    }
    showDetails();render();if(opened)focusContainer(id);
  }
  function openModal(title,html) {$('modal-title').textContent=title;$('modal-content').innerHTML=html;$('modal').showModal();}
  function openApiPort(id) {
    const port=apiPorts.get(id);if(!port)return;
    const contract=model.contracts.find(item=>item.id===port.contract);
    const kind=port.kind==='provided'?'ПРЕДОСТАВЛЯЕТ API':port.kind==='required'?'ИСПОЛЬЗУЕТ API':'СВЯЗЬ · API НЕ УКАЗАН';
    const nodeLink=id=>`<button class="api-participant" data-inspect="${esc(id)}">${esc(label(id))} →</button>`;
    const peers=[...new Set(port.peers || [])];
    const implementations=[...new Set(port.owners || [port.owner])].filter(id=>id&&id!==port.node);
    const usage=port.connections || [];
    const refs=[...new Set(usage.flatMap(item=>item.sources || []))];
    if(contract)disclosures.set(`${contract.id}:operations`,true);
    openModal(contract?.name || port.label,`<article class="api-inspector" ${contract?`data-api-contract="${esc(contract.id)}"`:''}><div class="detail-eyebrow">${kind}</div><h2 class="detail-title">${esc(contract?.name || port.label)}</h2><div class="api-context"><div><span>Точка на карте</span>${nodeLink(port.node)}</div>${contract?`<div><span>Владелец API</span>${nodeLink(contract.node)}</div>`:''}${implementations.length?`<div><span>Компоненты внутри</span>${implementations.map(nodeLink).join('')}</div>`:''}${peers.length?`<div><span>Связанные участники</span>${peers.map(nodeLink).join('')}</div>`:''}</div>${contract?contractDetails(contract):'<p class="api-unknown">API не указан в данных диаграммы. Эта отметка показывает место связи; она не подтверждает наличие отдельного интерфейса в исходниках.</p>'}${usage.length?disclose(`${port.id}:usage`,'<span class="group-heading">Использование в связях и сценариях</span>',`<ul>${[...new Set(usage.map(item=>`${label(item.from)} → ${label(item.to)}: ${item.title || item.label || item.id}`))].map(text=>`<li>${esc(text)}</li>`).join('')}</ul>${sourceButtons(refs)}`,'api-usage'):''}${questionTemplate(nodes.get(port.owner) || nodes.get(port.node))}</article>`);
  }
  function openSource(id,full=false) {
    const ref=evidence.get(id); if(!ref)return; const file=sources[ref.sourceKey];
    const lines=file?.text?.split('\n') || ['Исходник недоступен в локальном снимке.'];
    if(file?.text?.endsWith('\n'))lines.pop();
    const begin=full?0:Math.max(0,ref.line-10),end=full?lines.length:Math.min(lines.length,ref.line+24);
    const html=`<div class="source-meta">${esc(ref.repo)} · ${esc(ref.revision)}<br>${esc(ref.path)}:${ref.line} · ${esc(ref.symbol)}<br>${webLink(ref.url)?`<a href="${esc(webLink(ref.url))}" target="_blank" rel="noreferrer">Открыть эту ревизию в репозитории ↗</a>`:'Ссылка на сервер для этого репозитория не настроена.'}<br>Снимок: ${esc(ref.sourceIntegrity?.status || 'unavailable')}. Основание: ${esc(ref.support?.kind || 'reference')}; ${esc(reviewNames[ref.support?.status || 'unreviewed'])}.${ref.support?.note?`<br>${esc(ref.support.note)}`:''}</div><div class="code">${lines.slice(begin,end).map((line,i)=>`<div class="code-line ${begin+i+1===ref.line?'target':''}"><span class="line-no">${begin+i+1}</span><span>${esc(line)}</span></div>`).join('')}</div>${!full?`<button class="quiet" data-full-source="${esc(id)}">Показать весь файл (${lines.length} строк)</button>`:''}`;
    if($('modal').open){$('modal-title').textContent=ref.path;$('modal-content').innerHTML=html;}else openModal(ref.path,html);
    if(full)requestAnimationFrame(()=>document.querySelector('.code-line.target')?.scrollIntoView({block:'center'}));
  }
  function download(name,data) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function about() {
    const manifest=model.manifest;
    const initial=model.scenarios.find(s=>s.id===view.initialScenario) || model.scenarios[0];
    const metadata=manifest.metadata || {};
    openModal(`IAD / ${projectName}`,`<article class="about-copy"><h3>Карта проекта</h3><p>Начните со сценария «${esc(initial.title)}». Маршруты объясняют действия через границы модулей. ${esc(metadata.summary || '')}</p><p>Ревизия: <code>${esc(primaryRevision)}</code>. Использованные исходники включены в HTML и доступны без сети. Ссылка на сервер, если настроена, ведёт к той же версии файла.</p><h3>Как исследовать</h3><p>Нажмите шапку модуля, чтобы раскрыть его внутреннюю диаграмму; повторное нажатие шапки сворачивает её. Свободное место внутри можно перетаскивать. Небольшие простые группы выстраиваются вертикально. В многорепозиторной карте каталог сценариев соответствует явно выбранному уровню; обзор начинается с пользовательских действий. Позиция, решения и прогресс сохраняются при раскрытии и переключении сценариев. На развилке изучите варианты, затем нажмите «Выбрать и продолжить». Перемотка останавливается у первой невыбранной развилки.</p><p>Стрелки выбранного маршрута показывают его шаги; «Все связи» добавляет остальные описанные связи. Пунктир обозначает зависимость. Краткие описания раскрываются по нажатию, подробности содержат ссылки на код. Утолщённые отметки на контурах — точки подключения: золотая предоставляет API, красная использует API, серая пунктирная показывает связь с ещё не описанным API. Наведите указатель для имени или нажмите отметку, чтобы изучить интерфейс, связанные компоненты и исходники.</p><h3>Проверка описаний</h3><p>Совпадение снимка с Git или архивом подтверждает происхождение текста. Статус проверки действия и вид основания (вызов, регистрация, объявление, трасса) указываются отдельно. Непроверенное описание нельзя считать подтверждённым только потому, что файл существует.</p>${metadata.executionOrder?`<h3>Порядок исполнения</h3>${paragraphs(pretty(metadata.executionOrder))}`:''}<h3>Границы и ограничения</h3>${(model.limitations || []).map(t=>`<p>• ${esc(pretty(t))}</p>`).join('')}<h3>Снимки и API</h3><p>Можно скачать снимок и сравнить его с другой IAD-моделью через «Сравнить со снимком». Сравнение модели не анализирует произвольный Git-коммит. API доступен как <code>window.IAD</code>; контракт описан в <code>docs/api.md</code>.</p><p>Все элементы управления меняют только локальный просмотр. IAD Kit ${esc(manifest.kitVersion || '')}.</p></article>`);
  }
  async function compareFile(file) {
    try {
      const parsed=JSON.parse(await file.text()),before=parsed.nodes&&parsed.manifest&&!parsed.target?IADCore.createApi(parsed).buildSnapshot():parsed;
      const after=api.buildSnapshot(),result=api.compareSnapshots(before,after);
      comparisonModel=before;
      openModal('Сравнение снимков',`<div class="about-copy"><p>До: ${esc(pretty(result.before))}<br>После: ${esc(primaryRevision)}</p><p>Архитектурных изменений: ${result.changes.length}. Сравниваются представленные элементы моделей; поведение непредставленных участков неизвестно.</p></div>${result.scenarios.map(s=>`<div class="comparison-item"><strong>${esc(model.scenarios.find(x=>x.id===s.id)?.title||s.id)}</strong> · ${s.status==='same'?'маршруты совпадают':esc(s.status)}${s.firstDivergence?`<p>Первое расхождение по обходу веток:<br>до: ${esc(s.firstDivergence.before?.step.title || 'отсутствует')}<br>после: ${esc(s.firstDivergence.after?.step.title || 'отсутствует')}</p><button data-divergence="${esc(s.id)}" data-before-step="${esc(s.firstDivergence.before?.step.id||'')}" data-after-step="${esc(s.firstDivergence.after?.step.id||'')}">Показать оба шага и основания</button>`:''}</div>`).join('')}${result.changes.filter(c=>c.kind!=='scenarios').map(c=>`<div class="comparison-item">${esc(c.kind)} · ${esc(c.id)} · ${esc(c.status)}<p>До: ${esc(pretty(c.before))}</p><p>После: ${esc(pretty(c.after))}</p></div>`).join('')}`);
    } catch(error){openModal('Не удалось сравнить',`<p class="error-message">${esc(error.code || 'INVALID_JSON')}: ${esc(error.message)}</p>`);}
  }
  document.addEventListener('click',event=>{
    if(dragMoved && event.target.closest('#map'))return;
    const target=event.target.closest('[data-api-port],[data-node-header],[data-scope],[data-scenario],[data-node],[data-option],[data-source],[data-seek],[data-inspect],[data-root],[data-full-source],[data-divergence]');
    if(!target)return;
    if(target.dataset.apiPort)openApiPort(target.dataset.apiPort);
    else if(target.dataset.nodeHeader)inspect(target.dataset.nodeHeader,true);
    else if(target.hasAttribute('data-scope'))setScope(target.dataset.scope || null);
    else if(target.dataset.scenario){pause();player.select(target.dataset.scenario);if(scoped && !catalogScenarios().some(s=>s.id===player.selected()))activeScope=player.scenario().scope ?? null;inspected=null;tab='step';render();}
    else if(target.dataset.node){if(!children(target.dataset.node).length)inspect(target.dataset.node);}
    else if(target.dataset.option){pause();player.preview(target.dataset.option);renderDetails();}
    else if(target.dataset.source)openSource(target.dataset.source);
    else if(target.dataset.fullSource)openSource(target.dataset.fullSource,true);
    else if(target.dataset.seek!==undefined)navigate(()=>player.seek(Number(target.dataset.seek)));
    else if(target.dataset.inspect){if(target.closest('.api-inspector'))$('modal').close();inspect(target.dataset.inspect);}
    else if(target.hasAttribute('data-root')){expanded.clear();inspected=null;activeScope=null;render();fit();}
    else if(target.dataset.divergence){
      const oldStep=comparisonModel?.scenarios.find(s=>s.id===target.dataset.divergence)?.steps.find(s=>s.id===target.dataset.beforeStep);
      const newStep=model.scenarios.find(s=>s.id===target.dataset.divergence)?.steps.find(s=>s.id===target.dataset.afterStep);
      openComparisonSteps(oldStep,newStep);
    }
  });
  function openComparisonSteps(before,after) {
    const view=(s,old)=>s?`<h3>${old?'До':'После'}: ${esc(s.title)}</h3>${block('Вход',s.input)}${block('Действие',s.action)}${block('Результат',s.output)}${block('Условие / варианты',s.branch)}${old?`<p class="source-meta">${(s.sources||[]).map(id=>{const e=comparisonModel.evidence?.find(x=>x.id===id);return e?`${esc(e.path)}:${e.line} · ${esc(e.revision)} ${webLink(e.url)?`<a href="${esc(webLink(e.url))}" target="_blank" rel="noreferrer">код ↗</a>`:''}`:esc(id);}).join('<br>')}</p>`:sourceButtons(s.sources)}`:'<p>Шаг отсутствует</p>';
    $('modal-title').textContent='Первое расхождение';$('modal-content').innerHTML=`<div class="about-copy">${view(before,true)}${view(after,false)}</div>`;
  }
  document.addEventListener('click',event=>{if(event.target.closest('#confirm-option'))navigate(()=>player.confirm());});
  document.addEventListener('click',event=>{
    const copy=event.target.closest('[data-copy-question]');
    if(copy)void copyQuestion(copy);
    else if(event.target.matches('.question-template-text'))event.target.select();
  });
  document.addEventListener('toggle',event=>{
    const element=event.target;
    if(element.matches('details[data-disclosure]') && element.isConnected)disclosures.set(element.dataset.disclosure,element.open);
  },true);
  $('play').onclick=start;$('back').onclick=()=>navigate(()=>player.back());$('next').onclick=()=>navigate(()=>player.next());$('restart').onclick=()=>navigate(()=>player.restart());
  $('scrubber').oninput=event=>navigate(()=>player.seek(Number(event.target.value)));
  $('speed').onchange=()=>{if(timer){pause();start();}};
  $('tab-step').onclick=()=>{tab='step';renderDetails();};$('tab-node').onclick=()=>{tab='node';renderDetails();};
  $('all-edges').onclick=()=>{allEdges=!allEdges;$('all-edges').setAttribute('aria-pressed',String(allEdges));renderMap();};
  $('details-toggle').onclick=()=>{const hidden=document.querySelector('.workspace').classList.toggle('details-hidden');$('details-toggle').setAttribute('aria-expanded',String(!hidden));requestAnimationFrame(ensureVisible);};
  $('close-details').onclick=()=>{document.querySelector('.workspace').classList.add('details-hidden');$('details-toggle').setAttribute('aria-expanded','false');};
  $('close-modal').onclick=()=>$('modal').close();$('modal').onclick=event=>{if(event.target===$('modal'))$('modal').close();};
  $('routing-status').onclick=()=>openModal('Связи, требующие проверки расположения',routeDiagnostics.map(d=>`<p>${esc(label(d.from))} → ${esc(label(d.to))}: ${esc(d.label)}<br>${esc(d.message)}</p>`).join(''));
  $('about').onclick=about;$('home').onclick=event=>{event.preventDefault();expanded.clear();activeScope=null;render();fit();};
  $('download-model').onclick=()=>download(model.manifest.target.id+'-iad-model.json',model);
  $('download-snapshot').onclick=()=>download(model.manifest.target.id+'-iad-snapshot.json',{...api.buildSnapshot(),evidence:model.evidence});
  $('compare-file').onchange=event=>{if(event.target.files[0])compareFile(event.target.files[0]);event.target.value='';};
  $('fit').onclick=()=>fit(true);
  function zoom(factor,x,y){const next=Math.min(2.6,Math.max(.13,camera.k*factor)),ratio=next/camera.k;camera.x=x-(x-camera.x)*ratio;camera.y=y-(y-camera.y)*ratio;camera.k=next;transform();}
  $('zoom-in').onclick=()=>{const r=availableRect();zoom(1.2,r.w/2,r.h/2);};$('zoom-out').onclick=()=>{const r=availableRect();zoom(1/1.2,r.w/2,r.h/2);};
  $('map').addEventListener('wheel',event=>{event.preventDefault();const r=$('map').getBoundingClientRect();zoom(Math.exp(-event.deltaY*.0015),event.clientX-r.left,event.clientY-r.top);},{passive:false});
  let drag=null,dragMoved=false;
  $('map').addEventListener('pointerdown',event=>{if(event.button!==0 || !event.isPrimary)return;drag={x:event.clientX,y:event.clientY,cx:camera.x,cy:camera.y};dragMoved=false;});
  $('map').addEventListener('pointermove',event=>{if(!drag)return;if(!(event.buttons&1)){drag=null;return;}const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!dragMoved&&Math.abs(dx)+Math.abs(dy)<=4)return;if(!dragMoved){dragMoved=true;$('map').setPointerCapture(event.pointerId);$('map').classList.add('dragging');}camera.x=drag.cx+dx;camera.y=drag.cy+dy;transform();});
  const endDrag=()=>{drag=null;$('map').classList.remove('dragging');setTimeout(()=>{dragMoved=false;},0);};
  window.addEventListener('pointerup',endDrag);window.addEventListener('pointercancel',endDrag);
  document.addEventListener('keydown',event=>{
    if(event.target.closest('input,select,textarea,button,a,summary')||$('modal').open)return;
    if(['Enter',' '].includes(event.key)) {
      const port=event.target.closest('[data-api-port]'),header=event.target.closest('[data-node-header]'),node=event.target.closest('[data-node][role="button"]');
      if(port){event.preventDefault();openApiPort(port.dataset.apiPort);return;}
      if(header){event.preventDefault();inspect(header.dataset.nodeHeader,true);return;}
      if(node){event.preventDefault();inspect(node.dataset.node);return;}
    }
    if(event.key==='ArrowRight'){event.preventDefault();navigate(()=>player.next());}
    else if(event.key==='ArrowLeft'){event.preventDefault();navigate(()=>player.back());}
    else if(event.code==='Space'){event.preventDefault();start();}
  });
  let compactLayout=innerWidth<650;
  new ResizeObserver(()=>{
    if(compactLayout!==(innerWidth<650)){compactLayout=innerWidth<650;renderMap();fit();}
    else ensureVisible();
  }).observe($('map-viewport'));
  // Expose read-only QA state without making the viewer a execution API for the inspected project.
  const viewState=()=>({scenario:player.selected(),step:player.current().id,index:player.session().index,choices:{...player.session().choices},preview:player.session().preview,playing:!!timer,expanded:[...expanded],camera:{...camera},tab,inspected,scope:activeScope,visibleScenarios:catalogScenarios().map(s=>s.id),routingDiagnostics:routeDiagnostics.map(d=>({...d}))});
  window.IADViewer={
    getState:viewState,
    setScope,
    getLayout:()=>JSON.parse(JSON.stringify({boxes:[...boxes.values()],dimensions})),
    getPorts:()=>JSON.parse(JSON.stringify([...apiPorts.values()])),
    selectScenario(id) {
      player.select(id);pause();inspected=null;tab='step';if(scoped && !catalogScenarios().some(s=>s.id===id))activeScope=player.scenario().scope ?? null;
      for(const endpoint of [player.current().from,player.current().to]) {
        let parent=nodes.get(endpoint)?.parent;
        while(parent){expanded.add(parent);parent=nodes.get(parent)?.parent;}
      }
      if($('modal').open)$('modal').close();
      render();fit();return viewState();
    },
    navigateTo(request) {
      if(!request || typeof request!=='object' || Array.isArray(request))throw new IADCore.IadError('INVALID_ARGUMENT','Navigation requires a request object');
      if(request.inspect!=null && !nodes.has(request.inspect))throw new IADCore.IadError('NOT_FOUND',`Unknown node: ${request.inspect}`);
      player.navigateTo(request);
      if(scoped && !catalogScenarios().some(s=>s.id===player.selected()))activeScope=player.scenario().scope ?? null;
      if($('modal').open)$('modal').close();
      pause();inspected=null;tab='step';
      for(const endpoint of [player.current().from,player.current().to]) {
        let parent=nodes.get(endpoint)?.parent;
        while(parent){expanded.add(parent);parent=nodes.get(parent)?.parent;}
      }
      showDetails();render();fit();
      if(request.inspect!=null){inspect(request.inspect);ensureVisible(request.inspect);}
      return viewState();
    },
    openSource(id) {
      if(!evidence.has(id))throw new IADCore.IadError('NOT_FOUND',`Unknown evidence: ${id}`);
      openSource(id);
    }
  };
  if(activeScope!==null) {
    revealAncestors(activeScope);
    if(children(activeScope).length)expanded.add(activeScope);
  }
  for(const endpoint of [player.current().from,player.current().to])revealAncestors(endpoint);
  render();requestAnimationFrame(()=>fit());
})();
