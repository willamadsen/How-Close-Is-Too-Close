import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as topojson from "topojson-client";

const EARTH_KM = 6378.137, RELATIVE_SCALE_KM = 1000;
const colors = { usa245: "#eaaa00", kosmos2542: "#a9a9a9", kosmos2543: "#d0d0d0" };
const keys = Object.keys(colors), $ = id => document.getElementById(id);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, .0001, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.domElement.className="sceneCanvas";
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.minDistance = .006;
controls.maxDistance = 80;
controls.addEventListener("start",()=>{cameraTween=null;});
scene.add(new THREE.HemisphereLight(0xffffff, 0xeeeeee, 2.4));

const earthGroup = new THREE.Group();
earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1, 160, 160), new THREE.MeshBasicMaterial({ color: 0xf7f7f7 })));
const borderGroup = new THREE.Group();
earthGroup.add(borderGroup);
scene.add(earthGroup);
const relativeEarthGroup = new THREE.Group();
relativeEarthGroup.scale.setScalar(EARTH_KM / RELATIVE_SCALE_KM);
relativeEarthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1,160,160),new THREE.MeshBasicMaterial({color:0xf7f7f7})));
const relativeBorderGroup = new THREE.Group();
relativeEarthGroup.add(relativeBorderGroup);
relativeEarthGroup.visible = false;
scene.add(relativeEarthGroup);
const relativeAxes = new THREE.Group();
scene.add(relativeAxes);
relativeAxes.visible = false;

function latLon(lat, lon, radius = 1.001) {
  const p = THREE.MathUtils.degToRad(lat), t = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(radius * Math.cos(p) * Math.cos(t), radius * Math.sin(p), -radius * Math.cos(p) * Math.sin(t));
}
async function loadBorders() {
  try {
    const response = await fetch("vendor/countries-110m.json");
    const topology = await response.json();
    for (const feature of topojson.feature(topology, topology.objects.countries).features) {
      const geometry = feature.geometry;
      const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.type === "MultiPolygon" ? geometry.coordinates.flat() : [];
      for (const ring of rings) {
        if (ring.length < 3) continue;
        const curve = new THREE.CatmullRomCurve3(ring.map(([lon, lat]) => latLon(lat, lon)), true);
        const boundary = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, ring.length * 2), .00105, 5, true), new THREE.MeshBasicMaterial({ color:0xa8a8a8, transparent:true, opacity:.62, depthWrite:false }));
        borderGroup.add(boundary);
        relativeBorderGroup.add(boundary.clone());
      }
    }
  } catch (error) { console.warn("Political boundaries unavailable", error); }
}
loadBorders();

function addRelativeAxes() {
  const material = new THREE.LineBasicMaterial({ color:0x999999, transparent:true, opacity:.45 });
  [[new THREE.Vector3(-14,0,0),new THREE.Vector3(14,0,0)], [new THREE.Vector3(0,-5,0),new THREE.Vector3(0,5,0)], [new THREE.Vector3(0,0,-14),new THREE.Vector3(0,0,14)]].forEach(points => relativeAxes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material)));
  const axisLabel=(text,position)=>{const canvas=document.createElement("canvas");canvas.width=512;canvas.height=96;const ctx=canvas.getContext("2d");ctx.font="600 34px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";ctx.fillStyle="#666";ctx.textAlign="center";ctx.fillText(text,256,57);const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas),depthTest:false}));sprite.position.copy(position);sprite.scale.set(3.8,.7,1);sprite.renderOrder=20;relativeAxes.add(sprite);};
  axisLabel("I  ·  along-track",new THREE.Vector3(13.2,.45,0));
  axisLabel("C  ·  cross-track",new THREE.Vector3(0,4.7,0));
  axisLabel("R  ·  radial",new THREE.Vector3(0,.45,12.5));
}
addRelativeAxes();

function spriteTexture(fill) {
  const canvas=document.createElement("canvas"); canvas.width=canvas.height=128;
  const ctx=canvas.getContext("2d"); ctx.beginPath(); ctx.arc(64,64,37,0,Math.PI*2); ctx.fillStyle=fill; ctx.fill(); ctx.lineWidth=12; ctx.strokeStyle="#000"; ctx.stroke();
  return new THREE.CanvasTexture(canvas);
}
const sprites={}, tracks={};
for (const key of keys) {
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:spriteTexture(colors[key]),depthTest:true})); sprite.scale.set(.055,.055,1); sprite.renderOrder=8; scene.add(sprite); sprites[key]=sprite;
  const color=key==="usa245"?0x555555:key==="kosmos2542"?0x999999:0xbdbdbd;
  const track=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color,transparent:true,opacity:key==="kosmos2543" ? .9 : .62})); scene.add(track); tracks[key]=track;
}
const TRAIL_MINUTES=240,TRAIL_SEGMENTS=24,trailLines={};
for(const key of ["kosmos2542","kosmos2543"]){
  trailLines[key]=[];
  const color=key==="kosmos2542"?0x777777:0x999999;
  for(let i=0;i<TRAIL_SEGMENTS;i++){const opacity=.04+.72*((i+1)/TRAIL_SEGMENTS)**1.7;const line=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color,transparent:true,opacity,depthWrite:false}));line.visible=false;scene.add(line);trailLines[key].push(line);}
}
const eci = r => new THREE.Vector3(r[0]/EARTH_KM,r[2]/EARTH_KM,-r[1]/EARTH_KM);
const relative = r => new THREE.Vector3(r[1]/RELATIVE_SCALE_KM,r[2]/RELATIVE_SCALE_KM,r[0]/RELATIVE_SCALE_KM);
const formatTime = iso => new Intl.DateTimeFormat("en-US",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:"UTC"}).format(new Date(iso))+" UTC";
const formatDate = iso => new Intl.DateTimeFormat("en-US",{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(iso));
function gmst(date){const jd=date.getTime()/86400000+2440587.5,t=(jd-2451545)/36525;return THREE.MathUtils.degToRad((280.46061837+360.98564736629*(jd-2451545)+.000387933*t*t-t*t*t/38710000)%360);}

let data, samplePosition=0, encounterNumber=0, playing=false, lastFrame=performance.now(), view="eci", windowStart=0, windowEnd=0;
let cameraTween=null;
const scenario=()=>data.scenarios[encounterNumber], samples=()=>scenario().samples;

function provenanceRow(key){const p=data.provenance[scenario().provenance[key]],o=data.objects[key],link=p.url?`<a href="${p.url}" target="_blank" rel="noopener">${p.source}</a>`:p.source;return `<div class="sourceRecord"><div class="recordHead"><span class="sourceDot ${key}"></span><span>${o.name}</span></div><div class="recordMeta">${formatTime(p.epoch)} · ${link}</div></div>`;}

function rebuildTracks(){
  const step=data.metadata.stepSeconds;
  for(const key of keys){
    let points=[];
    if(view==="relative"){
      tracks[key].visible=false;
      points=[new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,0)];
    }else{
      tracks[key].visible=true;
      points=samples().slice(windowStart,windowEnd+1).map(s=>eci(s.r[key]));
    }
    tracks[key].geometry.dispose(); tracks[key].geometry=new THREE.BufferGeometry().setFromPoints(points);
  }
}

function updateTrails(){
  const active=view==="relative",current=Math.floor(samplePosition),historySamples=Math.round(TRAIL_MINUTES*60/data.metadata.stepSeconds),start=Math.max(0,current-historySamples),count=Math.max(0,current-start);
  for(const key of ["kosmos2542","kosmos2543"]){
    const lines=trailLines[key],pieces=Math.min(TRAIL_SEGMENTS,count),offset=TRAIL_SEGMENTS-pieces;
    for(let segment=0;segment<TRAIL_SEGMENTS;segment++){
      const line=lines[segment],part=segment-offset,a=start+Math.floor(part*count/Math.max(1,pieces)),b=start+Math.floor((part+1)*count/Math.max(1,pieces));
      if(!active||part<0||b-a<1){line.visible=false;continue;}
      line.visible=true;line.geometry.dispose();line.geometry=new THREE.BufferGeometry().setFromPoints(samples().slice(a,b+1).map(sample=>relative(sample.ric[key])));
    }
  }
}

function interpolated(key){
  const a=Math.floor(samplePosition),b=Math.min(a+1,samples().length-1),f=samplePosition-a;
  if(view==="relative"){if(key==="usa245")return new THREE.Vector3();return relative(samples()[a].ric[key]).lerp(relative(samples()[b].ric[key]),f);}
  return eci(samples()[a].r[key]).lerp(eci(samples()[b].r[key]),f);
}
function updateScene(rebuild=false){
  const i=Math.floor(samplePosition),sample=samples()[i];
  const positions={};
  for(const key of keys){positions[key]=interpolated(key);sprites[key].position.copy(positions[key]);}
  const relevantKey=scenario().relevantObject,relevantRange=sample.range[relevantKey];
  $("rangeBlock").classList.toggle("isDistant",relevantRange>200);
  $("rangeStat").textContent=`${Math.round(relevantRange/5)*5} km`;
  $("rangeLabel").textContent=data.objects[relevantKey].name;
  $("timeDisplay").textContent=formatTime(sample.t).replace(" UTC","");
  $("timelineSlider").value=samplePosition;
  const earthRotation=-gmst(new Date(sample.t));
  if(view==="eci")earthGroup.rotation.y=earthRotation;
  else {const chiefRadius=Math.sqrt(sample.r.usa245.reduce((sum,value)=>sum+value*value,0))/RELATIVE_SCALE_KM;relativeEarthGroup.position.set(0,0,-chiefRadius);relativeEarthGroup.rotation.y=earthRotation;}
  updateTrails();
  drawSeparationChart();
  if(rebuild)rebuildTracks();
}

function selectEncounter(number){
  encounterNumber=(number+data.scenarios.length)%data.scenarios.length;
  windowStart=scenario().animationStart; windowEnd=scenario().animationEnd; samplePosition=windowStart;
  $("timelineSlider").min=windowStart; $("timelineSlider").max=windowEnd;
  $("encounterCount").textContent=`Story moment ${encounterNumber+1} of ${data.scenarios.length} · ${formatDate(scenario().referenceTime)}`;
  $("encounterTitle").textContent=scenario().title;
  $("provenance").innerHTML=keys.map(provenanceRow).join("");
  applyStoryboardCamera();
}

function drawSeparationChart(){
  const canvas=$("separationChart"),ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height,p={l:59,r:79,t:9,b:31},stepSeconds=data.metadata.stepSeconds,current=Math.floor(samplePosition),past=Math.round(60*60/stepSeconds),future=Math.round(30*60/stepSeconds),left=current-past,right=current+future,visibleStart=Math.max(0,left),visibleEnd=Math.min(samples().length-1,right);
  const values=[];for(let i=visibleStart;i<=visibleEnd;i++)for(const key of ["kosmos2542","kosmos2543"])values.push(samples()[i].range[key]);
  const rawMax=Math.max(1,...values),magnitude=10**Math.floor(Math.log10(rawMax/4)),step=Math.ceil(rawMax/4/magnitude)*magnitude,yMax=step*4;
  const x=i=>p.l+(i-left)/(right-left)*(w-p.l-p.r),y=value=>p.t+(1-Math.min(value,yMax)/yMax)*(h-p.t-p.b);
  ctx.clearRect(0,0,w,h);ctx.font="9px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";ctx.lineWidth=1;
  for(let tick=0;tick<=4;tick++){const value=tick*step,py=y(value);ctx.strokeStyle="#e8e8e8";ctx.beginPath();ctx.moveTo(p.l,py);ctx.lineTo(w-p.r,py);ctx.stroke();ctx.fillStyle="#888";ctx.textAlign="right";ctx.fillText(value.toLocaleString(),p.l-8,py+3);}
  ctx.save();ctx.translate(11,p.t+(h-p.t-p.b)/2);ctx.rotate(-Math.PI/2);ctx.textAlign="center";ctx.fillStyle="#777";ctx.fillText("Separation (km)",0,0);ctx.restore();
  const currentMs=new Date(samples()[current].t).getTime(),leftMs=currentMs+(left-current)*stepSeconds*1000,rightMs=currentMs+(right-current)*stepSeconds*1000,tickInterval=30*60*1000,xTime=ms=>p.l+(ms-leftMs)/(rightMs-leftMs)*(w-p.l-p.r),tickFormat=new Intl.DateTimeFormat("en-US",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"UTC"});
  let tickMs=Math.floor(rightMs/tickInterval)*tickInterval;ctx.fillStyle="#777";ctx.textAlign="center";ctx.textBaseline="top";
  while(tickMs>=leftMs){const px=xTime(tickMs);if(px>=p.l&&px<=w-p.r){ctx.strokeStyle="#d8d8d8";ctx.beginPath();ctx.moveTo(px,h-p.b);ctx.lineTo(px,h-p.b+3);ctx.stroke();ctx.fillText(tickFormat.format(new Date(tickMs)),px,h-p.b+6);}tickMs-=tickInterval;}
  const labelPositions=[];
  for(const key of ["kosmos2542","kosmos2543"]){ctx.beginPath();ctx.strokeStyle=colors[key];ctx.lineWidth=1.8;let begun=false;for(let i=visibleStart;i<=current;i++){const px=x(i),py=y(samples()[i].range[key]);if(!begun){ctx.moveTo(px,py);begun=true;}else ctx.lineTo(px,py);}ctx.stroke();labelPositions.push({key,py:y(samples()[current].range[key])});}
  if(Math.abs(labelPositions[0].py-labelPositions[1].py)<10){labelPositions[0].py-=6;labelPositions[1].py+=6;}
  for(const item of labelPositions){const label=item.key==="kosmos2542"?"Kosmos 2542":"Kosmos 2543",labelX=w-p.r+8;ctx.font="600 9px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";const labelWidth=ctx.measureText(label).width;ctx.fillStyle="rgba(255,255,255,.88)";ctx.fillRect(labelX-2,item.py-7,labelWidth+4,13);ctx.fillStyle=item.key==="kosmos2542"?"#666":"#999";ctx.textAlign="left";ctx.fillText(label,labelX,item.py+3);}
}

function setView(next,resetCamera=true){
  if(resetCamera)cameraTween=null;
  view=next; earthGroup.visible=view==="eci"; relativeEarthGroup.visible=view==="relative"; relativeAxes.visible=view==="relative";
  camera.fov=view==="eci"?15.5:35;camera.updateProjectionMatrix();
  $("orbitView").classList.toggle("activeViewSwitch",view==="eci"); $("relativeView").classList.toggle("activeViewSwitch",view==="relative");
  if(resetCamera){const framing=view==="eci"?fullEarthFraming():relativeFraming();controls.target.copy(framing.target);camera.position.copy(framing.position);}
  sprites.usa245.scale.set(view==="relative" ? .028 : .055,view==="relative" ? .028 : .055,1);
  for(const key of keys){sprites[key].material.depthTest=true;sprites[key].material.opacity=1;sprites[key].material.needsUpdate=true;}
  for(const key of ["kosmos2542","kosmos2543"])sprites[key].scale.set(view==="relative" ? .028 : .055,view==="relative" ? .028 : .055,1);
  updateScene(true);
}

const storyboardCameras=[
  {view:"eci",scale:1},
  {view:"eci",scale:1},
  {view:"eci",scale:1},
  {view:"eci",scale:1}
];
function referenceSample(){return samples()[scenario().referenceIndex];}
function fullEarthFraming(scale=1){const i=scenario().referenceIndex,before=samples()[Math.max(0,i-1)],after=samples()[Math.min(samples().length-1,i+1)],normals=[];for(const key of keys){const r=eci(referenceSample().r[key]),velocity=eci(after.r[key]).sub(eci(before.r[key])),normal=r.clone().cross(velocity).normalize();if(normals.length&&normal.dot(normals[0])<0)normal.negate();normals.push(normal);}const average=normals.reduce((sum,normal)=>sum.add(normal),new THREE.Vector3()).normalize();if(average.z<0)average.negate();return {position:average.multiplyScalar(10.2*scale),target:new THREE.Vector3(0,0,0)};}
function relativeFraming(scale=1){const key=scenario().relevantObject,relativePosition=relative(referenceSample().ric[key]),target=relativePosition.clone().multiplyScalar(.5),separation=Math.max(.001,relativePosition.length()),distance=Math.max(.48,separation*2.1)*scale,direction=new THREE.Vector3(1,.62,1.08).normalize(),position=target.clone().add(direction.multiplyScalar(distance));return {position,target};}
function applyStoryboardCamera(){const config=storyboardCameras[Math.min(encounterNumber,storyboardCameras.length-1)],framing=config.view==="eci"?fullEarthFraming(config.scale):relativeFraming(config.scale);setView(config.view,false);cameraTween={start:performance.now(),duration:900,fromPosition:camera.position.clone(),toPosition:framing.position,fromTarget:controls.target.clone(),toTarget:framing.target};}

$("prevEncounter").addEventListener("click",()=>selectEncounter(encounterNumber-1));
$("nextEncounter").addEventListener("click",()=>selectEncounter(encounterNumber+1));
$("playBtn").addEventListener("click",()=>{playing=!playing;$("playBtn").innerHTML=playing?"Ⅱ":'<span class="playIcon">▶</span>';});
$("timelineSlider").addEventListener("input",e=>{samplePosition=Number(e.target.value);updateScene(false);});
$("orbitView").addEventListener("click",()=>setView("eci")); $("relativeView").addEventListener("click",()=>setView("relative"));
$("zoomInBtn").addEventListener("click",()=>{cameraTween=null;camera.position.lerp(controls.target,.2);}); $("zoomOutBtn").addEventListener("click",()=>{cameraTween=null;camera.position.sub(controls.target).multiplyScalar(1.25).add(controls.target);}); $("resetBtn").addEventListener("click",()=>setView(view));
function updateRendererLayout(){
  const panel=$("ui"),desktop=innerWidth>760;
  const left=desktop?Math.ceil(panel.getBoundingClientRect().right+18):0;
  const width=Math.max(1,innerWidth-left);
  renderer.domElement.style.left=`${left}px`;
  camera.aspect=width/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(width,innerHeight);
}
addEventListener("resize",updateRendererLayout);
updateRendererLayout();

function animate(now){requestAnimationFrame(animate);if(playing&&data){samplePosition+=Math.min((now-lastFrame)/1000,.1)*6;if(samplePosition>=windowEnd)samplePosition=windowStart;updateScene(false);}if(cameraTween){const raw=Math.min(1,(now-cameraTween.start)/cameraTween.duration),eased=raw<.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;camera.position.lerpVectors(cameraTween.fromPosition,cameraTween.toPosition,eased);controls.target.lerpVectors(cameraTween.fromTarget,cameraTween.toTarget,eased);if(raw>=1)cameraTween=null;}lastFrame=now;controls.update();renderer.render(scene,camera);}
try{data=await fetch("data/eci_storyline.json").then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();});selectEncounter(0);}catch(error){$("encounterTitle").textContent="Data file unavailable";$("provenance").textContent=error.message;}
animate(performance.now());
