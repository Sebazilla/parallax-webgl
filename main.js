// Head-tracked parallax Wimmelbild "Find the Cat" in the browser.
//
// Flow:
//   tap -> getUserMedia (front camera) -> MediaPipe FaceLandmarker
//   -> face position in camera frame -> off-axis projection -> Three.js render
//
// Coordinate convention (scene space, meters):
//   +X right (user's perspective), +Y up, +Z toward user.
//   Screen plane at z=0, centered at (0, -cameraToScreenCenterY, 0).
//   Diorama content at z < 0.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/vision_bundle.mjs';

// ---- Device geometry (meters) — tuned for iPhone 16 Plus, approx OK for other phones.
const SCREEN_W = 0.077;
const SCREEN_H = 0.160;
const CAMERA_TO_SCREEN_CENTER_Y = 0.086;

// ---- Face tracking defaults
const IOD_METERS = 0.063;
const CAMERA_HFOV_DEG = 70;

// ---- Scene layers (no cats — cats are spawned separately for the game).
// Depths compressed tightly: bg at -0.12, foreground between -0.10 and -0.035.
// BG plane is oversized (2m) so it fills view like a VR skybox at any head angle.
// renderOrder is LAYERS index * 10, so cats can be inserted in the gaps.
const LAYERS = [
  { name: 'wimmel_bg',        h: 2.00,  aspect: 0.67, x:  0.000, y:  0.000, z: -0.120 },
  { name: 'obj_rug',          h: 0.10,  aspect: 1.60, x: -0.010, y: -0.100, z: -0.095 },
  { name: 'obj_wall_clock',   h: 0.07,  aspect: 0.75, x:  0.085, y:  0.030, z: -0.085 },
  { name: 'obj_framed_photo', h: 0.05,  aspect: 1.33, x: -0.085, y:  0.060, z: -0.080 },
  { name: 'obj_floor_lamp',   h: 0.22,  aspect: 0.40, x: -0.075, y:  0.020, z: -0.072 },
  { name: 'obj_plant',        h: 0.09,  aspect: 0.75, x:  0.075, y: -0.045, z: -0.068 },
  { name: 'obj_curtain_left', h: 0.40,  aspect: 0.57, x: -0.055, y:  0.020, z: -0.062 },
  { name: 'curtain_right',    h: 0.40,  aspect: 0.57, x:  0.085, y:  0.020, z: -0.060 },
  { name: 'obj_throw_pillow', h: 0.04,  aspect: 1.00, x:  0.020, y: -0.035, z: -0.052 },
  { name: 'obj_teapot',       h: 0.05,  aspect: 1.00, x: -0.025, y: -0.062, z: -0.048 },
  { name: 'obj_teacup',       h: 0.035, aspect: 1.00, x:  0.015, y: -0.060, z: -0.046 },
  { name: 'obj_books_stack',  h: 0.03,  aspect: 1.20, x: -0.060, y: -0.040, z: -0.044 },
  { name: 'obj_flower_vase',  h: 0.05,  aspect: 0.67, x:  0.060, y: -0.025, z: -0.042 },
  { name: 'obj_candle',       h: 0.05,  aspect: 0.50, x:  0.040, y: -0.058, z: -0.040 },
  { name: 'obj_teddy_bear',   h: 0.07,  aspect: 0.75, x: -0.015, y: -0.048, z: -0.035 },
];

// Build a lookup from layer name -> renderOrder (index * 10).
const LAYER_ORDER = Object.fromEntries(LAYERS.map((L, i) => [L.name, i * 10]));

// ---- Hidden cats: positioned behind a specific foreground layer.
// Each cat is placed at a depth between the BG and its hiding layer; its
// renderOrder is just BELOW the hiding layer's renderOrder so the layer
// paints over it. Parallax slides cat out from behind the object.
const CAT_SIZE_H = 0.045;        // ~4.5cm tall — small enough to be hideable
const CATS_TEMPLATE = [
  // Behind floor lamp (tall skinny shade) — cat peeks out at the side
  { x: -0.080, y: -0.020, z: -0.080, hideLayer: 'obj_floor_lamp' },
  // Behind plant foliage — cat peeks out beside the pot
  { x:  0.075, y: -0.040, z: -0.075, hideLayer: 'obj_plant' },
  // Behind curtain_left folds
  { x: -0.060, y: -0.040, z: -0.070, hideLayer: 'obj_curtain_left' },
  // Behind curtain_right folds
  { x:  0.085, y:  0.005, z: -0.068, hideLayer: 'curtain_right' },
  // Behind teddy bear — hardest to find
  { x: -0.015, y: -0.058, z: -0.050, hideLayer: 'obj_teddy_bear' },
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
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}

const scene = new THREE.Scene();
const camera = new THREE.Camera();
camera.matrixAutoUpdate = true;

const loader = new THREE.TextureLoader();

function makeLayer({ name, h, aspect, x, y, z }, renderOrder, writesDepth = false) {
  const geom = new THREE.PlaneGeometry(h * aspect, h);
  const tex = loader.load(`./assets/${name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
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

// Build scene layers.
for (let i = 0; i < LAYERS.length; i++) {
  scene.add(makeLayer(LAYERS[i], i * 10, /* writesDepth */ i === 0));
}

// ---- Cat spawning
let catMeshes = [];
function spawnCats() {
  // Clear old cats.
  for (const m of catMeshes) {
    scene.remove(m);
    m.material.map?.dispose();
    m.material.dispose();
    m.geometry.dispose();
  }
  catMeshes = [];

  for (let i = 0; i < CATS_TEMPLATE.length; i++) {
    const t = CATS_TEMPLATE[i];
    const hideOrder = LAYER_ORDER[t.hideLayer];
    const mesh = makeLayer(
      { name: 'cat', h: CAT_SIZE_H, aspect: 1.0, x: t.x, y: t.y, z: t.z },
      hideOrder - 1, // just behind the layer that hides it
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

// ---- Face tracking state
let faceLandmarker = null;
let hasFace = false;
const eye = { x: 0, y: 0, z: 0.45 };
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
  const ez = Math.max(eye.z, 0.05);
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
  counterEl.textContent = `Level ${level}  •  ${foundCount} / ${CATS_TEMPLATE.length}`;
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
  // Hide the cat with a small pop.
  mesh.visible = false;
  foundCount += 1;
  updateCounter();
  if (foundCount >= CATS_TEMPLATE.length) {
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
  // Unproject NDC -> world using the custom projection.
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
