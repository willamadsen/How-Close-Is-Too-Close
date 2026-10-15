// WORK IN PROGRESS: this is a working copy that is changing often. Expect unfinished features and breaking changes.
//
// compare.js — shows TWO satellites around Earth, computed directly from their TLEs.
//
// How it works, in one paragraph:
//   Python (Code/build_tle_library.py) collects each satellite's TLE history into
//   data/tles/<NORAD>.json. When you pick two satellites, this file loads their
//   histories. For every moment shown on screen it picks, for each satellite, the
//   TLE whose epoch is CLOSEST in time to that moment, and runs the SGP4 orbit
//   model (via the satellite.js library) to get the satellite's position.
//   Positions are in the TEME frame, which is Earth-centered inertial (ECI).

// ---------------------------------------------------------------------------
// 1. Load the libraries
// ---------------------------------------------------------------------------
// "import" pulls in code someone else wrote. THREE is the 3D graphics library,
// OrbitControls lets you drag to spin the camera, topojson reads the map borders.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as topojson from "topojson-client";

// satellite.js was loaded by a <script> tag in compare.html, which put it on
// "window" (the browser's global object). We give it a short name here.
const sgp4 = window.satellite;

// ---------------------------------------------------------------------------
// 2. Settings that never change ("const" = constant)
// ---------------------------------------------------------------------------
const EARTH_RADIUS_KM = 6378.137;  // In the 3D scene, Earth's radius is 1 unit, so we divide km by this.
const TRAIL_POINTS = 180;          // How many points make up each orbit line.
const CHART_MINUTES = 120;         // The separation chart shows the last two hours.
const AGING_DAYS = 2;              // TLE more than 2 days from now: show in amber.
const STALE_DAYS = 7;              // TLE more than 7 days from now: show in red.
const MINUTE_MS = 60 * 1000, DAY_MS = 24 * 60 * MINUTE_MS;   // Times in JavaScript are in milliseconds.

// Each "slot" (A or B) gets its own colors, no matter which satellite is in it.
const SLOTS = {
  A: { dot: "#eaaa00", line: 0x555555 },   // gold dot, dark gray orbit line
  B: { dot: "#7a7a7a", line: 0x999999 },   // gray dot, light gray orbit line
};

// A tiny helper so we can write $("playBtn") instead of document.getElementById("playBtn").
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// 3. Things that DO change while the page runs ("let" = can be reassigned)
// ---------------------------------------------------------------------------
let catalog = [];            // List of satellites from data/tles/index.json
let satcat = [];             // Full satellite catalog from data/satcat.json, for the lookup box
let lookupFound = null;      // NORAD number (as used in the TLE library) of the satellite the lookup found, if it has TLEs
const library = {};          // Loaded TLE histories, keyed by NORAD number
const pair = { A: null, B: null };   // NORAD numbers of the satellites in slots A and B
let startMs = 0, endMs = 0;  // The chosen time window
let currentMs = 0;           // The moment currently shown
let playing = false;
let lastFrameTime = performance.now();
let cameraTween = null;      // A smooth camera movement in progress, or null if none
let lastIdentityKey = "";    // Used to avoid rebuilding the "Now modeling" panel every frame

// ---------------------------------------------------------------------------
// 4. Loading TLEs and computing positions
// ---------------------------------------------------------------------------
// Download one satellite's TLE history (only the first time it's needed).


async function loadSatellite(norad) {
  if (library[norad]) return library[norad];
  const response = await fetch(`data/tles/${norad}.json`);
  if (!response.ok) throw new Error(`Could not load TLEs for NORAD ${norad} (HTTP ${response.status})`);
  const file = await response.json();
  library[norad] = {
    info: catalog.find(s => s.norad === norad),
    tles: file.tles,
    epochsMs: file.tles.map(t => Date.parse(t.epoch)),  // Epochs as numbers, for fast searching
    satrecs: [],   // SGP4 set-up for each TLE, filled in the first time each TLE is used
  };
  return library[norad];
}

// Find the TLE whose epoch is closest to time ms. The epochs are sorted, so we can
// use a "binary search": check the middle, throw away the half that can't contain
// the answer, repeat. Finds the answer among 5,000 TLEs in about 13 steps.
function nearestTleIndex(lib, ms) {
  const epochs = lib.epochsMs;
  let low = 0, high = epochs.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (epochs[middle] < ms) low = middle + 1;
    else high = middle;
  }
  // "low" is now the first TLE at or after ms. The one just before might be closer.
  if (low > 0 && ms - epochs[low - 1] < epochs[low] - ms) return low - 1;
  return low;
}

// satellite.js turns a TLE into a "satrec" (satellite record) before it can propagate.
// Making one takes a little work, so we keep each one after making it.
function satrecFor(lib, index) {
  if (!lib.satrecs[index]) {
    lib.satrecs[index] = sgp4.twoline2satrec(lib.tles[index].line1, lib.tles[index].line2);
  }
  return lib.satrecs[index];
}

// Position [x, y, z] in km (TEME / ECI) of a satellite at time ms.
// If tleIndex is given, use that TLE; otherwise use the nearest one.
// Returns null if SGP4 fails (for example, a TLE that can't be propagated that far).
function stateAt(norad, ms, tleIndex = null) {
  const lib = library[norad];
  const index = tleIndex ?? nearestTleIndex(lib, ms);
  const result = sgp4.propagate(satrecFor(lib, index), new Date(ms));
  if (!result.position) return null;
  const p = result.position, v = result.velocity;
  return { r: [p.x, p.y, p.z], v: [v.x, v.y, v.z] };
}
const positionAt = (norad, ms, tleIndex = null) => stateAt(norad, ms, tleIndex)?.r ?? null;

// Straight-line distance between two [x, y, z] positions in km (Pythagorean theorem in 3D).
function distanceKm(r1, r2) {
  const dx = r1[0] - r2[0], dy = r1[1] - r2[1], dz = r1[2] - r2[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Distance between A and B at time ms, or null if either position is unavailable.
function separationAt(ms) {
  const a = positionAt(pair.A, ms), b = positionAt(pair.B, ms);
  return a && b ? distanceKm(a, b) : null;
}

// ---------------------------------------------------------------------------
// 5. Set up the 3D scene: camera, renderer, Earth
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

// PerspectiveCamera(field of view in degrees, aspect ratio, near limit, far limit)
const camera = new THREE.PerspectiveCamera(15.5, innerWidth / innerHeight, 0.0001, 1000);
camera.position.set(0, 4, 10);

// The renderer turns the scene into pixels on a <canvas> element on the page.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.domElement.className = "sceneCanvas";
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;      // Makes spinning feel smooth instead of jerky
controls.dampingFactor = 0.08;
controls.minDistance = 0.006;
controls.maxDistance = 80;
controls.addEventListener("start", () => { cameraTween = null; });  // If the user drags, cancel any automatic camera move

scene.add(new THREE.HemisphereLight(0xffffff, 0xeeeeee, 2.4));

// Earth is a sphere of radius 1. The country borders go inside the same group
// so they rotate together with the sphere.
const earthGroup = new THREE.Group();
earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1, 160, 160), new THREE.MeshBasicMaterial({ color: 0xf7f7f7 })));
const borderGroup = new THREE.Group();
earthGroup.add(borderGroup);
scene.add(earthGroup);

// Convert latitude/longitude (degrees) into a 3D point on the sphere.
function latLonToPoint(lat, lon, radius = 1.001) {
  const phi = THREE.MathUtils.degToRad(lat);
  const theta = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(phi) * Math.cos(theta),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(theta)
  );
}

// Draw country borders. "async" means this function can wait for a file to download
// without freezing the page.
async function loadBorders() {
  try {
    const response = await fetch("vendor/countries-110m.json");
    const topology = await response.json();
    for (const feature of topojson.feature(topology, topology.objects.countries).features) {
      const geometry = feature.geometry;
      const rings = geometry.type === "Polygon" ? geometry.coordinates
                  : geometry.type === "MultiPolygon" ? geometry.coordinates.flat()
                  : [];
      for (const ring of rings) {
        if (ring.length < 3) continue;
        const curve = new THREE.CatmullRomCurve3(ring.map(([lon, lat]) => latLonToPoint(lat, lon)), true);
        const tube = new THREE.TubeGeometry(curve, Math.max(24, ring.length * 2), 0.00105, 5, true);
        borderGroup.add(new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: 0xa8a8a8, transparent: true, opacity: 0.62, depthWrite: false })));
      }
    }
  } catch (error) {
    console.warn("Political boundaries unavailable", error);
  }
}
loadBorders();

// Turn an ECI position [x, y, z] in km into a point in the 3D scene.
// three.js treats "y" as up, but in ECI "z" points to the North Pole, so we swap axes.
const eciToScene = r => new THREE.Vector3(r[0] / EARTH_RADIUS_KM, r[2] / EARTH_RADIUS_KM, -r[1] / EARTH_RADIUS_KM);

// ---------------------------------------------------------------------------
// 6. Create the two satellite dots and two orbit lines (one per slot)
// ---------------------------------------------------------------------------
// Draw a filled circle with a black outline onto a small image, to use as a dot.
function dotTexture(fillColor) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.beginPath();
  ctx.arc(64, 64, 37, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = "#000";
  ctx.stroke();
  return new THREE.CanvasTexture(canvas);
}

const dots = {};    // dots.A and dots.B
const trails = {};  // trails.A and trails.B
for (const slot of ["A", "B"]) {
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(SLOTS[slot].dot) }));
  dot.scale.set(0.055, 0.055, 1);
  dot.renderOrder = 8;
  scene.add(dot);
  dots[slot] = dot;

  const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SLOTS[slot].line, transparent: true, opacity: 0.75 }));
  scene.add(trail);
  trails[slot] = trail;
}

// ---------------------------------------------------------------------------
// 7. Formatting helpers
// ---------------------------------------------------------------------------
const formatTime = ms => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(ms)) + " UTC";
const formatDate = ms => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(ms));

// <input type="datetime-local"> uses text like "2020-01-02T10:16". We always treat it as UTC.
const toInputValue = ms => new Date(ms).toISOString().slice(0, 16);
const fromInputValue = text => Date.parse(text + ":00Z");

// "3.2 days after epoch" / "5.0 hours before epoch"
function describeAge(ageMs) {
  const days = Math.abs(ageMs) / DAY_MS;
  const amount = days >= 1 ? `${days.toFixed(1)} days` : `${(days * 24).toFixed(1)} hours`;
  return `${amount} ${ageMs >= 0 ? "after" : "before"} epoch`;
}

// ---------------------------------------------------------------------------
// 8. Updating the picture
// ---------------------------------------------------------------------------
// Called every time the time changes: move the dots, update numbers, chart and panel.
function updateScene() {
  if (!pair.A || !pair.B) return;
  const positions = {};

  for (const slot of ["A", "B"]) {
    const norad = pair[slot];
    const lib = library[norad];
    const tleIndex = nearestTleIndex(lib, currentMs);
    const r = positionAt(norad, currentMs, tleIndex);
    positions[slot] = r;

    dots[slot].visible = r !== null;
    if (r) dots[slot].position.copy(eciToScene(r));

    // The orbit line shows the last full orbit, all from the TLE in use right now
    // (so it doesn't jump when the nearest TLE changes partway along it).
    // satrec.no is the mean motion in radians per minute, so one orbit = 2π / no minutes.
    const periodMs = (2 * Math.PI / satrecFor(lib, tleIndex).no) * MINUTE_MS;
    const points = [];
    for (let i = 0; i <= TRAIL_POINTS; i++) {
      const p = positionAt(norad, currentMs - periodMs * (1 - i / TRAIL_POINTS), tleIndex);
      if (p) points.push(eciToScene(p));
    }
    trails[slot].geometry.dispose();
    trails[slot].geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  const km = positions.A && positions.B ? distanceKm(positions.A, positions.B) : null;
  $("rangeStat").textContent = km === null ? "—" : `${Math.round(km).toLocaleString()} km`;
  $("timeDisplay").textContent = formatTime(currentMs).replace(" UTC", "");
  $("timelineSlider").value = currentMs;

  // Spin Earth to the right angle for this moment (Greenwich sidereal time).
  earthGroup.rotation.y = -sgp4.gstime(new Date(currentMs));

  drawSeparationChart();
  updateIdentity();
}

// Draw the A-to-B distance over the last two hours, one point per minute.
// Each point uses the TLE nearest to ITS time, so a jump in the line means the
// nearest TLE changed there.
function drawSeparationChart() {
  const canvas = $("separationChart"), ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const pad = { left: 59, right: 12, top: 9, bottom: 31 };
  const leftMs = currentMs - CHART_MINUTES * MINUTE_MS;

  // Work out the distance at each minute (skip minutes before the window starts).
  const points = [];
  for (let m = 0; m <= CHART_MINUTES; m++) {
    const ms = leftMs + m * MINUTE_MS;
    if (ms < startMs) continue;
    const km = separationAt(ms);
    if (km !== null) points.push({ ms, km });
  }

  // Pick a "nice" top value for the y-axis (like 100, 200, 4000) with 4 tick marks.
  const rawMax = Math.max(1, ...points.map(p => p.km));
  const magnitude = 10 ** Math.floor(Math.log10(rawMax / 4));
  const step = Math.ceil(rawMax / 4 / magnitude) * magnitude;
  const yMax = step * 4;

  // Convert a time to an x pixel, and a distance to a y pixel.
  const x = ms => pad.left + (ms - leftMs) / (currentMs - leftMs) * (w - pad.left - pad.right);
  const y = km => pad.top + (1 - Math.min(km, yMax) / yMax) * (h - pad.top - pad.bottom);

  ctx.clearRect(0, 0, w, h);
  ctx.font = "9px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.lineWidth = 1;

  // Horizontal grid lines with distance labels
  for (let tick = 0; tick <= 4; tick++) {
    const py = y(tick * step);
    ctx.strokeStyle = "#e8e8e8";
    ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(w - pad.right, py); ctx.stroke();
    ctx.fillStyle = "#888"; ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
    ctx.fillText((tick * step).toLocaleString(), pad.left - 8, py + 3);
  }

  // Rotated y-axis title
  ctx.save();
  ctx.translate(11, pad.top + (h - pad.top - pad.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.fillStyle = "#777";
  ctx.fillText("Separation (km)", 0, 0);
  ctx.restore();

  // Time labels every 30 minutes along the bottom
  const hourMinute = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const tickInterval = 30 * MINUTE_MS;
  ctx.fillStyle = "#777"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let tickMs = Math.floor(currentMs / tickInterval) * tickInterval; tickMs >= leftMs; tickMs -= tickInterval) {
    const px = x(tickMs);
    ctx.strokeStyle = "#d8d8d8";
    ctx.beginPath(); ctx.moveTo(px, h - pad.bottom); ctx.lineTo(px, h - pad.bottom + 3); ctx.stroke();
    ctx.fillText(hourMinute.format(new Date(tickMs)), px, h - pad.bottom + 6);
  }

  // The separation line itself
  ctx.beginPath();
  ctx.strokeStyle = "#555";
  ctx.lineWidth = 1.8;
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p.ms), y(p.km)) : ctx.lineTo(x(p.ms), y(p.km))));
  ctx.stroke();
}

// The "Now modeling" panel: who each satellite is, and which TLE is in use.
// This is also where the code CHECKS that the TLE really belongs to that satellite.
function identityCard(slot) {
  const norad = pair[slot], lib = library[norad], info = lib.info;
  const index = nearestTleIndex(lib, currentMs);
  const tle = lib.tles[index];
  const ageMs = currentMs - lib.epochsMs[index];
  const ageDays = Math.abs(ageMs) / DAY_MS;
  const ageClass = ageDays > STALE_DAYS ? "stale" : ageDays > AGING_DAYS ? "aging" : "";

  // Check: the NORAD number and international designator written inside this TLE
  // should match the catalog entry for the satellite we think we're modeling.
  const checks = [];
  const tleNorad = tle.line1.slice(2, 7).trim().padStart(5, "0");
  if (tleNorad !== norad) checks.push(`The TLE in use is for NORAD ${tleNorad}, not ${norad}.`);
  const shortIntlDes = tle.line1.slice(9, 17).trim();     // e.g. "19079D"
  if (info.intlDes && shortIntlDes && `${info.intlDes.slice(2, 4)}${info.intlDes.slice(5)}` !== shortIntlDes) {
    checks.push(`The TLE in use lists international designator ${shortIntlDes}; the catalog says ${info.intlDes}.`);
  }
  if (ageClass === "stale") checks.push(`The nearest TLE is more than ${STALE_DAYS} days away, so this position is unreliable.`);

  return `<div class="identityCard">
    <div class="recordHead"><span class="sourceDot slot${slot}"></span><span>${info.name}</span></div>
    <div class="identityMeta">NORAD ${norad} · ${info.intlDes ?? "intl. designator unknown"} · ${info.country ?? "country unknown"}</div>
    <div class="identityMeta">TLE ${index + 1} of ${lib.tles.length} · epoch ${formatTime(lib.epochsMs[index])} · ${tle.source}</div>
    <div class="identityMeta">Age: <span class="tleAge ${ageClass}">${describeAge(ageMs)}</span></div>
    ${checks.map(c => `<div class="dataWarning">⚠ ${c}</div>`).join("")}
  </div>`;
}

function updateIdentity() {
  // Only rebuild the panel when something visible in it changed (TLE in use, or the age at 0.1-day steps).
  const key = ["A", "B"].map(s => `${pair[s]}:${nearestTleIndex(library[pair[s]], currentMs)}`).join("|") + Math.round((currentMs / DAY_MS) * 10);
  if (key === lastIdentityKey) return;
  lastIdentityKey = key;
  $("identity").innerHTML = identityCard("A") + identityCard("B");
}

// ---------------------------------------------------------------------------
// 9. Camera
// ---------------------------------------------------------------------------
// Look straight down on the two orbits: average the two orbit-plane directions
// ("normals" = position × velocity) and put the camera along that direction.
function fullEarthFraming() {
  const normals = [];
  for (const slot of ["A", "B"]) {
    const state = stateAt(pair[slot], currentMs);
    if (!state) continue;
    const normal = eciToScene(state.r).cross(eciToScene(state.v)).normalize();
    if (normals.length && normal.dot(normals[0]) < 0) normal.negate();
    normals.push(normal);
  }
  const average = normals.reduce((sum, n) => sum.add(n), new THREE.Vector3()).normalize();
  if (average.lengthSq() === 0) average.set(0, 0.4, 1).normalize();
  if (average.z < 0) average.negate();
  return { position: average.multiplyScalar(10.2), target: new THREE.Vector3(0, 0, 0) };
}

// Glide the camera to the framing over 0.9 seconds instead of jumping.
function moveCameraSmoothly() {
  const framing = fullEarthFraming();
  cameraTween = {
    start: performance.now(), duration: 900,
    fromPosition: camera.position.clone(), toPosition: framing.position,
    fromTarget: controls.target.clone(), toTarget: framing.target,
  };
}

// ---------------------------------------------------------------------------
// 10. Choosing satellites and time windows
// ---------------------------------------------------------------------------
// The time span the date pickers allow, and the default window.
// With the "overlap" checkbox ticked: only dates where we have TLEs for BOTH satellites.
// Unticked (or if the satellites don't overlap at all): from the earliest TLE of either
// satellite to the most recent TLE of either.
function dataLimits() {
  const a = library[pair.A].epochsMs, b = library[pair.B].epochsMs;
  const overlapStart = Math.max(a[0], b[0]), overlapEnd = Math.min(a[a.length - 1], b[b.length - 1]);
  const overlap = overlapStart < overlapEnd;
  if (overlap && $("useOverlap").checked) return { min: overlapStart, max: overlapEnd, overlap, overlapOnly: true };
  return { min: Math.min(a[0], b[0]), max: Math.max(a[a.length - 1], b[b.length - 1]), overlap, overlapOnly: false };
}

// Pick a pair of satellites. Optionally also a time window (test cases provide one);
// otherwise the window is set to the full range of data, as the task asks.
async function setPair(noradA, noradB, requestedStart = null, requestedEnd = null) {
  pair.A = noradA; pair.B = noradB;
  $("satA").value = noradA; $("satB").value = noradB;
  $("rangeNote").textContent = "Loading TLEs…";
  await Promise.all([loadSatellite(noradA), loadSatellite(noradB)]);
  applyLimits(requestedStart, requestedEnd);
  lastIdentityKey = "";
  moveCameraSmoothly();
}

// Set the date pickers' allowed range from the TLE data, then set the window
// (to the requested dates if given, otherwise the whole allowed range).
function applyLimits(requestedStart = null, requestedEnd = null) {
  const limits = dataLimits();
  for (const input of [$("startTime"), $("endTime")]) {
    input.min = toInputValue(limits.min);
    input.max = toInputValue(limits.max);
  }
  if (!limits.overlap) {
    $("rangeNote").textContent = "⚠ These satellites have no overlapping TLE dates; positions far from a TLE epoch are unreliable.";
  } else {
    $("rangeNote").textContent = limits.overlapOnly
      ? `TLEs for both satellites cover ${formatDate(limits.min)} to ${formatDate(limits.max)}.`
      : `TLEs for either satellite cover ${formatDate(limits.min)} to ${formatDate(limits.max)}; outside the overlap, one satellite's position is extrapolated.`;
  }

  const clamp = ms => Math.min(limits.max, Math.max(limits.min, ms));
  setWindow(requestedStart ? clamp(Date.parse(requestedStart)) : limits.min,
            requestedEnd ? clamp(Date.parse(requestedEnd)) : limits.max);
}

// Set the start and end of the time window, and jump to the start.
function setWindow(newStart, newEnd) {
  if (newEnd <= newStart) newEnd = newStart + DAY_MS;   // Never allow an empty window
  startMs = newStart; endMs = newEnd; currentMs = startMs;
  $("startTime").value = toInputValue(startMs);
  $("endTime").value = toInputValue(endMs);
  $("timelineSlider").min = startMs;
  $("timelineSlider").max = endMs;
  updateScene();
}

// Fill both dropdowns with every satellite in the library, e.g. "USA 245 (39232)".
function fillDropdowns() {
  for (const select of [$("satA"), $("satB")]) {
    select.innerHTML = catalog.map(s => `<option value="${s.norad}">${s.name} (${s.norad})</option>`).join("");
  }
}

// One button per test case in data/test_cases.json.
function showTestCases(testCases) {
  $("testCases").innerHTML = testCases.map((c, i) =>
    `<button class="testCase" data-index="${i}" title="${c.note}">${c.label}<small>${c.kind}</small></button>`).join("");
  for (const button of document.querySelectorAll(".testCase")) {
    button.addEventListener("click", () => {
      const c = testCases[Number(button.dataset.index)];
      markActiveTestCase(button);
      setPair(c.satA, c.satB, c.start, c.end);
    });
  }
}
function markActiveTestCase(activeButton) {
  for (const button of document.querySelectorAll(".testCase")) button.classList.toggle("active", button === activeButton);
}

// ---------------------------------------------------------------------------
// Satellite lookup: find catalog entries matching whatever someone typed
// ---------------------------------------------------------------------------
// "19079A" (short form, as written inside a TLE) -> "2019-079A" (the catalog's form)
function shortToLongIntlDes(short) { //turns  a short int. designator into the long form used in the catalog
  let year = Number(short.slice(0, 2));
  year += year < 57 ? 2000 : 1900;     // TLEs started in 1957, so 57-99 are 1900s
  return `${year}-${short.slice(2, 5)}${short.slice(5)}`;
}

// Returns a list of matching satellites (an empty list if nothing matches).
function identify(text) {
  text = text.trim().toUpperCase();
  if (text === "") return [];

  // 1. Only digits -> NORAD number. Number() drops leading zeros ("00123" -> 123),
  //    matching how the catalog stores them.
  if (/^\d+$/.test(text)) {
    const norad = String(Number(text));
    return satcat.filter(s => s.norad === norad);
  }

  // 2. Long international designator, like 2019-079A
  if (/^\d{4}-\d{3}[A-Z]{1,3}$/.test(text)) {
    return satcat.filter(s => s.intlDes === text);
  }

  // 3. Short international designator, like 19079A
  if (/^\d{5}[A-Z]{1,3}$/.test(text)) {
    const longForm = shortToLongIntlDes(text);
    return satcat.filter(s => s.intlDes === longForm);
  }

  // 4. Anything else is a name. CelesTrak spells Russian "Kosmos" satellites "COSMOS".
  const name = text.replace("KOSMOS", "COSMOS");
  const exact = satcat.filter(s => s.name === name);
  if (exact.length > 0) return exact;              // exact name match wins
  return satcat.filter(s => s.name.includes(name)); // otherwise, any name containing it
}


// ---------------------------------------------------------------------------
// 11. Responding to the user
// ---------------------------------------------------------------------------
// When a dropdown changes: if the user picked the same satellite as the other slot,
// swap them so A and B are always different.
$("satA").addEventListener("change", event => {
  const a = event.target.value, b = a === pair.B ? pair.A : pair.B; //norad number now comes from event.target.value
  markActiveTestCase(null);
  setPair(a, b); //writes two selected satellites into sat pair  S
});
$("satB").addEventListener("change", event => {
  const b = event.target.value, a = b === pair.A ? pair.B : pair.A;
  markActiveTestCase(null);
  setPair(a, b);
});

// Ticking/unticking the overlap checkbox resets the window to the new default range.
$("useOverlap").addEventListener("change", () => applyLimits());
$("startTime").addEventListener("change", () => setWindow(fromInputValue($("startTime").value), endMs));
$("endTime").addEventListener("change", () => setWindow(startMs, fromInputValue($("endTime").value)));

// Satellite lookup: run when "Look up" is clicked or Enter is pressed in the box.
function runLookup() {
  $("lookupActions").hidden = true;            // tells the html file to hide the Load buttons until we know there's something to load
  lookupFound = null;                          // forget the previous result
  
  if (satcat.length === 0) {
    $("lookupResult").textContent = "The satellite catalog is still loading. Try again in a moment.";
    return;
  }
  const matches = identify($("lookupInput").value);
  const describe = s => `${s.name}  (NORAD ${s.norad}, ${s.intlDes})`;

  if (matches.length === 0) {
    $("lookupResult").textContent = "No satellite found with that identifier.";
} else if (matches.length === 1) {
    const found = matches[0];
    // Is this satellite in the TLE library (data/tles/index.json)?
    // Compare as numbers: the library pads NORAD numbers to 5 digits ("05398"), the catalog doesn't ("5398")
    const inLibrary = catalog.find(c => Number(c.norad) === Number(found.norad));
    if (inLibrary) {
      $("lookupResult").textContent = `${describe(found)}\nTLE history available: load it as satellite A or B.`;
      lookupFound = inLibrary.norad;           // use the library's spelling, since that's the TLE file's name
      $("lookupActions").hidden = false;       // show the Load buttons
    } else {
      $("lookupResult").textContent = `${describe(found)}\nNo TLE history for this satellite on this site yet.`;
    }

  } else {
    const shown = matches.slice(0, 10);   // show at most 10
    const header = matches.length > 10
      ? `${matches.length} matches (showing the first 10):`
      : `${matches.length} matches:`;
    $("lookupResult").textContent = [header, ...shown.map(describe)].join("\n");
  }
}
$("lookupBtn").addEventListener("click", runLookup);
$("lookupInput").addEventListener("keydown", event => {
  if (event.key === "Enter") runLookup();
});

// "Load as A" / "Load as B": put the satellite the lookup found into that slot.
// Same rule as the dropdowns: if it's already in the OTHER slot, swap the two.
$("loadAsA").addEventListener("click", () => { //when the load A button is clicked, run the code inside
  if (!lookupFound) return;                              // nothing found: do nothing
  const a = lookupFound, b = a === pair.B ? pair.A : pair.B;
  markActiveTestCase(null);                              // un-highlight any test case button
  setPair(a, b);                                         // load TLEs, set the dates, redraw
});
$("loadAsB").addEventListener("click", () => {
  if (!lookupFound) return;
  const b = lookupFound, a = b === pair.A ? pair.B : pair.A;
  markActiveTestCase(null);
  setPair(a, b);
});



$("playBtn").addEventListener("click", () => {
  playing = !playing;   // "!" means "not", so this flips true <-> false
  $("playBtn").innerHTML = playing ? "Ⅱ" : '<span class="playIcon">▶</span>';
});
$("timelineSlider").addEventListener("input", event => {
  currentMs = Number(event.target.value);
  updateScene();
});
$("zoomInBtn").addEventListener("click", () => { cameraTween = null; camera.position.lerp(controls.target, 0.2); });
$("zoomOutBtn").addEventListener("click", () => { cameraTween = null; camera.position.sub(controls.target).multiplyScalar(1.25).add(controls.target); });
$("resetBtn").addEventListener("click", moveCameraSmoothly);

// Keep the 3D view beside the panel and the right size when the window is resized.
function updateRendererLayout() {
  const desktop = innerWidth > 760;
  const left = desktop ? Math.ceil($("ui").getBoundingClientRect().right + 18) : 0;
  const width = Math.max(1, innerWidth - left);
  renderer.domElement.style.left = `${left}px`;
  camera.aspect = width / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(width, innerHeight);
}
addEventListener("resize", updateRendererLayout);
updateRendererLayout();

// ---------------------------------------------------------------------------
// 12. The animation loop — the browser calls this about 60 times per second
// ---------------------------------------------------------------------------
function animate(now) {
  requestAnimationFrame(animate);   // Ask to be called again on the next frame

  if (playing && pair.A && library[pair.A] && library[pair.B]) {
    const secondsSinceLastFrame = Math.min((now - lastFrameTime) / 1000, 0.1);
    currentMs += secondsSinceLastFrame * Number($("speed").value) * 1000;   // speed = simulated seconds per real second
    if (currentMs > endMs) currentMs = startMs;   // Loop back to the start
    updateScene();
  }

  if (cameraTween) {
    const raw = Math.min(1, (now - cameraTween.start) / cameraTween.duration);
    const eased = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;   // Start slow, speed up, slow down
    camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
    controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
    if (raw >= 1) cameraTween = null;
  }

  lastFrameTime = now;
  controls.update();
  renderer.render(scene, camera);
}

// Load the full satellite catalog for the lookup box. async function can wait for slow things, like downloading a long file 
async function loadSatcat() { 
  $("lookupResult").textContent = "Loading satellite catalog…"; 
  const response = await fetch("data/satcat.json");
  if (!response.ok) {
    $("lookupResult").textContent = "Satellite catalog not found. Run:  python Viz/build_satcat_json.py";
    return;
  } 
  satcat = await response.json();
  $("lookupResult").textContent = `Catalog ready: ${satcat.length.toLocaleString()} objects.`;
}

// ---------------------------------------------------------------------------
// 13. Start: load the satellite list and test cases, then show the first test case
// ---------------------------------------------------------------------------
loadSatcat();   // no "await": load the catalog in the background so the 3D view doesn't wait for it
try {
  const indexResponse = await fetch("data/tles/index.json");
  if (!indexResponse.ok) throw new Error("TLE library not found. Run:  python Code/build_tle_library.py");
  catalog = (await indexResponse.json()).satellites;
  fillDropdowns();

    // Start with the first two satellites in the list, over their full date range
  await setPair(catalog[0].norad, catalog[1].norad);

  // Test cases are optional shortcuts: if the file is missing, the page still works
  try {
    const testCases = (await fetch("data/test_cases.json").then(r => r.json())).testCases;
    showTestCases(testCases);
  } catch (error) {
    console.warn("No test cases loaded:", error);
  }

} catch (error) {
  $("rangeNote").textContent = error.message;
  console.error(error);
}
animate(performance.now());
