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
const DOT_SCREEN_SIZE = 0.022       // 0.022 = 2.2% of the screen height at any given moment
const LABEL_SCREEN_SIZE = 0.03      // name labels are 3% of the screen height at any given moment

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
let catalog = [];            // List of satellites from the TLE library's index.json
let tleFolder = "data/tles"; // where the TLE library is: the full one (on your computer) or data/tles_public (on the live site)
let satcat = [];             // Full satellite catalog from data/satcat.json, for the lookup box
let satcatError = "";        // why the catalog failed to load ("" = no problem so far)
let closest = null;          // the closest approach in the time window, once found: { ms, km, stepMs }
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

// Load one satellite's TLEs (only the first time it's needed): its full history from our own
// TLE library if we have it, otherwise its latest TLE live from CelesTrak.
async function loadSatellite(norad) {
  if (library[norad]) return library[norad];
  const libraryInfo = catalog.find(s => s.norad === norad);       // undefined if not in our library
  const tles = libraryInfo ? await loadLibraryTles(norad) : await loadCurrentTle(norad);
  const epochsMs = tles.map(t => Date.parse(t.epoch));            // epochs as numbers, for fast searching
  library[norad] = {
    info: libraryInfo ?? satcatInfo(norad),
    tles,
    epochsMs,
    // The dates this satellite can be modeled: from its first to last TLE,
    // or one day either side of its TLE if it only has one (a live TLE)
    coverage: tles.length > 1 ? [epochsMs[0], epochsMs[epochsMs.length - 1]]
                              : [epochsMs[0] - DAY_MS, epochsMs[0] + DAY_MS],
    satrecs: [],   // SGP4 set-up for each TLE, filled in the first time each TLE is used
  };
  return library[norad];
}

// TLE history from our own library: <tleFolder>/<NORAD>.json (made by build_tle_library.py,
// or the published subset made by build_public_tle_library.py)
async function loadLibraryTles(norad) {
  const response = await fetch(`${tleFolder}/${norad}.json`);
  if (!response.ok) throw new Error(`Could not load TLEs for NORAD ${norad} (HTTP ${response.status})`);
  return (await response.json()).tles;
}

// The LATEST TLE for any satellite with a public orbit, from CelesTrak's free service.
// Nothing comes back for objects that have re-entered or whose orbits aren't published.
// TESTING SETUP: CelesTrak is used while building and testing the tool. For actual use,
// this function can be swapped for another TLE source (see "Data sources" in README.md).
async function loadCurrentTle(norad) {
  let response;
  try {
    response = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${Number(norad)}&FORMAT=TLE`);
  } catch {                                              // no answer at all (offline, or CelesTrak unreachable)
    throw new Error("Couldn't reach CelesTrak for a current TLE. Check your internet connection and try again.");
  }
  const lines = (await response.text()).split("\n").map(line => line.trim());
  const line1 = lines.find(line => line.startsWith("1 "));
  const line2 = lines.find(line => line.startsWith("2 "));
  if (!response.ok || !line1 || !line2) {
    throw new Error(`CelesTrak has no current TLE for NORAD ${Number(norad)}: it may have re-entered, or its orbit isn't public.`);
  }
  return [{ epoch: new Date(tleEpochMs(line1)).toISOString(), source: "CelesTrak (latest)", line1, line2 }];
}

// A TLE's epoch, from columns 19-32 of line 1: a 2-digit year, then the day of the year with a fraction.
function tleEpochMs(line1) {
  let year = Number(line1.slice(18, 20));
  year += year < 57 ? 2000 : 1900;                               // TLEs started in 1957
  return Date.UTC(year, 0, 1) + (Number(line1.slice(20, 32)) - 1) * DAY_MS;
}

// Name and designator for a satellite that isn't in our library, from the full catalog.
function satcatInfo(norad) {
  const entry = satcat.find(s => Number(s.norad) === Number(norad));
  return { name: entry?.name ?? `NORAD ${Number(norad)}`, intlDes: entry?.intlDes ?? null, country: null };
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
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(SLOTS[slot].dot), sizeAttenuation: false })); // sizeAttenuation: false tells three.js not to shrink the sprite as it gets further away
  dot.scale.set(0.055, 0.055, 1);
  dot.renderOrder = 8;
  scene.add(dot);
  dots[slot] = dot;

  const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SLOTS[slot].line, transparent: true, opacity: 0.75 }));
  scene.add(trail);
  trails[slot] = trail;
}


// Name labels that sit next to each dot in the 3D view.
// Text is drawn onto a small image (a "canvas"), which becomes the label's texture.
const labels = {};  // labels.A and labels.B
for (const slot of ["A", "B"]) {
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true, sizeAttenuation: false }));
  // Where the label sits next to its dot: A's just above and to the right, B's just below and to the
  // right, so the two names don't overlap when the satellites are close together.
  label.center.set(-0.08, slot === "A" ? -0.1 : 1.1);
  label.scale.set(0.29, 0.055, 1);   // the label image is 5.33 times wider than it is tall
  label.renderOrder = 9;
  label.visible = false;
  scene.add(label);
  labels[slot] = label;
}
function setLabelText(slot, text) {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.font = "650 44px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillStyle = "#333";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 8, 48);
  labels[slot].material.map?.dispose();
  labels[slot].material.map = new THREE.CanvasTexture(canvas);
  labels[slot].material.needsUpdate = true;
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
  $("sliderNow").textContent = formatTime(currentMs);
  $("timelineSlider").value = currentMs;

  // Spin Earth to the right angle for this moment (Greenwich sidereal time).
  earthGroup.rotation.y = -sgp4.gstime(new Date(currentMs));

    if (view === "relative" && pair.A && pair.B) drawRelative();

  for (const slot of ["A", "B"]) {             // name labels follow their dots
    labels[slot].position.copy(dots[slot].position);
    labels[slot].visible = dots[slot].visible;
  }

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
    if (!pair[slot]) continue;                  // empty slot
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
    const framing = view === "relative" ? relativeFraming() : fullEarthFraming();
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
  const a = library[pair.A].coverage, b = library[pair.B].coverage;
  const overlapStart = Math.max(a[0], b[0]), overlapEnd = Math.min(a[a.length - 1], b[b.length - 1]);
  const overlap = overlapStart < overlapEnd;
  if (overlap && $("useOverlap").checked) return { min: overlapStart, max: overlapEnd, overlap, overlapOnly: true };
  return { min: Math.min(a[0], b[0]), max: Math.max(a[a.length - 1], b[b.length - 1]), overlap, overlapOnly: false };
}

// Pick a pair of satellites. Either can be empty (null or "") while the user is still choosing.
// Each chosen satellite is loaded straight away (from our library, or live from CelesTrak);
// once both are loaded, the dates are set and the pair is modeled.
async function setPair(noradA, noradB, requestedStart = null, requestedEnd = null) {
  pair.A = noradA || null; pair.B = noradB || null;      // "" (the Choose… option) becomes null
  $("rangeNote").textContent = "Loading TLEs…";

  // Load whichever satellites are chosen. allSettled waits for all of them, even if one fails.
  const chosen = [pair.A, pair.B].filter(norad => norad);
  const results = await Promise.allSettled(chosen.map(norad => loadSatellite(norad)));
  const failed = results.find(result => result.status === "rejected");
  if (!library[pair.A]) pair.A = null;                   // a satellite that failed to load
  if (!library[pair.B]) pair.B = null;                   // is taken back out of its slot

  // Show the choices in the dropdowns (live satellites get added to them first)
  if (pair.A) addToDropdowns(pair.A);
  if (pair.B) addToDropdowns(pair.B);
  $("satA").value = pair.A ?? ""; $("satB").value = pair.B ?? "";  
    updateNames();

    if (failed || !pair.A || !pair.B) {                    // nothing to model yet
    setView("earth");                                    // back to Full Earth
    clearScene();
    $("rangeNote").textContent = failed ? failed.reason.message
      : (pair.A || pair.B) ? `Now choose satellite ${pair.A ? "B" : "A"}.`
      : "Search for a satellite or pick one from the dropdowns to begin.";
    return;
  }
  applyLimits(requestedStart, requestedEnd);
  lastIdentityKey = "";
    setView(preferredView);                                         // redraw and re-frame in the current view
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

// Take both satellites off the globe and blank the readouts (used while the pair isn't complete).
function clearScene() {
  for (const slot of ["A", "B"]) {
    dots[slot].visible = false;                          // hide the satellite's dot
    labels[slot].visible = false;                        // and its name
    trails[slot].geometry.dispose();                     // free the old orbit line's memory...
    trails[slot].geometry = new THREE.BufferGeometry();  // ...and replace it with an empty one
  }
  $("rangeStat").textContent = "—";                     // distance
  $("timeDisplay").textContent = "—";                   // time
  $("sliderNow").textContent = "—";
  $("identity").innerHTML = "";                          // "Now modeling" panel
  lastIdentityKey = "";                                  // make sure the panel rebuilds next time
    closest = null;
  $("closestApproach").hidden = true;
  const chart = $("separationChart");
  chart.getContext("2d").clearRect(0, 0, chart.width, chart.height);   // blank the chart
}

// Set the start and end of the time window, and jump to the start.
function setWindow(newStart, newEnd) {
  if (newEnd <= newStart) newEnd = newStart + DAY_MS;   // Never allow an empty window
  startMs = newStart; endMs = newEnd; currentMs = startMs;
  $("startTime").value = toInputValue(startMs);
  $("endTime").value = toInputValue(endMs);
  $("timelineSlider").min = startMs;
  $("timelineSlider").max = endMs;
  $("sliderStart").textContent = formatDate(startMs);
  $("sliderEnd").textContent = formatDate(endMs);
  updateScene();
  updateClosestApproach();
}

// Add a satellite loaded live from CelesTrak to both dropdowns (once), so it can be picked again.
function addToDropdowns(norad) {
  for (const select of [$("satA"), $("satB")]) {
    if (![...select.options].some(option => option.value === norad)) {
      select.add(new Option(`${library[norad].info.name} (${norad}) · live`, norad));
    }
  }
}
// The name of the satellite in a slot ("A" or "B"), or "Satellite A" / "Satellite B" if none is loaded yet.
function slotName(slot) {
  return library[pair[slot]]?.info.name ?? `Satellite ${slot}`;
}

// Show the chosen satellites' names in the panel and the 3D view, instead of "A" and "B".
function updateNames() {
   $("centreNameA").textContent = slotName("A");
  $("centreNameB").textContent = slotName("B");
  $("nameA").textContent = slotName("A");
  $("nameB").textContent = slotName("B");
  $("separationTitle").textContent = `Separation between ${slotName("A")} and ${slotName("B")}`;
  setLabelText("A", slotName("A"));
  setLabelText("B", slotName("B"));
}


// Fill both dropdowns with every satellite in the library, e.g. "USA 245 (39232)",
// after a blank "Choose a satellite…" option for when nothing is chosen yet.
function fillDropdowns() {
  for (const select of [$("satA"), $("satB")]) {
    select.innerHTML = `<option value="">Choose a satellite…</option>` +
      catalog.map(s => `<option value="${s.norad}">${s.name} (${s.norad})</option>`).join("");
  }
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
   // 2b. A whole launch: a long designator without the piece letters, like 2019-079
  if (/^\d{4}-\d{3}$/.test(text)) {
    return satcat.filter(s => s.intlDes.startsWith(text));
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
    // Otherwise, best matches first: names that START with the text, then names that contain it elsewhere
  const startsWith = satcat.filter(s => s.name.startsWith(name));
  const containsElsewhere = satcat.filter(s => s.name.includes(name) && !s.name.startsWith(name));
  return [...startsWith, ...containsElsewhere];

}
// ---------------------------------------------------------------------------
// Closest approach: when, during the time window, are A and B nearest each other?
// ---------------------------------------------------------------------------
// Step 1: check the distance at evenly spaced moments (every 30 seconds, or fewer
//         checks for long windows, so there are never more than about 20,000).
// Step 2: every "dip" (a moment closer than the moments either side of it) might be
//         the closest approach, so zoom in on the 10 deepest dips to find the exact moment.
function findClosestApproach() {
  const stepMs = Math.max(30 * 1000, (endMs - startMs) / 20000);
  const samples = [];
  for (let ms = startMs; ms <= endMs; ms += stepMs) samples.push({ ms, km: separationAt(ms) });
  const dips = samples.filter((s, i) => s.km !== null
    && (i === 0 || samples[i - 1].km === null || s.km <= samples[i - 1].km)
    && (i === samples.length - 1 || samples[i + 1].km === null || s.km <= samples[i + 1].km));
  if (dips.length === 0) return null;
  dips.sort((p, q) => p.km - q.km);                      // deepest dips first
  let best = null;
  for (const dip of dips.slice(0, 10)) {
    const found = zoomInOnDip(dip.ms - stepMs, dip.ms + stepMs);
    if (found && (!best || found.km < best.km)) best = found;
  }
  if (best) best.stepMs = stepMs;
  return best;
}

// Zoom in on the closest moment between lo and hi: check 100 evenly spaced moments,
// keep the closest, then repeat in a narrower range around it until we're within a second.
function zoomInOnDip(lo, hi) {
  lo = Math.max(startMs, lo); hi = Math.min(endMs, hi);
  let best = null;
  while (true) {
    const step = (hi - lo) / 100;
    for (let i = 0; i <= 100; i++) {
      const ms = lo + i * step, km = separationAt(ms);
      if (km !== null && (!best || km < best.km)) best = { ms, km };
    }
    if (!best || step < 1000) return best;
    lo = Math.max(startMs, best.ms - step); hi = Math.min(endMs, best.ms + step);
  }
}

// "21.4 km" for small distances, "6,176 km" for big ones
const formatKm = km => km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;
const formatTimeSeconds = ms => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(ms));

// ---------------------------------------------------------------------------
// Relative motion view (set up like the original storyline page):
// satellite A sits still at the centre, and B is drawn where it is RELATIVE to A,
// along A's own directions:
//   radial      = straight up, away from Earth
//   along-track = the direction A is travelling
//   cross-track = sideways, out of A's orbit plane
// Earth is drawn to scale underneath, and B leaves a fading trail of the last 4 hours.
// ---------------------------------------------------------------------------
let view = "earth";                  // "earth" (Full Earth) or "relative" (Relative motion)
let preferredView = "relative";      // the view to open whenever a pair is loaded: Relative motion at first, then whichever the user last clicked
let showAxes = false;                // direction axes on or off (the round button under the home button)
let centre = "A";                    // which satellite sits at the centre of the relative view: "A" or "B"
const otherSlot = () => centre === "A" ? "B" : "A";   // the satellite that moves around it
const RELATIVE_SCALE_KM = 1000;      // in the relative view, 1 scene unit = 1,000 km (as in the original)
const RELATIVE_TRAIL_HOURS = 4;      // how much of B's recent path to show
const RELATIVE_TRAIL_POINTS = 240;   // one point per minute
const RELATIVE_VIEW_DISTANCE = 0.5;  // normal camera distance in the relative view: 0.5 units = 500 km

// A's own directions (each an arrow of length 1, in Earth-centred coordinates)
function ricAxes(stateA) {
  const unit = v => { const n = Math.hypot(v[0], v[1], v[2]); return v.map(x => x / n); };
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const R = unit(stateA.r);                    // up
  const C = unit(cross(stateA.r, stateA.v));   // out of the orbit plane
  const I = cross(C, R);                       // along the direction of travel
  return { R, I, C };
}

// Any position, measured from A along A's directions: [radial, along-track, cross-track] in km.
function ricOf(stateA, r) {
  const { R, I, C } = ricAxes(stateA);
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const d = [r[0] - stateA.r[0], r[1] - stateA.r[1], r[2] - stateA.r[2]];   // from A to the position
  return [dot(d, R), dot(d, I), dot(d, C)];
}

// Same layout as the original page: along-track left-right, cross-track up-down, radial towards you.
const relativeToScene = ([r, i, c]) => new THREE.Vector3(i, c, r).divideScalar(RELATIVE_SCALE_KM);

// B relative to A at time ms, as a point in the scene (or null if a position isn't available)
// tleCentre / tleOther: which TLE to use for each (leave out to use the nearest one).
function relativePointAt(ms, tleCentre = null, tleOther = null) {
  const c = stateAt(pair[centre], ms, tleCentre), o = positionAt(pair[otherSlot()], ms, tleOther);
  return c && o ? relativeToScene(ricOf(c, o)) : null;
}

// Long, labelled axis lines through A (the same size as the original page's), shown only in the relative view.
const relativeAxes = new THREE.Group();
relativeAxes.visible = false;
scene.add(relativeAxes);
{
  const material = new THREE.LineBasicMaterial({ color: 0xcccccc });
  const axis = (from, to) => relativeAxes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), material));
  axis(new THREE.Vector3(-14, 0, 0), new THREE.Vector3(14, 0, 0));
  axis(new THREE.Vector3(0, -5, 0), new THREE.Vector3(0, 5, 0));
  axis(new THREE.Vector3(0, 0, -14), new THREE.Vector3(0, 0, 14));
}

// B's fading trail: one line whose colour goes from white (4 hours ago, blending into the
// background) to grey (now), so older positions fade away.
const relativeTrail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
relativeTrail.visible = false;
scene.add(relativeTrail);

// Put Earth in the right place, size and orientation for the relative view:
// centred straight "down" from A, at 1 unit = 1,000 km, turned to match A's directions.
function placeEarthRelative(stateA) {
  const { R, I, C } = ricAxes(stateA);
  const toScene = v => new THREE.Vector3(v[0], v[2], -v[1]);   // same axis swap as eciToScene
  const turn = new THREE.Matrix4().makeBasis(toScene(I), toScene(C), toScene(R)).transpose();
  const centre = relativeToScene(ricOf(stateA, [0, 0, 0]));   // Earth's centre, seen from A
  const size = EARTH_RADIUS_KM / RELATIVE_SCALE_KM;
  earthGroup.matrix.makeTranslation(centre.x, centre.y, centre.z)
    .multiply(turn)
    .multiply(new THREE.Matrix4().makeRotationY(-sgp4.gstime(new Date(currentMs))))
    .multiply(new THREE.Matrix4().makeScale(size, size, size));
}

// In the relative view: A at the centre, B at its relative position, B's fading trail, Earth below.
function drawRelative() {
  const stateCentre = stateAt(pair[centre], currentMs);
  if (!stateCentre) return;
  placeEarthRelative(stateCentre);
  const other = otherSlot();
  dots[centre].visible = true;
  dots[centre].position.set(0, 0, 0);
  const now = relativePointAt(currentMs);
  dots[other].visible = now !== null;
  if (now) dots[other].position.copy(now);

  // Draw the whole trail from the TLEs in use right now, so it doesn't kink wherever the
  // nearest TLE would change partway along it (the same trick the orbit lines use)
  const tleCentre = nearestTleIndex(library[pair[centre]], currentMs);
  const tleOther = nearestTleIndex(library[pair[other]], currentMs);
  const points = [], colors = [];
  const faded = new THREE.Color(0xffffff), recent = new THREE.Color(0x777777);
  for (let i = 0; i <= RELATIVE_TRAIL_POINTS; i++) {
    const fraction = i / RELATIVE_TRAIL_POINTS;            // 0 = 4 hours ago, 1 = now
        const p = relativePointAt(currentMs - RELATIVE_TRAIL_HOURS * 60 * MINUTE_MS * (1 - fraction), tleCentre, tleOther);
    if (!p) continue;
    points.push(p);
    const color = faded.clone().lerp(recent, fraction ** 1.7);
    colors.push(color.r, color.g, color.b);
  }
  relativeTrail.geometry.dispose();
  relativeTrail.geometry = new THREE.BufferGeometry().setFromPoints(points);
  relativeTrail.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
} // closes drawRelative

// Switch between the Full Earth and Relative motion views.
// fitBoth = true (used by "View closest approach") also zooms so BOTH satellites are in the frame.
function setView(next, nextCentre = centre, fitBoth = false) {
  if (!pair.A || !pair.B) next = "earth";                 // the relative view needs two satellites
  view = next;
  centre = nextCentre;
  const relative = view === "relative";
  $("centreSwitch").hidden = !relative;                   // "Centre on" buttons only in the relative view
  $("centreA").classList.toggle("activeViewSwitch", centre === "A");
  $("centreB").classList.toggle("activeViewSwitch", centre === "B");
  earthGroup.matrixAutoUpdate = !relative;                // in the relative view, placeEarthRelative sets Earth's position
  relativeAxes.visible = relative && showAxes;            // axes only if switched on
  $("axesBtn").hidden = !relative;                        // the axes button only appears in the relative view
  relativeTrail.visible = relative;
  trails.A.visible =!relative; // visible is a true false setting and ! means not, so we are saying the trails are not visible in the relative view and visible in the full earth view 
  trails.B.visible = !relative;
  camera.fov = relative ? 35 : 15.5;                       // a wider lens up close, as in the original
  camera.updateProjectionMatrix();
  $("earthView").classList.toggle("activeViewSwitch", !relative);
  $("relativeView").classList.toggle("activeViewSwitch", relative);
  $("viewNote").textContent = relative
    ? `${slotName(centre)} is at the centre and Earth is drawn to scale below it. The fading line is ${slotName(otherSlot())}'s path over the last ${RELATIVE_TRAIL_HOURS} hours.`
    : "";

  if (pair.A || pair.B) updateScene();
  // Jump the camera straight into place (as the original does) instead of gliding
  cameraTween = null;
  const framing = relative ? relativeFraming(fitBoth) : fullEarthFraming();
  camera.position.copy(framing.position);
  controls.target.copy(framing.target);

// Dots and name labels stay the same size on screen, independent of how zoomed in the camera view is.
// sizeAttenuation: false (where they are made as sprites) measures their size on the screen and not in space
// Multiplying by the lens width makes them the same size in both views, whose lenses differ
const lens = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov/2)); // Full Earth uses a 15.5 degree narrow lens and the relative view uses a 35 degree wider one. The wider lens fits more onto the screen, so everything looks smaller. This finds out how wide each lens is, and degToRad converts degrees into the unit JS uses. Multiplying by lens cancels out the difference so dots will be the same size in both views 
const dotsize = DOT_SCREEN_SIZE * lens; // sets dotsize to what we established earlier 
const labelSize = LABEL_SCREEN_SIZE * lens;
for (const slot of ["A", "B"]) { // for loop applies the sizes to both A and B
  dots[slot].scale.set(dotsize, dotsize, 1);
  labels[slot].scale.set(labelSize * 5.33, labelSize, 1); // the label image is 5.33 times wider than it is tall
  }
}
// Always put the centre satellite in the middle of the picture.
// Normally: view from the original page's angle, 500 km away.
// fitBoth (for "View closest approach"): look from the side of the line between the two
// satellites (so one can't hide behind the other), and stand far enough back that the other
// satellite sits comfortably inside the frame, however close they are.
function relativeFraming(fitBoth = false) {
  const centreOfFrame = new THREE.Vector3(0, 0, 0);       // the centre satellite is always at (0, 0, 0)
  if (!fitBoth) {
    const direction = new THREE.Vector3(1, 0.62, 1.08).normalize();
    return { position: direction.multiplyScalar(RELATIVE_VIEW_DISTANCE), target: centreOfFrame };
  }
    // How far the other satellite's path reaches from the centre satellite over the last orbit
  // (one loop of the fading path; the trail has one point per minute, newest last)
  const lib = library[pair[centre]];
  const orbitMinutes = Math.round(2 * Math.PI / satrecFor(lib, nearestTleIndex(lib, currentMs)).no);
  let reach = dots[otherSlot()].position.length();
  const trail = relativeTrail.geometry.attributes.position;
  for (let i = Math.max(0, trail.count - 1 - orbitMinutes); i < trail.count; i++) {
    reach = Math.max(reach, Math.hypot(trail.getX(i), trail.getY(i), trail.getZ(i)));
  }
  // Look from the original page's angle, far enough back that all of it fits, about 70% of the
  // way from the middle to the edge. (The camera sees tan(fov/2) units of height either side of
  // the middle for every unit of distance away.)
  const direction = new THREE.Vector3(1, 0.62, 1.08).normalize();
  const halfHeightPerUnit = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const distance = Math.max(reach, 0.0005) / (0.7 * halfHeightPerUnit);
  return { position: direction.multiplyScalar(distance), target: centreOfFrame };
}


// Work out the closest approach for the current window and show it in the panel.
function updateClosestApproach() {
  closest = pair.A && pair.B ? findClosestApproach() : null;
  $("closestApproach").hidden = !closest;
  if (!closest) return;
  const tleAges = ["A", "B"].map(slot => {
    const lib = library[pair[slot]], i = nearestTleIndex(lib, closest.ms);
    return `${slotName(slot)} ${describeAge(closest.ms - lib.epochsMs[i])}`;
  });
  $("caDistance").textContent = formatKm(closest.km);
  $("caTime").textContent = formatTimeSeconds(closest.ms);
  $("caDetails").textContent =
    `Nearest TLEs: ${tleAges.join("; ")}. ` +
    `Checked every ${Math.round(closest.stepMs / 1000).toLocaleString()} s, then narrowed to 1 s. ` +
    `Accuracy is limited by the TLEs (typically a kilometre or more, worse far from a TLE epoch).`;
}

// ---------------------------------------------------------------------------
// 11. Responding to the user
// ---------------------------------------------------------------------------
// When a dropdown changes: if the user picked the same satellite as the other slot,
// swap them so A and B are always different.
$("satA").addEventListener("change", event => {
  const a = event.target.value, b = a === pair.B ? pair.A : pair.B; //norad number now comes from event.target.value
  setPair(a, b); //writes two selected satellites into sat pair  S
});
$("satB").addEventListener("change", event => {
  const b = event.target.value, a = b === pair.A ? pair.B : pair.A;
  setPair(a, b);
});

// Ticking/unticking the overlap checkbox resets the window to the new default range.
$("useOverlap").addEventListener("change", () => { if (pair.A && pair.B) applyLimits(); });
$("startTime").addEventListener("change", () => setWindow(fromInputValue($("startTime").value), endMs));
$("endTime").addEventListener("change", () => setWindow(startMs, fromInputValue($("endTime").value)));

// Satellite lookup: run when "Look up" is clicked or Enter is pressed in the box.
function runLookup() {
  $("lookupActions").hidden = true;            // tells the html file to hide the Load buttons until we know there's something to load
   lookupFound = null;                          // forget the previous result

  if (satcatError) {                           // the catalog FAILED to load: keep saying why
    $("lookupResult").textContent = satcatError;
    return;
  }
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
      $("lookupResult").textContent = `${describe(found)}\nNo TLE history on this site, but its current orbit can be loaded live from CelesTrak.`;
      lookupFound = found.norad.padStart(5, "0");   // 5 digits, the same style as the TLE library
      $("lookupActions").hidden = false;
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
  setPair(a, b);                                         // load TLEs, set the dates, redraw
});
$("loadAsB").addEventListener("click", () => {
  if (!lookupFound) return;
  const b = lookupFound, a = b === pair.A ? pair.B : pair.A;
  setPair(a, b);
});

// Full Earth / Relative motion switch
$("earthView").addEventListener("click", () => { preferredView = "earth"; setView("earth"); });
$("relativeView").addEventListener("click", () => { preferredView = "relative"; setView("relative"); });
$("centreA").addEventListener("click", () => setView("relative", "A"));
$("centreB").addEventListener("click", () => setView("relative", "B"));
// Show or hide the direction axes in the relative view
$("axesBtn").addEventListener("click", () => {
  showAxes = !showAxes;                                   // flip on <-> off
  $("axesBtn").classList.toggle("isOn", showAxes);       // dark when on
  relativeAxes.visible = view === "relative" && showAxes;
});




// Jump to the closest approach, in the satellite-centred view
$("caViewBtn").addEventListener("click", () => {
  if (!closest) return;
  playing = false;                                       // pause, so it stays on that moment
  $("playBtn").innerHTML = '<span class="playIcon">▶</span>';
  currentMs = closest.ms;
  setView("relative", centre, true);                     // true = zoom so both satellites are in the frame
});

$("playBtn").addEventListener("click", () => {
  playing = !playing;   // "!" means "not", so this flips true <-> false
  $("playBtn").innerHTML = playing ? "Ⅱ" : '<span class="playIcon">▶</span>';
});
// The time bar's pop-up: the exact date and time at a point along the slider.
// x is how far along the slider that point is, in pixels from its left edge.
function showSliderTip(ms, x) {
  $("sliderTip").textContent = formatTime(ms);
  $("sliderTip").style.left = `${x}px`;
  $("sliderTip").hidden = false;
}

// Dragging or clicking the slider: jump to that moment and show it in the pop-up
$("timelineSlider").addEventListener("input", event => {
  currentMs = Number(event.target.value);
  updateScene();
  const fraction = (currentMs - startMs) / (endMs - startMs);
  showSliderTip(currentMs, fraction * event.target.clientWidth);
});

// Hovering: show the date under the mouse, without moving the time
$("timelineSlider").addEventListener("pointermove", event => {
  const fraction = Math.min(1, Math.max(0, event.offsetX / event.target.clientWidth));
  showSliderTip(startMs + fraction * (endMs - startMs), event.offsetX);
});
$("timelineSlider").addEventListener("pointerleave", () => { $("sliderTip").hidden = true; });
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
  try {                                                  // if anything inside fails, jump to catch
    const response = await fetch("data/satcat.json");
    if (!response.ok) throw new Error("Satellite catalog not found. Run:  python Viz/build_satcat_json.py");
    satcat = await response.json();
    $("lookupResult").textContent = `Catalog ready: ${satcat.length.toLocaleString()} objects.`;
  } catch (error) {                                      // missing file, broken file, or no connection
    satcatError = error.message;                         // remember why, for runLookup
    $("lookupResult").textContent = satcatError;
  }
}

// ---------------------------------------------------------------------------
// 13. Start: load the satellite catalog and TLE library list, then wait for the user to pick satellites
// ---------------------------------------------------------------------------
loadSatcat();   // no "await": load the catalog in the background so the 3D view doesn't wait for it
try {
  let indexResponse = await fetch(`${tleFolder}/index.json`);
  if (!indexResponse.ok) {                     // no full library (as on the live site): use the published subset
    tleFolder = "data/tles_public";
    indexResponse = await fetch(`${tleFolder}/index.json`);
  }
  if (!indexResponse.ok) throw new Error("TLE library not found. Run:  python Code/build_tle_library.py");
  catalog = (await indexResponse.json()).satellites;
  fillDropdowns();

  setPair(null, null);   // start empty: the user picks both satellites

} catch (error) {
  $("rangeNote").textContent = error.message;
  console.error(error);
}
animate(performance.now());
