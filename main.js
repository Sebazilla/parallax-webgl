// Head-tracked parallax Wimmelbild "Find the Cat" in the browser.
//
// Hiding mechanic:
//   Each hider has a known OPAQUE SILHOUETTE inside its PNG (bbox of alpha>128).
//   The cat is placed at the silhouette's CENTER IN WORLD SPACE, at deeper z.
//   Hiders sit very close to the screen plane; cats sit far behind.
//   This makes the cat barely parallax-shift while the hider barely moves,
//   so the cat peeks out from behind the silhouette edges as the user tilts their head.

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

// ---- Face tracking defaults
const IOD_METERS = 0.063;
const CAMERA_HFOV_DEG = 70;

// ---- Scene composition.
// BG sits far back, so tilting the head pans it like a VR window.
// Hiders sit very close to the screen plane (z ≈ -0.015) — they stay nearly
// fixed on screen as the head moves. Cats sit behind them (z ≈ -0.15), so they
// parallax-shift more and peek out around the hider silhouettes.
const BG = { name: 'wimmel_bg', h: 0.380, aspect: 0.67, x: 0, y: 0.005, z: -0.200 };

// Each hider has:
//   name, h, aspect → geometry size (meters).
//   x, y           → mesh center in world (relative to screen center Y).
//   z              → depth.
//   mirror         → flip U (texture) so opaque silhouette appears on opposite side.
//   silX, silY     → opaque-silhouette centre in PNG coords, 0..1 (as seen by user,
//                    i.e. AFTER mirroring if mirror is true).
// Cat for this hider is placed at:
//   cat.x = hider.x + (silX - 0.5) * (h * aspect)
//   cat.y = hider.y + (0.5 - silY) * h
const HIDER_Z = -0.015;
const CAT_Z   = -0.150;
const CAT_H   = 0.038;   // visible cat height
const HIDERS = [
  // curtain_left (as-is) — fabric on left half of PNG
  { name: 'obj_curtain_left', h: 0.210, aspect: 0.40, x: -0.042, y: 0.020, z: HIDER_Z,
    mirror: false, silX: 0.27, silY: 0.46 },
  // curtain_right (source PNG has fabric on left too — mirror it so fabric is on right)
  { name: 'curtain_right',    h: 0.210, aspect: 0.40, x:  0.042, y: 0.020, z: HIDER_Z,
    mirror: true,  silX: 0.72, silY: 0.43 },
  // teddy bear — compact plush, opaque in the body/head area
  { name: 'obj_teddy_bear',   h: 0.075, aspect: 0.75, x:  0.000, y: -0.060, z: HIDER_Z - 0.003,
    mirror: false, silX: 0.58, silY: 0.68 },
  // books stack — wide, blocky
  { name: 'obj_books_stack',  h: 0.055, aspect: 1.20, x: -0.028, y: -0.010, z: HIDER_Z - 0.005,
    mirror: false, silX: 0.53, silY: 0.48 },
  // throw pillow — round, fills well
  { name: 'obj_throw_pillow', h: 0.065, aspect: 1.00, x:  0.030, y: -0.030, z: HIDER_Z - 0.008,
    mirror: false, silX: 0.50, silY: 0.60 },
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

// BG at renderOrder 0, writes depth.
const bgMesh = makeLayer(BG, 0, /* writesDepth */ true);
scene.add(bgMesh);

// Cats render at 10, Hiders at 20. Hiders always paint on top of cats.
for (const h of HIDERS) {
  scene.add(makeLayer(h, 20, false));
}

// ---- Cat spawning (re-callable for next level)
let catMeshes = [];
function spawnCats() {
  for (const m of catMeshes) {
    scene.remove(m);
    m.material.map?.dispose();
    m.material.dispose();
    m.geometry.dispose();
  }
  catMeshes = [];

  for (let i = 0; i < HIDERS.length; i++) {
    const h = HIDERS[i];
    // World position of hider's opaque silhouette centre, projected onto the cat's z-plane.
    // We anchor cat at the silhouette centre in hider's plane, then place deeper.
    // Because the cat is deeper, when the user is on-axis the cat visually shifts toward
    // the origin (x=0) relative to its world x. We compensate by placing the cat slightly
    // further from centre so its on-screen position at rest aligns with the silhouette.
    const mesh_w = h.h * h.aspect;
    const mesh_h = h.h;
    const silOffX = (h.silX - 0.5) * mesh_w;
    const silOffY = (0.5 - h.silY) * mesh_h;

    // On-screen x of the silhouette (at eye=(0,0,0.30)):
    //   screen_x = (hider.x + silOffX) * 0.30 / (0.30 - hider.z)
    // On-screen x of cat:
    //   screen_x_cat = cat.x * 0.30 / (0.30 - cat.z)
    // Solve for cat.x so they match at rest (eye.x=0, eye.y=0, ez=0.30):
    const ez = 0.30;
    const zRatioHider = ez / (ez - h.z);
    const zRatioCat   = ez / (ez - CAT_Z);
    const screenX = (h.x + silOffX) * zRatioHider;
    const screenY = (-CAMERA_TO_SCREEN_CENTER_Y + h.y + silOffY) * zRatioHider;
    const catWorldX = screenX / zRatioCat;
    const catWorldY = screenY / zRatioCat;
    const catLocalY = catWorldY + CAMERA_TO_SCREEN_CENTER_Y;

    const mesh = makeLayer(
      {
        name: 'cat',
        h: CAT_H,
        aspect: 1.0,
        x: catWorldX,
        y: catLocalY,
        z: CAT_Z,
      },
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

// ---- Face tracking state
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
