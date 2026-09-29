import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const EARTH_KM=6378.137;
const COLORS={usa245:"#eaaa00",kosmos2542:"#555555",kosmos2543:"#a9a9a9"};
const LABELS={usa245:"USA 245",kosmos2542:"Cosmos 2542",kosmos2543:"Cosmos 2543"};
const SCENARIO_IDS=[1,2,4];
const DEFAULT_TRAIL_MINUTES={1:240,2:90,4:240};
const RELATIVE_SCALE_KM=1000;
const state={scenes:[]};

const svgElement=(name,attrs={},text="")=>{
  const node=document.createElementNS("http://www.w3.org/2000/svg",name);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);
  if(text)node.textContent=text;
  return node;
};
const relative=ric=>new THREE.Vector3(ric[1]/RELATIVE_SCALE_KM,ric[2]/RELATIVE_SCALE_KM,ric[0]/RELATIVE_SCALE_KM);
const gmst=date=>{const jd=date.getTime()/86400000+2440587.5,t=(jd-2451545)/36525;return THREE.MathUtils.degToRad((280.46061837+360.98564736629*(jd-2451545)+.000387933*t*t-t*t*t/38710000)%360);};
const formatNumber=value=>Math.round(value).toLocaleString("en-US");
const niceStep=(range,target=4)=>{
  const rough=range/target,power=10**Math.floor(Math.log10(rough)),fraction=rough/power;
  return (fraction<=1?1:fraction<=2?2:fraction<=5?5:10)*power;
};
const dateParts=value=>{
  const date=new Date(value);
  return {
    time:new Intl.DateTimeFormat("en-US",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"UTC"}).format(date),
    date:new Intl.DateTimeFormat("en-US",{day:"2-digit",month:"short",year:"numeric",timeZone:"UTC"}).format(date),
  };
};

function drawChart(svg,scenario){
  const W=760,H=390,p={l:132,r:176,t:28,b:88};
  svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
  svg.setAttribute("style","font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif");
  const fiveMinutes=5*60*1000,windowDuration=180*60*1000;
  const originalEnd=new Date(scenario.samples[scenario.animationEnd].t).getTime();
  const displayEnd=Math.floor(originalEnd/fiveMinutes)*fiveMinutes,displayStart=displayEnd-windowDuration;
  const samples=scenario.samples.filter(sample=>{const time=new Date(sample.t).getTime();return time>=displayStart&&time<=displayEnd;});
  const times=samples.map(sample=>new Date(sample.t).getTime());
  const series={
    kosmos2542:samples.map(sample=>sample.range.kosmos2542),
    kosmos2543:samples.map(sample=>sample.range.kosmos2543),
  };
  const all=[...series.kosmos2542,...series.kosmos2543],rawMin=Math.min(...all),rawMax=Math.max(...all),span=rawMax-rawMin;
  const step=niceStep(span*1.12),provisionalMin=rawMin>2000?rawMin-span*.06:0;
  const yMin=rawMin>2000?Math.floor(provisionalMin/step)*step:0,yMax=Math.ceil((rawMax+span*.06)/step)*step;
  const x=value=>p.l+(value-displayStart)/(displayEnd-displayStart)*(W-p.l-p.r);
  const y=value=>p.t+(1-(value-yMin)/(yMax-yMin))*(H-p.t-p.b);

  const grid=svgElement("g");svg.append(grid);
  for(let value=yMin;value<=yMax+step*.01;value+=step){
    const py=y(value);
    grid.append(svgElement("line",{x1:p.l,y1:py,x2:W-p.r,y2:py,stroke:"#dedede","stroke-width":1}));
    grid.append(svgElement("text",{x:p.l-14,y:py+8,"text-anchor":"end",fill:"#555","font-size":26},formatNumber(value)));
  }
  const tickInterval=60*60*1000;
  for(let time=displayStart;time<=displayEnd;time+=tickInterval){
    const px=x(time),parts=dateParts(time);
    grid.append(svgElement("line",{x1:px,y1:p.t,x2:px,y2:H-p.b,stroke:"#e3e3e3","stroke-width":1}));
    const tick=svgElement("text",{x:px,y:H-p.b+30,"text-anchor":"middle",fill:"#555","font-size":26});
    tick.append(svgElement("tspan",{x:px,dy:0},parts.time));
    grid.append(tick);
  }
  const middleDate=dateParts((displayStart+displayEnd)/2).date;
  grid.append(svgElement("text",{x:(p.l+W-p.r)/2,y:H-p.b+68,"text-anchor":"middle",fill:"#666","font-size":26},`${middleDate} · UTC`));
  grid.append(svgElement("line",{x1:p.l,y1:p.t,x2:p.l,y2:H-p.b,stroke:"#777","stroke-width":1}));
  grid.append(svgElement("line",{x1:p.l,y1:H-p.b,x2:W-p.r,y2:H-p.b,stroke:"#777","stroke-width":1}));
  const axisLabel=svgElement("text",{x:30,y:(p.t+H-p.b)/2,fill:"#333","font-size":26,"text-anchor":"middle",transform:`rotate(-90 30 ${(p.t+H-p.b)/2})`},"Separation from USA 245 (km)");
  svg.append(axisLabel);

  for(const key of ["kosmos2542","kosmos2543"]){
    const path=series[key].map((value,index)=>`${index?"L":"M"}${x(times[index]).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
    svg.append(svgElement("path",{d:path,fill:"none",stroke:COLORS[key],"stroke-width":2.4,"stroke-dasharray":key==="kosmos2543"?"8 5":"none"}));
    const minimum=Math.min(...series[key]),minimumIndex=series[key].indexOf(minimum),mx=x(times[minimumIndex]),my=y(minimum);
    svg.append(svgElement("circle",{cx:mx,cy:my,r:5.2,fill:COLORS[key],stroke:"#111","stroke-width":1.8}));
  }

  // Direct labels retain line color and use collision-aware vertical positions.
  const labelX=W-p.r+14;
  const endpoints=["kosmos2542","kosmos2543"].map(key=>{const actualY=y(series[key].at(-1));return {key,actualY,labelY:actualY};}).sort((a,b)=>a.actualY-b.actualY);
  if(endpoints[1].actualY-endpoints[0].actualY<42){endpoints[0].labelY-=21;endpoints[1].labelY+=21;}
  for(const item of endpoints){
    svg.append(svgElement("text",{x:labelX,y:item.labelY+8,fill:COLORS[item.key],"font-size":26,"font-weight":700},LABELS[item.key]));
  }
}

function spriteTexture(fill){
  const canvas=document.createElement("canvas");canvas.width=canvas.height=128;
  const context=canvas.getContext("2d");context.beginPath();context.arc(64,64,37,0,Math.PI*2);context.fillStyle=fill;context.fill();context.lineWidth=12;context.strokeStyle="#111";context.stroke();
  return new THREE.CanvasTexture(canvas);
}

function buildGraticule(){
  const group=new THREE.Group();
  const material=new THREE.LineBasicMaterial({color:0xb5b5b5,transparent:true,opacity:.48,depthWrite:false});
  for(const latitude of [-60,-30,0,30,60]){
    const p=THREE.MathUtils.degToRad(latitude),points=[];
    for(let longitude=0;longitude<=360;longitude+=3){
      const t=THREE.MathUtils.degToRad(longitude),r=1.001;
      points.push(new THREE.Vector3(r*Math.cos(p)*Math.cos(t),r*Math.sin(p),-r*Math.cos(p)*Math.sin(t)));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material));
  }
  for(let longitude=0;longitude<360;longitude+=30){
    const t=THREE.MathUtils.degToRad(longitude),points=[];
    for(let latitude=-90;latitude<=90;latitude+=3){
      const p=THREE.MathUtils.degToRad(latitude),r=1.001;
      points.push(new THREE.Vector3(r*Math.cos(p)*Math.cos(t),r*Math.sin(p),-r*Math.cos(p)*Math.sin(t)));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material));
  }
  return group;
}

function createOrbitScene(panel,scenario,graticuleTemplate){
  const viewport=panel.querySelector(".orbitViewport"),renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xffffff,1);viewport.append(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.001,160),controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=.08;controls.enablePan=false;controls.minDistance=.08;controls.maxDistance=60;
  scene.add(new THREE.HemisphereLight(0xffffff,0xeeeeee,2.4));
  const earth=new THREE.Mesh(new THREE.SphereGeometry(1,128,128),new THREE.MeshBasicMaterial({color:0xf7f7f7}));earth.scale.setScalar(EARTH_KM/RELATIVE_SCALE_KM);scene.add(earth);
  earth.add(graticuleTemplate.clone(true));
  const sprites={},trails={};
  for(const key of Object.keys(COLORS)){
    const markerScale=scenario.id===2?.021:.045;
    const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:spriteTexture(COLORS[key]),depthTest:true,sizeAttenuation:false}));sprite.scale.set(markerScale,markerScale,1);sprite.renderOrder=8;scene.add(sprite);sprites[key]=sprite;
    if(key==="usa245")continue;
    const color=key==="usa245"?0x9a7000:key==="kosmos2542"?0x555555:0xa9a9a9;
    trails[key]={past:[],future:[]};
    for(const direction of ["past","future"]){
      for(let segment=0;segment<24;segment++){
        const proximity=direction==="past"?(segment+1)/24:(24-segment)/24;
        const opacity=.035+.72*proximity**1.7;
        const trail=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color,transparent:true,opacity,depthWrite:false}));
        scene.add(trail);trails[key][direction].push(trail);
      }
    }
  }
  const sample=scenario.samples[scenario.referenceIndex];
  sprites.usa245.position.set(0,0,0);
  for(const key of ["kosmos2542","kosmos2543"])sprites[key].position.copy(relative(sample.ric[key]));
  const chiefRadius=Math.sqrt(sample.r.usa245.reduce((sum,value)=>sum+value*value,0))/RELATIVE_SCALE_KM;
  earth.position.set(0,0,-chiefRadius);earth.rotation.y=-gmst(new Date(sample.t));

  const defaultCamera=()=>{
    const direction=new THREE.Vector3(1,.62,1.08).normalize();
    const russianPositions=[relative(sample.ric.kosmos2542),relative(sample.ric.kosmos2543)];
    const target=new THREE.Vector3();let distance;
    if(scenario.id===2){
      // The far case intentionally frames USA 245, both Russian spacecraft,
      // and the displaced Earth in one much larger relative-coordinate scene.
      const points=[new THREE.Vector3(),...russianPositions,earth.position.clone()];
      const extent=Math.max(...points.map(point=>point.length()));
      distance=Math.max(12,extent/Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*1.18);
    }else{
      // Close cases follow the original relativeFraming logic: center between
      // USA 245 and the nearby formation and allow the Earth to extend outside.
      const halfWindow=DEFAULT_TRAIL_MINUTES[scenario.id],start=Math.max(0,scenario.referenceIndex-halfWindow),end=Math.min(scenario.samples.length-1,scenario.referenceIndex+halfWindow);
      const separation=Math.max(...scenario.samples.slice(start,end+1).flatMap(item=>[relative(item.ric.kosmos2542).length(),relative(item.ric.kosmos2543).length()]));
      distance=Math.max(.55,separation*2.25);
    }
    camera.position.copy(target).add(direction.multiplyScalar(distance));controls.target.copy(target);camera.lookAt(target);controls.update();
  };
  // halfWindowMinutes is explicitly per side: ±120 shows 120 minutes before
  // and 120 minutes after the fixed selected epoch.
  const updateTrails=halfWindowMinutes=>{
    const count=Math.round(halfWindowMinutes*60/60);
    const windows={
      past:[Math.max(0,scenario.referenceIndex-count),scenario.referenceIndex],
      future:[scenario.referenceIndex,Math.min(scenario.samples.length-1,scenario.referenceIndex+count)],
    };
    for(const key of ["kosmos2542","kosmos2543"]){
      for(const direction of ["past","future"]){
        const [start,end]=windows[direction],available=end-start,pieces=Math.min(24,available);
        for(let segment=0;segment<24;segment++){
          const line=trails[key][direction][segment];
          if(segment>=pieces){line.visible=false;continue;}
          const a=start+Math.floor(segment*available/pieces),b=start+Math.floor((segment+1)*available/pieces);
          const points=scenario.samples.slice(a,b+1).map(item=>relative(item.ric[key]));
          line.visible=points.length>1;line.geometry.dispose();line.geometry=new THREE.BufferGeometry().setFromPoints(points);
        }
      }
      // The dot marks the final (outgoing) endpoint, not the selected/closest
      // epoch at the center of the displayed relative-motion window.
      sprites[key].position.copy(relative(scenario.samples[windows.future[1]].ric[key]));
    }
  };
  const resize=()=>{
    const width=viewport.clientWidth,height=viewport.clientHeight;if(!width||!height)return;
    renderer.setSize(width,height,false);camera.aspect=width/height;
    camera.setViewOffset(width*2,height,Math.round(width*2/3),0,width,height);camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);resize();defaultCamera();updateTrails(DEFAULT_TRAIL_MINUTES[scenario.id]);
  panel.querySelector(".zoomIn").onclick=()=>camera.position.lerp(controls.target,.2);
  panel.querySelector(".zoomOut").onclick=()=>camera.position.sub(controls.target).multiplyScalar(1.25).add(controls.target);
  panel.querySelector(".resetCamera").onclick=defaultCamera;
  const slider=panel.querySelector(".trailSlider"),value=panel.querySelector(".trailValue");slider.value=DEFAULT_TRAIL_MINUTES[scenario.id];
  slider.oninput=()=>{value.textContent=`±${slider.value} min`;updateTrails(Number(slider.value));};value.textContent=`±${slider.value} min`;
  const markerSlider=panel.querySelector(".markerSlider"),markerValue=panel.querySelector(".markerValue");
  markerSlider.value=scenario.id===2?21:45;
  markerSlider.oninput=()=>{const scale=Number(markerSlider.value)/1000;for(const sprite of Object.values(sprites))sprite.scale.set(scale,scale,1);markerValue.textContent=markerSlider.value;};
  markerValue.textContent=markerSlider.value;
  const record={renderer,scene,camera,controls,viewport,sprites,resize};state.scenes.push(record);
}

function svgImage(svg){
  return new Promise((resolve,reject)=>{
    const source=new XMLSerializer().serializeToString(svg),url=URL.createObjectURL(new Blob([source],{type:"image/svg+xml"})),image=new Image();
    image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Unable to rasterize chart"));};image.src=url;
  });
}

async function exportPng(){
  const button=document.querySelector("#exportPng");button.disabled=true;button.textContent="Exporting…";
  try{
    const width=2100,height=2550,margin=60,rowGap=24,columnGap=28,rowHeight=(height-2*margin-2*rowGap)/3;
    const chartWidth=1110,orbitWidth=width-2*margin-columnGap-chartWidth;
    const output=document.createElement("canvas");output.width=width;output.height=height;
    const context=output.getContext("2d");context.fillStyle="#fff";context.fillRect(0,0,width,height);
    const rows=[...document.querySelectorAll(".caseRow")];
    for(let index=0;index<rows.length;index++){
      const top=margin+index*(rowHeight+rowGap),chartImage=await svgImage(rows[index].querySelector("svg"));
      const chartHeight=chartWidth*390/760,chartTop=top+(rowHeight-chartHeight)/2;
      context.drawImage(chartImage,margin,chartTop,chartWidth,chartHeight);

      const record=state.scenes[index],oldWidth=record.viewport.clientWidth,oldHeight=record.viewport.clientHeight;
      record.renderer.setSize(orbitWidth,rowHeight,false);record.camera.aspect=orbitWidth/rowHeight;
      record.camera.setViewOffset(orbitWidth*2,rowHeight,Math.round(orbitWidth*2/3),0,orbitWidth,rowHeight);record.camera.updateProjectionMatrix();
      record.controls.update();record.renderer.render(record.scene,record.camera);
      const orbitLeft=margin+chartWidth+columnGap;context.drawImage(record.renderer.domElement,orbitLeft,top,orbitWidth,rowHeight);
      record.renderer.setSize(oldWidth,oldHeight,false);record.camera.aspect=oldWidth/oldHeight;
      record.camera.setViewOffset(oldWidth*2,oldHeight,Math.round(oldWidth*2/3),0,oldWidth,oldHeight);record.camera.updateProjectionMatrix();record.renderer.render(record.scene,record.camera);
    }
    const blob=await new Promise(resolve=>output.toBlob(resolve,"image/png"));
    const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="usa245-relative-motion-7x8.5in.png";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }finally{button.disabled=false;button.textContent="Export PNG";}
}

function rowMarkup(){
  const row=document.createElement("section");row.className="caseRow";
  row.innerHTML=`<div class="chartPanel"><svg role="img" aria-label="Separation distance over time"></svg></div><div class="orbitPanel"><div class="orbitViewport"></div><div class="orbitControls"><button class="zoomIn" title="Zoom in">+</button><button class="zoomOut" title="Zoom out">−</button><button class="resetCamera" title="Reset camera">⌂</button><label class="trailControl">Trail <input class="trailSlider" type="range" min="30" max="240" step="15"><span class="trailValue"></span></label><label class="trailControl">Dots <input class="markerSlider" type="range" min="12" max="70" step="1"><span class="markerValue"></span></label></div></div>`;
  return row;
}

async function main(){
  const data=await fetch("data/eci_storyline.json?v=3").then(response=>response.json());
  const graticuleTemplate=buildGraticule(),root=document.querySelector("#caseStudy");
  for(const id of SCENARIO_IDS){
    const scenario=data.scenarios.find(item=>item.id===id),row=rowMarkup();root.append(row);
    drawChart(row.querySelector("svg"),scenario);createOrbitScene(row.querySelector(".orbitPanel"),scenario,graticuleTemplate);
  }
  document.querySelector("#exportPng").addEventListener("click",exportPng);
  const animate=()=>{requestAnimationFrame(animate);for(const item of state.scenes){item.controls.update();item.renderer.render(item.scene,item.camera);}};animate();
}

main().catch(error=>{document.querySelector("#caseStudy").textContent=`Unable to load visualization: ${error.message}`;console.error(error);});
