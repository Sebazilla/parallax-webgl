// Head-tracked parallax Wimmelbild "Find the Cat" in the browser.
//
// Design goals (from Astrid's feedback):
//   - Parallax should be very subtle ("ganz leichte Bewegung") — like a hint that
//     your eyes are slightly lying to you. NOT VR-dramatic.
//   - Cats should never be fully visible — just an ear, head, or tail poking out.
//   - Cats sit on plausible surfaces (sofa, rug, shelf), not floating.
//   - Hiders placed where they'd naturally be (pillow on sofa, photo on wall, etc).
//   - Multiple distinct depths so different layers move at slightly different rates.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/vision_bundle.mjs';

// ---- Device geometry (meters). Canvas derived from CSS px.
const CSS_PX_TO_M = 0.000181;
const CAMERA_ABOVE_CANVAS_TOP = 0.020;

let SCREEN_W = 0.077;
let SCREEN_H = 0.150;
let CAMERA_TO_SCREEN_CENTER_Y = 0.095;

function updateGeometry() {
  SCREEN_W = Math.max(0.03, window.innerWidth * CSS_PX_TO_M);
  SCREEN_H = Math.max(0.05, window.innerHeight * CSS_PX_TO_M);
  CAMERA_TO_SCREEN_CENTER_Y = CAMERA_ABOVE_CANVAS_TOP + SCREEN_H / 2;
}

const IOD_METERS = 0.063;
const CAMERA_HFOV_DEG = 70;

// ---- Scene composition.
// Tight z range (~5 cm total spread) keeps parallax subtle. Each hider sits at a
// slightly different depth so they don't all move in lockstep. Each cat sits
// 15–20 mm behind its hider, so as the head moves, cat shifts a little more on
// screen than the hider and peeks out.
const BG = { name: 'wimmel_bg', h: 0.220, aspect: 0.67, x: 0, y: 0.005, z: -0.030 };

// HIDERS — each: name, h, aspect, x, y, z, optional mirror.
// silX/silY: center of opaque silhouette in PNG coords (AFTER mirror).
// peekX/peekY: world-space offset applied to cat position so only ear/head/tail
// peeks out of the silhouette. +Y = ear/head above. -Y = tail/back below. ±X = side peek.
const HIDERS = [
  // Long fabric on left window edge. Cat tucked at curtain bottom, tail peeks right.
  { name: 'obj_curtain_left', h: 0.175, aspect: 0.40, x: -0.040, y:  0.000, z: -0.020,
    silX: 0.27, silY: 0.46, peekX:  0.010, peekY: -0.018 },
  // Framed photo on the wall (upper-right). Cat head peeks above the frame.
  { name: 'obj_framed_photo', h: 0.045, aspect: 1.33, x:  0.028, y:  0.030, z: -0.017,
    silX: 0.48, silY: 0.52, peekX:  0.000, peekY:  0.014 },
  // Throw pillow on sofa (middle-left cushion). Cat ears peek above pillow.
  { name: 'obj_throw_pillow', h: 0.048, aspect: 1.00, x: -0.018, y: -0.032, z: -0.016,
    silX: 0.50, silY: 0.60, peekX: -0.004, peekY:  0.013 },
  // Teddy on rug (bottom centre). Cat peeks from behind teddy, to the right.
  { name: 'obj_teddy_bear',   h: 0.058, aspect: 0.75, x:  0.010, y: -0.070, z: -0.015,
    silX: 0.58, silY: 0.68, peekX:  0.013, peekY: -0.002 },
  // Books stack on side table (right side). Cat tail peeks out below books.
  { name: 'obj_books_stack',  h: 0.040, aspect: 1.20, x:  0.035, y: -0.042, z: -0.018,
    silX: 0.53, silY: 0.48, peekX:  0.008, peekY: -0.012 },
];

// Each cat sits at a slightly different depth for varied parallax.
const CAT_DEPTH_OFFSETS = [-0.005, -0.004, -0.005, -0.006, -0.004]; // cat sits just behind hider
const CAT_H = 0.028;

// DECOR — purely visual props. No cat hides behind them; they exist to fill the
// scene and give more depth layers so different items parallax at slightly
// different rates. All sit behind the cats (z < -0.024) so they never occlude cats.
const DECOR = [
  // Wide rug along the floor, far back.
  { name: 'obj_rug',         h: 0.030, aspect: 1.60, x:  0.000, y: -0.085, z: -0.028 },
  // Floor lamp standing on the far left.
  { name: 'obj_floor_lamp',  h: 0.090, aspect: 0.40, x: -0.055, y: -0.012, z: -0.025 },
  // Potted plant in the right corner.
  { name: 'obj_plant',       h: 0.050, aspect: 0.75, x:  0.055, y: -0.055, z: -0.025 },
  // Wall clock, high on the back wall.
  { name: 'obj_wall_clock',  h: 0.050, aspect: 0.75, x:  0.000, y:  0.055, z: -0.027 },
  // Flower vase on a shelf upper-left.
  { name: 'obj_flower_vase', h: 0.040, aspect: 0.67, x: -0.048, y:  0.045, z: -0.024 },
  // Teapot on a low table, left-centre.
  { name: 'obj_teapot',      h: 0.030, aspect: 1.00, x: -0.035, y: -0.055, z: -0.023 },
  // Teacup next to teapot.
  { name: 'obj_teacup',      h: 0.020, aspect: 1.00, x: -0.018, y: -0.062, z: -0.022 },
  // Candle to the right of the teapot.
  { name: 'obj_candle',      h: 0.028, aspect: 0.50, x:  0.020, y: -0.055, z: -0.023 },
];

const FAR = 10.0;
const NEAR_RESCALE = 0.01;

// ---- DOM
const canvas = document.getElementById('scene');
const video = document.getElementById('cam');
const startEl = document.getElementById('start');
const startBtn = document.getElementById('startBtn');
const hud = document.getElementById('hud');
const toast = document.getElementById('toast');
const counterEl = document.getElementById('counter');

// ---- Three.js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

function resize() {
  updateGeometry();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}

const scene = new THREE.Scene();
const camera = new THREE.Camera();
camera.matrixAutoUpdate = true;

const loader = new THREE.TextureLoader();

function makeLayer({ name, h, aspect, x, y, z, mirror }, renderOrder, writesDepth = false) {
  const geom = new THREE.PlaneGeometry(h * aspect, h);
  const tex = loader.load(`./assets/${name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (mirror) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.x = -1;
    tex.offset.x = 1;
  }
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: writesDepth,
    depthTest: true,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(x, -CAMERA_TO_SCREEN_CENTER_Y + y, z);
  mesh.renderOrder = renderOrder;
  return mesh;
}

// BG renders first and writes depth.
const bgMesh = makeLayer(BG, 0, /* writesDepth */ true);
scene.add(bgMesh);

// Decor at renderOrder 5 (behind cats at 10, in front of BG at 0).
for (const d of DECOR) {
  scene.add(makeLayer(d, 5, false));
}

// Hiders paint on top of cats. renderOrder 20 > cat's 10.
for (const h of HIDERS) {
  scene.add(makeLayer(h, 20, false));
}

// ---- Cat spawning
let catMeshes = [];
function spawnCats() {
  for (const m of catMeshes) {
    scene.remove(m);
    m.material.map?.dispose();
    m.material.dispose();
    m.geometry.dispose();
  }
  catMeshes = [];

  const ez = 0.30; // anchor point for placement math (roughly eye rest distance)

  for (let i = 0; i < HIDERS.length; i++) {
    const h = HIDERS[i];
    const mesh_w = h.h * h.aspect;
    const mesh_h = h.h;
    // Silhouette centre in world (mesh-local XY with y-flip from PNG).
    const silWorldX = h.x + (h.silX - 0.5) * mesh_w;
    const silWorldY = (-CAMERA_TO_SCREEN_CENTER_Y + h.y) + (0.5 - h.silY) * mesh_h;

    // Project that point to screen coords at resting eye=(0,0,ez).
    // Viewing from (0,0,ez) onto plane z=h.z, line to z=0:
    //   screen_x = silWorldX * ez / (ez - h.z); same for y.
    const zRatioHider = ez / (ez - h.z);
    const screenX_sil = silWorldX * zRatioHider;
    const screenY_sil = silWorldY * zRatioHider;

    // Apply peek offset (screen-space) to where the cat should appear at rest.
    const screenX_cat = screenX_sil + h.peekX;
    const screenY_cat = screenY_sil + h.peekY;

    // Solve for cat world position that projects to that screen point at rest.
    const catZ = h.z + CAT_DEPTH_OFFSETS[i];
    const zRatioCat = ez / (ez - catZ);
    const catWorldX = screenX_cat / zRatioCat;
    const catWorldY = screenY_cat / zRatioCat;
    const catLocalY = catWorldY + CAMERA_TO_SCREEN_CENTER_Y;

    const mesh = makeLayer(
      { name: 'cat', h: CAT_H, aspect: 1.0, x: catWorldX, y: catLocalY, z: catZ },
      10,
      false,
    );
    mesh.userData.catId = i;
    mesh.userData.found = false;
    scene.add(mesh);
    catMeshes.push(mesh);
  }
}

// ---- Off-axis projection
function setOffAxisProjection(cam, l, r, b, t, n, f) {
  cam.projectionMatrix.set(
    2 * n / (r - l),  0,                 (r + l) / (r - l),  0,
    0,                2 * n / (t - b),   (t + b) / (t - b),  0,
    0,                0,                -(f + n) / (f - n), -(2 * f * n) / (f - n),
    0,                0,                -1,                   0
  );
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

// ---- Face tracking
let faceLandmarker = null;
let hasFace = false;
const eye = { x: 0, y: 0, z: 0.30 };
const EMA = 0.35;

async function initFaceLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm'
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    outputFaceBlendshapes: false,
    runningMode: 'VIDEO',
    numFaces: 1,
  });
}

async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  if (video.videoWidth === 0) {
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
}

let lastVideoTime = -1;
function stepFaceTracking() {
  if (!faceLandmarker || video.readyState < 2) return false;
  if (video.currentTime === lastVideoTime) return hasFace;
  lastVideoTime = video.currentTime;

  const result = faceLandmarker.detectForVideo(video, performance.now());
  if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
    hasFace = false;
    return false;
  }
  const lm = result.faceLandmarks[0];
  const nose = lm[1];
  const right = lm[33];
  const left = lm[263];
  const W = video.videoWidth;
  const H = video.videoHeight;

  const iodPx = Math.hypot((left.x - right.x) * W, (left.y - right.y) * H);
  if (iodPx < 1) return false;

  const focalPx = W / (2 * Math.tan((CAMERA_HFOV_DEG * 0.5) * Math.PI / 180));
  const dist = (IOD_METERS * focalPx) / iodPx;

  const cxPx = nose.x * W;
  const cyPx = nose.y * H;
  const dxPx = cxPx - W * 0.5;
  const dyPx = cyPx - H * 0.5;

  let fx = (dxPx * dist) / focalPx;
  const fy = -(dyPx * dist) / focalPx;
  fx = -fx;

  eye.x += EMA * (fx - eye.x);
  eye.y += EMA * (fy - eye.y);
  eye.z += EMA * (dist - eye.z);
  hasFace = true;
  return true;
}

function updateCameraProjection() {
  const ez = Math.max(eye.z, 0.08);
  camera.position.set(eye.x, eye.y, ez);
  camera.quaternion.identity();
  camera.updateMatrixWorld(true);

  const halfW = SCREEN_W * 0.5;
  const halfH = SCREEN_H * 0.5;
  const cy = CAMERA_TO_SCREEN_CENTER_Y;

  let left = -halfW - eye.x;
  let right = halfW - eye.x;
  let top = halfH - cy - eye.y;
  let bottom = -halfH - cy - eye.y;

  let near = ez;
  const s = NEAR_RESCALE / near;
  left *= s; right *= s; top *= s; bottom *= s; near *= s;

  setOffAxisProjection(camera, left, right, bottom, top, near, FAR);
}

function renderFrame() {
  stepFaceTracking();
  updateCameraProjection();
  renderer.render(scene, camera);
  if (hud) {
    const m = hasFace ? '✓' : '…';
    hud.textContent = `${m}  x=${eye.x.toFixed(3)}  y=${eye.y.toFixed(3)}  z=${eye.z.toFixed(3)}`;
  }
  requestAnimationFrame(renderFrame);
}

// ---- Game state
let level = 1;
let foundCount = 0;

function updateCounter() {
  counterEl.textContent = `Level ${level}  •  ${foundCount} / ${HIDERS.length}`;
}

function showToast(text, duration = 1200) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function onCatFound(mesh) {
  if (mesh.userData.found) return;
  mesh.userData.found = true;
  mesh.visible = false;
  foundCount += 1;
  updateCounter();
  if (foundCount >= HIDERS.length) {
    showToast(`Level ${level} geschafft! 🎉`, 1600);
    setTimeout(() => {
      level += 1;
      foundCount = 0;
      spawnCats();
      updateCounter();
    }, 1600);
  } else {
    showToast('Gefunden!');
  }
}

// ---- Tap handler — raycast against cat meshes.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector3();

function handleTap(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
    0.5,
  );
  ndc.unproject(camera);
  raycaster.ray.origin.copy(camera.position);
  raycaster.ray.direction.copy(ndc).sub(camera.position).normalize();
  const liveCats = catMeshes.filter((m) => m.visible && !m.userData.found);
  const hits = raycaster.intersectObjects(liveCats, false);
  if (hits.length > 0) {
    onCatFound(hits[0].object);
  }
}

canvas.addEventListener('pointerdown', (e) => handleTap(e.clientX, e.clientY), { passive: true });

// ---- Start
async function start() {
  startBtn.disabled = true;
  startBtn.textContent = 'Lade…';
  try {
    await initCamera();
    await initFaceLandmarker();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = 'Starten';
    alert('Kamera / Face-Tracking konnte nicht gestartet werden:\n' + (err?.message || err));
    return;
  }
  startEl.style.display = 'none';
  counterEl.classList.remove('hidden');
  hud.classList.remove('hidden');
  spawnCats();
  updateCounter();
  requestAnimationFrame(renderFrame);
}

startBtn.addEventListener('click', start);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) start();
});
