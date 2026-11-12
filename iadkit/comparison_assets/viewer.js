(function () {
  'use strict';
  const payload=JSON.parse(document.getElementById('iad-comparison-data').textContent);
  const {config,models,documents}=payload,sides=['before','after'];
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={before:'До',after:'После'};
  const snapshots=Object.fromEntries(sides.map(side=>[side,IADCore.createApi(models[side]).buildSnapshot()]));
  const diff=IADCore.createApi(models.after).compareSnapshots(snapshots.before,snapshots.after);
  const scenarios=new Map();
  for(const side of sides)for(const scenario of models[side].scenarios)if(!scenarios.has(scenario.id))scenarios.set(scenario.id,scenario);
  const state={side:'after',scenario:models.after.view?.initialScenario || models.after.scenarios[0].id,selectedChange:null,ready:{before:false,after:false}};
  let syncing=false;
  const revision=side=>models[side].manifest.revision;
  const frame=side=>$('frame-'+side);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const evidence=Object.fromEntries(sides.map(side=>[side,new Map(models[side].evidence.map(item=>[item.id,item]))]));
  const scenarioFor=(side,id=state.scenario)=>models[side].scenarios.find(item=>item.id===id);
  const compared=()=>diff.scenarios.find(item=>item.id===state.scenario);
  const error=reason=>{const element=$('comparison-error');element.textContent=reason?.message || String(reason);element.hidden=false;};
  const clearError=()=>{$('comparison-error').hidden=true;};
  const sourceButtons=(side,ids)=>(ids || []).map(id=>{const item=evidence[side].get(id);return `<button class="source-button" data-source-side="${side}" data-source-id="${esc(id)}">${esc(item.path)}:${item.line}<br>${esc(item.symbol)}</button>`;}).join('');
  const question=change=>`Помоги разобраться с вопросом по сравнению IAD «${config.title}»:\nДо: ${revision('before')}.\nПосле: ${revision('after')}.\nИзменение «${change.title}», сценарий «${scenarios.get(change.scenarioId).title}».\nВопрос: `;
  function renderChanges(){
    $('change-count').textContent=`${config.changes.length} изменений`;
    $('change-cards').innerHTML=config.changes.map((change,index)=>`<article class="change-card ${state.selectedChange===change.id?'selected':''}" data-change-card="${esc(change.id)}"><button class="change-title" data-change="${esc(change.id)}"><span>${String(index+1).padStart(2,'0')}</span>${esc(change.title)} ↘</button><p class="change-summary">${esc(change.summary)}</p><details><summary>Подробности, последствия и код</summary><div class="change-details">${change.details?`<p>${esc(change.details)}</p>`:''}<p><strong>Последствие.</strong> ${esc(change.consequence)}</p><div class="source-groups">${sides.map(side=>`<div class="source-group"><strong>${labels[side]} · ${revision(side).slice(0,7)}</strong>${sourceButtons(side,change[side+'Sources'])}${change[side+'Nodes']?.length?`<button class="focus-button" data-focus-change="${esc(change.id)}" data-focus-side="${side}">Участник на карте →</button>`:''}</div>`).join('')}</div><section class="question-box"><div class="question-head"><strong>Задать вопрос об изменении</strong><button data-copy-change="${esc(change.id)}">Скопировать</button></div><textarea readonly spellcheck="false" rows="5" aria-label="Шаблон вопроса об изменении">${esc(question(change))}</textarea><p class="copy-status" role="status" aria-live="polite"></p></section></div></details></article>`).join('');
  }
  function renderStatus(){
    const comparison=compared(),first=comparison?.firstDivergence;
    const statuses={same:'Маршруты совпадают',changed:'Есть изменение',added:'Сценарий добавлен',removed:'Сценарий удалён'};
    const versionSummary=side=>{
      const step=first[side]?.step;
      if(!step)return `<div class="diff-version"><strong>${labels[side]}: шаг отсутствует</strong></div>`;
      const nodeLabel=id=>models[side].nodes.find(item=>item.id===id)?.label || id;
      const participants=step.from===step.to?nodeLabel(step.to)+' · локальная операция':nodeLabel(step.from)+' → '+nodeLabel(step.to);
      const output=(typeof step.output==='string'?step.output:JSON.stringify(step.output ?? '')).replace(/\s+/g,' ').trim();
      const shortOutput=output.length>120?output.slice(0,119)+'…':output;
      return `<div class="diff-version"><strong>${labels[side]}: ${esc(step.title)}</strong><span class="diff-participants" title="${esc(participants)}">${esc(participants)}</span>${output?`<span class="diff-output" title="${esc(output)}">Результат: ${esc(shortOutput)}</span>`:''}</div>`;
    };
    $('scenario-status').innerHTML=`<span class="status-badge">${esc(statuses[comparison?.status] || 'Сравнение')}</span>${first?`Первое расхождение в поясняющем маршруте:<div class="diff-pair">${sides.map(versionSummary).join('')}</div>`:'Сравнение охватывает только описанные участки архитектуры.'}`;
    $('first-divergence').disabled=!first || !state.ready.before || !state.ready.after;
  }
  function renderSide(){
    for(const side of sides){frame(side).hidden=state.side!==side;$('tab-'+side).setAttribute('aria-selected',String(state.side===side));}
    const missing=!scenarioFor(state.side);
    $('missing-scenario').hidden=!missing;
    $('missing-scenario').textContent=`Сценарий «${scenarios.get(state.scenario)?.title || state.scenario}» отсутствует в версии «${labels[state.side]}». Выберите другую версию или сценарий.`;
    frame(state.side).hidden=missing;
    $('map-caption').innerHTML=`${labels[state.side]} · ${esc(models[state.side].manifest.target.name || models[state.side].manifest.target.id)}<code>${esc(revision(state.side))}</code>`;
    $('scenario-select').value=state.scenario;
    renderStatus();
  }
  const readiness=Object.fromEntries(sides.map(side=>[side,new Promise((resolve,reject)=>{
    const started=Date.now();
    const check=()=>{
      try{if(frame(side).contentWindow?.IADViewer?.navigateTo && frame(side).contentWindow?.IADViewer?.selectScenario){
        state.ready[side]=true;
        frame(side).contentWindow.addEventListener('iad-view-change',event=>{
          const id=event.detail?.scenario;
          if(!syncing && state.side===side && id!==state.scenario && scenarios.has(id)){
            clearError();selectScenario(id).catch(error);
          }
        });
        renderStatus();resolve();return;
      }}catch{}
      if(Date.now()-started>20000){reject(Error(`Карта версии «${labels[side]}» не инициализировалась.`));return;}
      setTimeout(check,40);
    };
    frame(side).srcdoc=documents[side];check();
  })]));
  async function selectSide(side){
    if(!sides.includes(side))throw Error('Unknown comparison side');
    state.side=side;renderSide();await readiness[side];return getState();
  }
  async function selectScenario(id){
    if(!scenarios.has(id))throw Error('Unknown comparison scenario');
    await Promise.all(Object.values(readiness));
    state.scenario=id;
    // Set parent state first: the iframe's synchronous render event must not
    // recursively turn one selection into another navigation request.
    syncing=true;
    try{for(const side of sides)if(scenarioFor(side,id))frame(side).contentWindow.IADViewer.selectScenario(id);}
    finally{syncing=false;}
    if(state.selectedChange && config.changes.find(item=>item.id===state.selectedChange)?.scenarioId!==id){
      state.selectedChange=null;
      for(const card of document.querySelectorAll('[data-change-card]'))card.classList.remove('selected');
    }
    if(!scenarioFor(state.side,id))state.side=scenarioFor('after',id)?'after':'before';
    renderSide();return getState();
  }
  async function jumpToDivergence(){
    await Promise.all(Object.values(readiness));
    const first=compared()?.firstDivergence;if(!first)return getState();
    for(const side of sides){const entry=first[side];if(entry)frame(side).contentWindow.IADViewer.navigateTo({scenario:state.scenario,stepId:entry.step.id,choices:entry.choices || {}});}
    $('map-region').scrollIntoView({block:'start',behavior:'auto'});return getState();
  }
  async function selectChange(id,focusSide=null){
    const change=config.changes.find(item=>item.id===id);if(!change)throw Error('Unknown change');
    await selectScenario(change.scenarioId);state.selectedChange=id;
    for(const card of document.querySelectorAll('[data-change-card]'))card.classList.toggle('selected',card.dataset.changeCard===id);
    await jumpToDivergence();
    if(focusSide){
      await selectSide(focusSide);const node=change[focusSide+'Nodes']?.[0],first=compared()?.firstDivergence?.[focusSide];
      frame(focusSide).contentWindow.IADViewer.navigateTo({scenario:state.scenario,stepId:first?.step.id,choices:first?.choices || {},inspect:node || null});
    }
    return getState();
  }
  async function openSource(side,id){
    if(!evidence[side]?.has(id))throw Error('Unknown comparison source');
    if(!scenarioFor(side))await selectScenario(models[side].scenarios[0].id);
    await selectSide(side);frame(side).contentWindow.IADViewer.openSource(id);
    $('map-region').scrollIntoView({block:'start',behavior:'auto'});return getState();
  }
  function getState(){return clone({...state,comparisonStatus:compared()?.status,firstDivergence:compared()?.firstDivergence || null});}
  async function copyChange(button){
    const section=button.closest('.question-box'),field=section.querySelector('textarea'),status=section.querySelector('.copy-status');let copied=false;
    try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(field.value);copied=true;}}catch{}
    if(!copied){field.focus();field.select();try{copied=document.execCommand('copy');}catch{}}
    status.textContent=copied?'Скопировано. Допишите свой вопрос.':'Текст выделен. Нажмите ⌘C или Ctrl+C и допишите вопрос.';
  }
  $('comparison-title').textContent=config.title;$('comparison-summary').textContent=config.summary;
  $('revisions').innerHTML=sides.map(side=>`<div class="revision ${side}"><strong>${labels[side]}</strong><code>${esc(revision(side))}</code><small>${esc(models[side].manifest.primaryRepository)}</small></div>`).join('');
  $('scenario-select').innerHTML=[...scenarios.values()].map(item=>`<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');
  $('limitations').innerHTML=(config.limitations || []).map(item=>`<p>• ${esc(item)}</p>`).join('');
  renderChanges();renderSide();
  const run=action=>{clearError();Promise.resolve().then(action).catch(error);};
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-side],[data-change],[data-source-side],[data-focus-change],[data-copy-change]');if(!target)return;
    if(target.dataset.side)run(()=>selectSide(target.dataset.side));
    else if(target.dataset.change)run(()=>selectChange(target.dataset.change));
    else if(target.dataset.sourceSide)run(()=>openSource(target.dataset.sourceSide,target.dataset.sourceId));
    else if(target.dataset.focusChange)run(()=>selectChange(target.dataset.focusChange,target.dataset.focusSide));
    else if(target.dataset.copyChange)run(()=>copyChange(target));
  });
  $('scenario-select').onchange=event=>run(()=>selectScenario(event.target.value));
  $('first-divergence').onclick=()=>run(jumpToDivergence);
  window.IADComparison={getState,getDiff:()=>clone(diff),selectSide,selectScenario,selectChange,jumpToDivergence,openSource};
  Promise.all(Object.values(readiness)).then(()=>selectScenario(state.scenario)).catch(error);
})();
