// Head-tracked 3D Wimmelbild "Find the Items" in the browser.
//
// Astrid's pivot: items are true 3D meshes (GLB) so they actually rotate as the
// head moves — no more floating-sticker feel. BG is a flat painted backdrop.
// 7 items, tap to mark found.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.162.0/examples/jsm/loaders/GLTFLoader.js';
import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/vision_bundle.mjs';

// ---- Device geometry (meters). iPhone 16 Plus front camera above screen.
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
// BG: flat painted backdrop far back, fills the view.
const BG = { name: 'wimmel_bg_v3', h: 0.38, aspect: 1024 / 1536, z: -0.28 };

// Items: 3D GLB meshes in front of BG. size = world-space longest-axis length.
// Spread across scene and across depth so head movement reveals different sides.
const ITEMS = [
  { name: 'pocket_watch',     size: 0.032, x: -0.022, y: -0.018, z: -0.14, rotY:  0.3 },
  { name: 'skeleton_key',     size: 0.040, x:  0.020, y:  0.010, z: -0.17, rotY: -0.4, rotZ: -0.3 },
  { name: 'magnifying_glass', size: 0.050, x:  0.038, y: -0.045, z: -0.12, rotY:  0.5, rotZ: 0.4 },
  { name: 'eyeglasses',       size: 0.044, x: -0.032, y: -0.060, z: -0.13, rotY:  0.1, rotZ: -0.1 },
  { name: 'chess_queen',      size: 0.042, x: -0.045, y:  0.030, z: -0.16, rotY: -0.2 },
  { name: 'fountain_pen',     size: 0.048, x:  0.005, y:  0.055, z: -0.19, rotY:  0.6, rotZ: 0.4 },
  { name: 'plush_mouse',      size: 0.034, x:  0.028, y: -0.070, z: -0.10, rotY: -0.5 },
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
renderer.outputColorSpace = THREE.SRGBColorSpace;
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

// Lighting for 3D items. Warm key from upper-right matches BG evening mood.
scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const keyLight = new THREE.DirectionalLight(0xfff0cc, 1.1);
keyLight.position.set(0.2, 0.3, 0.4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x9ac0ff, 0.35);
fillLight.position.set(-0.3, 0.1, 0.3);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.25);
rimLight.position.set(0, 0, -0.4);
scene.add(rimLight);

const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

// ---- BG plane
function addBackground() {
  const geom = new THREE.PlaneGeometry(BG.h * BG.aspect, BG.h);
  const tex = texLoader.load(`./assets/${BG.name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshBasicMaterial({ map: tex, depthWrite: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(0, -CAMERA_TO_SCREEN_CENTER_Y, BG.z);
  mesh.renderOrder = 0;
  scene.add(mesh);
}

addBackground();

// ---- Items
const itemObjects = [];

async function loadItems() {
  const promises = ITEMS.map((item, i) => new Promise((resolve, reject) => {
    gltfLoader.load(
      `./assets/items/${item.name}.glb`,
      (gltf) => {
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);
        root.position.sub(center);

        const pivot = new THREE.Group();
        pivot.add(root);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = item.size / maxDim;
        pivot.scale.setScalar(scale);
        pivot.position.set(item.x, -CAMERA_TO_SCREEN_CENTER_Y + item.y, item.z);
        pivot.rotation.set(item.rotX || 0, item.rotY || 0, item.rotZ || 0);
        pivot.userData.id = i;
        pivot.userData.name = item.name;
        pivot.userData.found = false;
        pivot.renderOrder = 10;
        scene.add(pivot);
        itemObjects.push(pivot);
        resolve();
      },
      undefined,
      reject,
    );
  }));
  await Promise.all(promises);
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
let foundCount = 0;

function updateCounter() {
  counterEl.textContent = `${foundCount} / ${ITEMS.length}`;
}

function showToast(text, duration = 1200) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function onItemFound(root) {
  if (root.userData.found) return;
  root.userData.found = true;
  root.visible = false;
  foundCount += 1;
  updateCounter();
  if (foundCount >= ITEMS.length) {
    showToast('Alle gefunden!', 2400);
  } else {
    showToast('Gefunden!');
  }
}

// ---- Tap handler: raycast against 3D item groups.
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
  const live = itemObjects.filter((o) => o.visible && !o.userData.found);
  const hits = raycaster.intersectObjects(live, true);
  if (hits.length > 0) {
    let o = hits[0].object;
    while (o && !itemObjects.includes(o)) o = o.parent;
    if (o) onItemFound(o);
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
    await loadItems();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = 'Starten';
    alert('Start fehlgeschlagen:\n' + (err?.message || err));
    return;
  }
  startEl.style.display = 'none';
  counterEl.classList.remove('hidden');
  hud.classList.remove('hidden');
  updateCounter();
  requestAnimationFrame(renderFrame);
}

startBtn.addEventListener('click', start);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) start();
});
