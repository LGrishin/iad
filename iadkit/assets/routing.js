/* Orthogonal SVG routes, chosen together so separate interactions stay separate. */
(function (root) {
  'use strict';
  const EPS = .01, PAD = 12, STUB = 20, LANE = 18;
  const same = (a,b) => Math.abs(a.x-b.x)<EPS && Math.abs(a.y-b.y)<EPS;
  const distance = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
  const inside = (p,r) => p.x>r.x+EPS && p.x<r.x+r.w-EPS && p.y>r.y+EPS && p.y<r.y+r.h-EPS;
  const overlaps = (a,b,gap=0) => a.x<b.x+b.w+gap && a.x+a.w>b.x-gap && a.y<b.y+b.h+gap && a.y+a.h>b.y-gap;
  const within = (point,bounds) => !bounds || point.x>=bounds.x-EPS&&point.x<=bounds.x+bounds.w+EPS&&point.y>=bounds.y-EPS&&point.y<=bounds.y+bounds.h+EPS;
  const contained = (rect,bounds) => !bounds || within(rect,bounds)&&within({x:rect.x+rect.w,y:rect.y+rect.h},bounds);
  function crosses(a,b,r) {
    if(Math.abs(a.y-b.y)<EPS)return a.y>r.y+EPS&&a.y<r.y+r.h-EPS&&Math.max(a.x,b.x)>r.x+EPS&&Math.min(a.x,b.x)<r.x+r.w-EPS;
    if(Math.abs(a.x-b.x)<EPS)return a.x>r.x+EPS&&a.x<r.x+r.w-EPS&&Math.max(a.y,b.y)>r.y+EPS&&Math.min(a.y,b.y)<r.y+r.h-EPS;
    return true;
  }
  const clear = (a,b,obstacles) => obstacles.every(r=>!crosses(a,b,r));
  const segments = points => points.slice(1).map((b,i)=>({a:points[i],b,h:Math.abs(points[i].y-b.y)<EPS}));
  function simplify(points) {
    const out=[];
    for(const p of points){
      if(out.length&&same(out.at(-1),p))continue;
      while(out.length>1){
        const a=out.at(-2),b=out.at(-1);
        if(!((Math.abs(a.x-b.x)<EPS&&Math.abs(b.x-p.x)<EPS&&(b.y-a.y)*(p.y-b.y)>=0)||(Math.abs(a.y-b.y)<EPS&&Math.abs(b.y-p.y)<EPS&&(b.x-a.x)*(p.x-b.x)>=0)))break;
        out.pop();
      }
      out.push(p);
    }
    return out;
  }
  const svg = points => points.map((p,i)=>`${i?'L':'M'}${Math.round(p.x*100)/100},${Math.round(p.y*100)/100}`).join(' ');
  function pathPenalty(points,used) {
    let penalty=0;
    for(const s of segments(points))for(const t of used){
      if(s.h===t.h){
        const gap=s.h?Math.abs(s.a.y-t.a.y):Math.abs(s.a.x-t.a.x);
        if(gap>=12)continue;
        const length=s.h?Math.min(Math.max(s.a.x,s.b.x),Math.max(t.a.x,t.b.x))-Math.max(Math.min(s.a.x,s.b.x),Math.min(t.a.x,t.b.x)):Math.min(Math.max(s.a.y,s.b.y),Math.max(t.a.y,t.b.y))-Math.max(Math.min(s.a.y,s.b.y),Math.min(t.a.y,t.b.y));
        if(length>EPS)penalty+=gap<EPS?400+length*24:(12-gap)*length*.6;
      }else{
        const h=s.h?s:t,v=s.h?t:s;
        if(v.a.x>Math.min(h.a.x,h.b.x)+EPS&&v.a.x<Math.max(h.a.x,h.b.x)-EPS&&h.a.y>Math.min(v.a.y,v.b.y)+EPS&&h.a.y<Math.max(v.a.y,v.b.y)-EPS)penalty+=75;
      }
    }
    return penalty;
  }
  function ports(rect,other,usedPorts,padded,bounds=null) {
    const center={x:rect.x+rect.w/2,y:rect.y+rect.h/2},dest={x:other.x+other.w/2,y:other.y+other.h/2};
    const dx=dest.x-center.x,dy=dest.y-center.y;
    const preferred=Math.abs(dx)>Math.abs(dy)?(dx>=0?'right':'left'):(dy>=0?'bottom':'top');
    const result=[];
    for(const side of ['right','left','bottom','top']){
      const vertical=side==='right'||side==='left',size=vertical?rect.h:rect.w;
      const min=Math.min(15,size/3),max=size-min;
      const raw=[];
      for(let at=min;at<=max+EPS;at+=16)raw.push(at);
      raw.push(size/2,max);
      const distinct=[...new Set(raw.map(x=>Math.round(x*100)/100))];
      const candidates=distinct.map(at=>{
        const x=vertical?(side==='right'?rect.x+rect.w:rect.x):rect.x+at;
        const y=vertical?rect.y+at:(side==='bottom'?rect.y+rect.h:rect.y);
        const nx=side==='right'?1:side==='left'?-1:0,ny=side==='bottom'?1:side==='top'?-1:0;
        const border={x,y},point={x:x+nx*3,y:y+ny*3},gate={x:x+nx*STUB,y:y+ny*STUB};
        const nearest=usedPorts.filter(p=>p.node===rect.id&&p.side===side).reduce((m,p)=>Math.min(m,distance(p.border,border)),Infinity);
        const score=(side===preferred?0:side===(preferred==='left'?'right':preferred==='right'?'left':preferred==='top'?'bottom':'top')?70:25)+Math.abs(at-size/2)*.13+(nearest<11?2500:0);
        return {node:rect.id,side,border,point,gate,score};
      }).filter(p=>within(p.gate,bounds)&&!padded.some(r=>inside(p.gate,r))&&clear(p.point,p.gate,padded.filter(r=>r.id!==rect.id)));
      candidates.sort((a,b)=>a.score-b.score);
      result.push(...candidates.slice(0,2));
    }
    return result;
  }
  function labelOnPath(points,text,obstacles,occupied,allowLeader=false,usedSegments=[],bounds=null) {
    if(!text)return null;
    // Narrow captions let a vertical connection remain beside its neighbours.
    // Keeping every caption on one line forced compact diagrams into detours.
    const labelLines=[],words=String(text).split(/\s+/).flatMap(word=>word.match(/.{1,18}/g)||[]);
    for(const word of words){
      if(labelLines.length&&labelLines.at(-1).length+word.length+1<=18)labelLines[labelLines.length-1]+=' '+word;
      else labelLines.push(word);
    }
    const w=Math.max(50,...labelLines.map(line=>line.length*6.4+16)),h=22+(labelLines.length-1)*14;
    const ss=segments(points).sort((a,b)=>(distance(b.a,b.b)+(b.h?80:0))-(distance(a.a,a.b)+(a.h?80:0)));
    const fits=rect=>contained(rect,bounds)&&!obstacles.some(r=>overlaps(rect,r,7))&&!occupied.some(r=>overlaps(rect,r,8))&&![...segments(points),...usedSegments].some(s=>crosses(s.a,s.b,rect));
    for(const s of ss){
      if(!s.h||distance(s.a,s.b)<w+8)continue;
      const lo=Math.min(s.a.x,s.b.x)+w/2+4,hi=Math.max(s.a.x,s.b.x)-w/2-4;
      const mid=(s.a.x+s.b.x)/2;
      for(const x of [mid,lo,hi])for(const offset of [13-h,19]){
        const labelX=x,labelY=s.a.y+offset,rect={x:x-w/2,y:labelY-15,w,h};
        if(fits(rect))return {labelX,labelY,labelLines,labelAnchor:{x,y:s.a.y},labelRect:rect,labelLeader:null,labelMode:'segment'};
      }
    }
    if(!allowLeader)return null;
    // A short or vertical segment gets a visible, local leader. Labels never float elsewhere on the map.
    for(const s of ss){
      const anchor={x:(s.a.x+s.b.x)/2,y:(s.a.y+s.b.y)/2};
      // A parent/child return may need a caption below the child while its
      // route follows a side corridor. Include nearby obstacle edges instead
      // of only a few fixed offsets; the leader remains local to this path.
      const offsets=[15-h/2,30,-30,50,-50,74,-74,...[...obstacles,...occupied].flatMap(r=>[r.y-h+7-anchor.y,r.y+r.h+23-anchor.y]).filter(offset=>Math.abs(offset)<=230)];
      const middle=bounds?bounds.x+bounds.w/2:(Math.min(...obstacles.map(r=>r.x))+Math.max(...obstacles.map(r=>r.x+r.w)))/2;
      const outward=anchor.x<middle?-1:1;
      const shifts=[0,outward*(w/2+14),-outward*(w/2+14),...(bounds?[bounds.x+w/2-anchor.x,bounds.x+bounds.w-w/2-anchor.x]:[])];
      for(const offset of [...new Set(offsets)])for(const dx of [...new Set(shifts)]){
        if(Math.abs(offset)+Math.abs(dx)>360)continue;
        const x=anchor.x+dx,y=anchor.y+offset,rect={x:x-w/2,y:y-15,w,h};
        if(!fits(rect))continue;
        const end={x:Math.max(rect.x,Math.min(rect.x+rect.w,anchor.x)),y:Math.max(rect.y,Math.min(rect.y+rect.h,anchor.y))};
        const leader=[anchor,{x:anchor.x,y:end.y},end];
        if(!leader.every(point=>within(point,bounds))||!segments(leader).every(t=>clear(t.a,t.b,obstacles)))continue;
        return {labelX:x,labelY:y,labelLines,labelAnchor:anchor,labelRect:rect,labelLeader:svg(simplify(leader)),labelMode:'leader'};
      }
    }
    return null;
  }
  class Heap {
    constructor(){this.items=[];}
    push(item){const a=this.items;a.push(item);let i=a.length-1;while(i){const p=(i-1)>>1;if(a[p].cost<=item.cost)break;a[i]=a[p];i=p;}a[i]=item;}
    pop(){const a=this.items,out=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let j=i*2+1;if(j+1<a.length&&a[j+1].cost<a[j].cost)j++;if(a[j].cost>=last.cost)break;a[i]=a[j];i=j;}a[i]=last;}return out;}
  }
  function detour(padded,sourcePorts,targetPorts,used,xLanes,yLanes,bounds=null){
    const xs=[...new Set([...xLanes,...sourcePorts.map(p=>p.gate.x),...targetPorts.map(p=>p.gate.x)])].sort((a,b)=>a-b);
    const ys=[...new Set([...yLanes,...sourcePorts.map(p=>p.gate.y),...targetPorts.map(p=>p.gate.y)])].sort((a,b)=>a-b);
    const width=xs.length,index=p=>ys.indexOf(p.y)*width+xs.indexOf(p.x),coord=id=>({x:xs[id%width],y:ys[Math.floor(id/width)]});
    const goals=new Map(targetPorts.map(p=>[index(p.gate),p]));
    const q=new Heap(),dist=new Map(),parents=new Map(),origins=new Map();
    for(const port of sourcePorts){const state=index(port.gate)*3;dist.set(state,port.score);origins.set(state,port);q.push({state,cost:port.score});}
    while(q.items.length){
      const {state,cost}=q.pop();if(dist.get(state)!==cost)continue;
      const id=Math.floor(state/3),dir=state%3,p=coord(id);
      if(goals.has(id)){
        const points=[];let at=state;while(at!==undefined){points.push(coord(Math.floor(at/3)));at=parents.get(at);}points.reverse();
        const start=origins.get(state),end=goals.get(id);return {points:simplify([start.point,...points,end.point]),start,end};
      }
      const ix=id%width,iy=Math.floor(id/width);
      for(const [nx,ny,nd]of[[ix-1,iy,1],[ix+1,iy,1],[ix,iy-1,2],[ix,iy+1,2]]){
        if(nx<0||nx>=width||ny<0||ny>=ys.length)continue;
        const next=ny*width+nx,point=coord(next);if(!within(point,bounds)||!clear(p,point,padded))continue;
        const ns=next*3+nd,value=cost+distance(p,point)+(dir&&dir!==nd?26:0)+pathPenalty([p,point],used);
        if(value>=(dist.get(ns)??Infinity))continue;dist.set(ns,value);parents.set(ns,state);origins.set(ns,origins.get(state));q.push({state:ns,cost:value});
      }
    }
    return null;
  }
  function routeAll(boxes,edges){
    const valid=boxes.filter(b=>[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>0&&b.h>0),rawById=new Map(valid.map(b=>[b.id,b]));
    const hierarchical=valid.some(b=>Object.prototype.hasOwnProperty.call(b,'parent'));
    function ancestors(id){
      const out=[],seen=new Set();let box=rawById.get(id);
      while(box&&!seen.has(box.id)){out.push(box.id);seen.add(box.id);box=rawById.get(box.parent);}
      return out;
    }
    const ancestry=new Map(valid.map(b=>[b.id,ancestors(b.id)]));
    const descends=(id,ancestor)=>(ancestry.get(id)||[]).includes(ancestor);
    const header=box=>({...box,h:box.group?Math.min(box.h,box.headerHeight??54):box.h});
    const tracks=[24,24+LANE,24+LANE*2,24+LANE*3];
    const used=[],usedPorts=[],labels=[],out=new Array(edges.length);
    // Reserve the clearest route for the current step, followed by its scenario, then background dependencies.
    const order=edges.map((edge,index)=>({edge,index})).sort((a,b)=>Number(!!b.edge.current)-Number(!!a.edge.current)||Number(b.edge.activeRoute!==false)-Number(a.edge.activeRoute!==false)||a.index-b.index);
    for(const {edge,index}of order){
      const sourceRaw=rawById.get(edge.from),targetRaw=rawById.get(edge.to);
      // Semantic ports on an expanded container's external API belong to its
      // complete perimeter. Its own child-facing ports use the header divider.
      const source=edge.sourceApiPort&&!edge.sourceApiPort.internal?sourceRaw:sourceRaw&&header(sourceRaw);
      const target=edge.targetApiPort&&!edge.targetApiPort.internal?targetRaw:targetRaw&&header(targetRaw);
      const unavailable=message=>({id:edge.id,unavailable:true,error:{code:'route-unavailable',message},path:'',points:[],labelX:null,labelY:null,labelAnchor:null,labelRect:null,labelLeader:null,labelMode:'unavailable',sourcePort:null,targetPort:null,sourceApiPortId:edge.sourceApiPort?.id||null,targetApiPortId:edge.targetApiPort?.id||null});
      if(!source||!target){out[index]=unavailable(`Unknown routing endpoint: ${!source?edge.from:edge.to}`);continue;}
      const sourceAncestors=ancestry.get(edge.from)||[],targetAncestors=ancestry.get(edge.to)||[];
      const domain=hierarchical?sourceAncestors.map(id=>rawById.get(id)).find(box=>box?.group&&box.contentBounds&&targetAncestors.includes(box.id)):null;
      const bounds=domain?.contentBounds||null;
      // An edge can pass through its own enclosing containers. Other expanded
      // diagrams are solid obstacles; they are not empty global routing space.
      const externalEndpoints=new Set([...(sourceRaw?.group&&edge.sourceApiPort&&!edge.sourceApiPort.internal?[edge.from]:[]),...(targetRaw?.group&&edge.targetApiPort&&!edge.targetApiPort.internal?[edge.to]:[])]);
      const blocked=hierarchical?valid.filter(box=>box.group&&(externalEndpoints.has(box.id)||!sourceAncestors.includes(box.id)&&!targetAncestors.includes(box.id))):[];
      const obstacles=valid.filter(box=>(!domain||descends(box.id,domain.id))&&!blocked.some(group=>group.id!==box.id&&descends(box.id,group.id))).map(box=>blocked.some(group=>group.id===box.id)?{...box}:header(box));
      const padded=obstacles.map(r=>({id:r.id,x:r.x-PAD,y:r.y-PAD,w:r.w+PAD*2,h:r.h+PAD*2}));
      const captionBounds=bounds?{left:bounds.x,right:bounds.x+bounds.w,top:bounds.y,bottom:bounds.y+bounds.h}:{
        left:Math.min(...obstacles.map(r=>r.x))-36,right:Math.max(...obstacles.map(r=>r.x+r.w))+36,
        top:Math.min(...obstacles.map(r=>r.y))-90,bottom:Math.max(...obstacles.map(r=>r.y+r.h))+90};
      const xLanes=[...new Set([...obstacles.flatMap(r=>tracks.flatMap(d=>[r.x-d,r.x+r.w+d])),...(bounds?[bounds.x,bounds.x+bounds.w]:[])])].filter(x=>!bounds||x>=bounds.x-EPS&&x<=bounds.x+bounds.w+EPS);
      const yLanes=[...new Set([...obstacles.flatMap(r=>tracks.flatMap(d=>[r.y-d,r.y+r.h+d])),...(bounds?[bounds.y,bounds.y+bounds.h]:[])])].filter(y=>!bounds||y>=bounds.y-EPS&&y<=bounds.y+bounds.h+EPS);
      const text=edge.activeRoute===false?'':(edge.displayLabel??edge.label??'');
      const fixedPort=port=>({...port,node:port.node,score:0});
      const sp=edge.sourceApiPort?[fixedPort(edge.sourceApiPort)]:ports(source,target,usedPorts,padded,bounds),tp=edge.targetApiPort?[fixedPort(edge.targetApiPort)]:ports(target,source,usedPorts,padded,bounds);
      let best=null,bestCost=Infinity;
      function consider(start,end,core){
        if(!core.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&within(p,bounds)))return;
        core=simplify(core);
        for(const s of segments(core))if(!clear(s.a,s.b,padded))return;
        const points=simplify([start.point,...core,end.point]);
        if(points.length<2)return;
        for(const s of segments(points))if(!clear(s.a,s.b,obstacles))return;
        const length=segments(points).reduce((sum,s)=>sum+distance(s.a,s.b),0);
        let cost=length+Math.max(0,points.length-2)*26+start.score+end.score+pathPenalty(points,used);
        cost+=segments(points).reduce((sum,s)=>sum+labels.filter(rect=>crosses(s.a,s.b,rect)).length*900,0);
        if(cost>=bestCost)return;
        // A nearby interaction may not have a horizontal segment as wide as its
        // caption. Keep the interaction local and attach a short visible leader
        // instead of making a distant detour solely to fit the caption.
        const label=labelOnPath(points,text,obstacles,labels,false,used,bounds)
          || labelOnPath(points,text,obstacles,labels,true,used,bounds);
        if(label?.labelMode==='leader')cost+=32;
        if(label){const r=label.labelRect;cost+=3*(Math.max(0,captionBounds.left-r.x)+Math.max(0,r.x+r.w-captionBounds.right)+Math.max(0,captionBounds.top-r.y)+Math.max(0,r.y+r.h-captionBounds.bottom));}
        if(text&&!label)cost+=1000000;
        if(cost<bestCost){bestCost=cost;best={points,start,end,label};}
      }
      if(edge.from===edge.to){
        for(const start of sp)for(const end of tp){
          if(start.side!==end.side||same(start.point,end.point))continue;
          const a=start.gate,b=end.gate;
          const outward=start.side==='left'?-1:1;
          if(start.side==='left'||start.side==='right')for(const d of [36,60,96]){const x=a.x+outward*d;consider(start,end,[a,{x,y:a.y},{x,y:b.y},b]);}
          else for(const d of [36,60,96]){const y=a.y+(start.side==='top'?-d:d);consider(start,end,[a,{x:a.x,y},{x:b.x,y},b]);}
        }
      }else for(const start of sp)for(const end of tp){
        const a=start.gate,b=end.gate;
        if(Math.abs(a.x-b.x)<EPS||Math.abs(a.y-b.y)<EPS)consider(start,end,[a,b]);
        consider(start,end,[a,{x:a.x,y:b.y},b]);consider(start,end,[a,{x:b.x,y:a.y},b]);
        for(const x of xLanes)consider(start,end,[a,{x,y:a.y},{x,y:b.y},b]);
        for(const y of yLanes)consider(start,end,[a,{x:a.x,y},{x:b.x,y},b]);
      }
      if(!best&&sp.length&&tp.length)best=detour(padded,sp,tp,used,xLanes,yLanes,bounds);
      if(!best){out[index]=unavailable(`No unobstructed route: ${edge.from} → ${edge.to}${domain?' within '+domain.id:''}`);continue;}
      if(!best.label)best.label=labelOnPath(best.points,text,obstacles,labels,true,used,bounds);
      const points=best.points,label=best.label;
      used.push(...segments(points));usedPorts.push(best.start,best.end);if(label)labels.push(label.labelRect);
      out[index]={id:edge.id,domain:domain?.id||null,path:svg(points),points,...(label||{labelX:null,labelY:null,labelAnchor:null,labelRect:null,labelLeader:null,labelMode:text?'unavailable':'hidden'}),sourcePort:best.start.border,targetPort:best.end.border,sourceApiPortId:edge.sourceApiPort?.id||null,targetApiPortId:edge.targetApiPort?.id||null};
    }
    return out;
  }
  function route(boxes,from,to,laneIndex=0){
    return routeAll(boxes,[{id:String(laneIndex),from,to,activeRoute:false}])[0];
  }
  root.IADRouting={route,routeAll};
  if(typeof module!=='undefined')module.exports=root.IADRouting;
})(globalThis);
