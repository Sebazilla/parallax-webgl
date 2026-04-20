// Fish-tank-VR hidden-object scene.
//
// Everything is 3D: walls, floor, ceiling, shelf, and the 7 GLB items on it.
// No flat background plane — that's what made the previous version feel
// like objects floating in front of a painting.
//
// Camera tracks the user's head via MediaPipe FaceLandmarker and renders
// with off-axis projection so the screen becomes a window into the diorama.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/vision_bundle.mjs';

// ---- Physical geometry (metres).
//
// Screen rectangle lives in the world at z=0, centred on the X axis.
// iPhone 16 Plus portrait: 77 mm × 160 mm. Front camera sits above the
// screen, offset +Y from screen centre by cameraToScreenCenterY.
const SCREEN_W = 0.077;
const SCREEN_H = 0.160;
const CAMERA_TO_SCREEN_CENTER_Y = 0.086;

// Room extends behind the screen (negative Z). Wider and taller than the
// screen so edges stay filled as the head moves.
const ROOM = {
  w: 0.28,   // wall-to-wall X
  h: 0.34,   // floor-to-ceiling Y
  d: 0.34,   // screen-plane to back wall Z (from 0 to -ROOM.d)
};

// Shelf plank jutting out from the back wall.
const SHELF = {
  y: -0.045,           // top surface Y (slightly below screen centre)
  zBack: -ROOM.d + 0.005,
  zFront: -0.08,       // how far toward the viewer the shelf reaches
  thickness: 0.014,
};

// Default head position when face tracking has no data yet.
const DEFAULT_HEAD = new THREE.Vector3(0, 0, 0.35);

// ---- Items. Positions are metres in world-space on the shelf top.
// x: -ROOM.w/2..+ROOM.w/2, z: ~-ROOM.d..SHELF.zFront.
// sizeWorld is target maximum dimension in metres.
const ITEMS = [
  { name: 'chess_queen',      sizeWorld: 0.075, x: -0.095, z: -0.28, rotY:  0.3 },
  { name: 'pocket_watch',     sizeWorld: 0.032, x: -0.035, z: -0.14, rotY:  0.2, rotZ: -0.1 },
  { name: 'plush_mouse',      sizeWorld: 0.045, x:  0.050, z: -0.19, rotY: -0.4 },
  { name: 'skeleton_key',     sizeWorld: 0.060, x:  0.100, z: -0.11, rotY: -0.2, rotZ: -0.2 },
  { name: 'magnifying_glass', sizeWorld: 0.070, x: -0.075, z: -0.12, rotY:  0.3, rotZ:  0.4 },
  { name: 'eyeglasses',       sizeWorld: 0.060, x:  0.010, z: -0.24, rotY:  0.05 },
  { name: 'fountain_pen',     sizeWorld: 0.085, x:  0.090, z: -0.26, rotY:  0.5, rotZ:  0.2 },
];

// ---- DOM
const canvas = document.getElementById('scene');
const startEl = document.getElementById('start');
const startBtn = document.getElementById('startBtn');
const toast = document.getElementById('toast');
const counterEl = document.getElementById('counter');
const video = document.getElementById('cam');

// ---- Three.js boilerplate
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setClearColor(0x0a0806, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x1a140c, 0.5, 1.2);

// Off-axis camera. We override its projection matrix every frame from the
// head position, so fov/aspect/near/far on the constructor are placeholders.
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
camera.rotation.set(0, 0, 0);
camera.matrixAutoUpdate = true;

// ---- Canvas-generated textures
function makeNoiseTexture(baseR, baseG, baseB, amplitude = 12, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * amplitude;
    img.data[i * 4 + 0] = Math.max(0, Math.min(255, baseR + n));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, baseG + n));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, baseB + n));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeWoodTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0.0, '#3d2a1c');
  g.addColorStop(0.3, '#55392a');
  g.addColorStop(0.6, '#4a3222');
  g.addColorStop(1.0, '#5e3d2a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 140; i++) {
    ctx.globalAlpha = 0.08 + Math.random() * 0.12;
    ctx.strokeStyle = Math.random() < 0.5 ? '#2a1a0f' : '#6b4a30';
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    const y = Math.random() * size;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.3, y + (Math.random() - 0.5) * 20,
                       size * 0.7, y + (Math.random() - 0.5) * 20,
                       size, y + (Math.random() - 0.5) * 12);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 60);
  g.addColorStop(0.0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.3)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const TEX = {
  wallBack: makeNoiseTexture(164, 130, 92, 14),
  wallSide: makeNoiseTexture(140, 108, 74, 14),
  ceiling:  makeNoiseTexture(196, 168, 128, 8),
  floor:    makeWoodTexture(),
  shelf:    makeWoodTexture(),
  shadow:   makeShadowTexture(),
};
TEX.floor.repeat.set(2, 3);
TEX.shelf.repeat.set(1, 1);
TEX.wallBack.repeat.set(2, 2);
TEX.wallSide.repeat.set(2, 2);

// ---- Room geometry
function addRoom() {
  const halfW = ROOM.w / 2;
  const halfH = ROOM.h / 2;
  const back   = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.h),
    new THREE.MeshStandardMaterial({ map: TEX.wallBack, roughness: 0.95 }),
  );
  back.position.set(0, 0, -ROOM.d);
  scene.add(back);

  const left = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.d, ROOM.h),
    new THREE.MeshStandardMaterial({ map: TEX.wallSide, roughness: 0.95 }),
  );
  left.position.set(-halfW, 0, -ROOM.d / 2);
  left.rotation.y = Math.PI / 2;
  scene.add(left);

  const right = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.d, ROOM.h),
    new THREE.MeshStandardMaterial({ map: TEX.wallSide, roughness: 0.95 }),
  );
  right.position.set(halfW, 0, -ROOM.d / 2);
  right.rotation.y = -Math.PI / 2;
  scene.add(right);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    new THREE.MeshStandardMaterial({ map: TEX.floor, roughness: 0.9 }),
  );
  floor.position.set(0, -halfH, -ROOM.d / 2);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    new THREE.MeshStandardMaterial({ map: TEX.ceiling, roughness: 0.98 }),
  );
  ceiling.position.set(0, halfH, -ROOM.d / 2);
  ceiling.rotation.x = Math.PI / 2;
  scene.add(ceiling);

  // Painting on back wall: a tiny framed print of Astrid's approved
  // wimmel artwork. Keeps visual continuity with the painted-scene version
  // without being the whole backdrop.
  const paintingTex = new THREE.TextureLoader().load('./assets/wimmel_bg_v3.png');
  paintingTex.colorSpace = THREE.SRGBColorSpace;
  const painting = new THREE.Mesh(
    new THREE.PlaneGeometry(0.07, 0.105),
    new THREE.MeshStandardMaterial({ map: paintingTex, roughness: 0.8 }),
  );
  painting.position.set(-0.05, 0.085, -ROOM.d + 0.001);
  scene.add(painting);
  const paintingFrame = new THREE.Mesh(
    new THREE.PlaneGeometry(0.082, 0.117),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.6 }),
  );
  paintingFrame.position.set(-0.05, 0.085, -ROOM.d + 0.0005);
  scene.add(paintingFrame);

  // Shelf plank.
  const shelfDepth = SHELF.zFront - SHELF.zBack;
  const shelfMesh = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM.w, SHELF.thickness, shelfDepth),
    new THREE.MeshStandardMaterial({ map: TEX.shelf, roughness: 0.7 }),
  );
  shelfMesh.position.set(0, SHELF.y - SHELF.thickness / 2, (SHELF.zFront + SHELF.zBack) / 2);
  scene.add(shelfMesh);

  // Shelf brackets (simple boxes).
  const bracketMat = new THREE.MeshStandardMaterial({ color: 0x2a1d12, roughness: 0.5 });
  for (const x of [-ROOM.w / 2 + 0.02, ROOM.w / 2 - 0.02]) {
    const bracket = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.03, 0.03),
      bracketMat,
    );
    bracket.position.set(x, SHELF.y - SHELF.thickness - 0.015, SHELF.zBack + 0.02);
    scene.add(bracket);
  }
}

addRoom();

// ---- Lighting
// Warm key light from upper-left, like a window or sconce.
scene.add(new THREE.AmbientLight(0xffe8c8, 0.42));

const keyLight = new THREE.DirectionalLight(0xffd88a, 1.3);
keyLight.position.set(-0.3, 0.4, 0.2);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x6a8cb8, 0.35);
fillLight.position.set(0.4, -0.1, 0.3);
scene.add(fillLight);

// Warm point light inside the room as a cozy lamp glow.
const lamp = new THREE.PointLight(0xffa860, 0.35, 0.5, 2.0);
lamp.position.set(-0.11, 0.10, -ROOM.d + 0.06);
scene.add(lamp);

// ---- Items
const itemObjects = [];
const gltfLoader = new GLTFLoader();

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

        // Re-centre X/Z on origin, bottom on y=0 so we can place by floor y.
        root.position.set(-center.x, -box.min.y, -center.z);

        const pivot = new THREE.Group();
        pivot.add(root);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = item.sizeWorld / maxDim;
        pivot.scale.setScalar(scale);

        // Place on shelf top.
        pivot.position.set(item.x, SHELF.y, item.z);
        pivot.rotation.set(item.rotX || 0, item.rotY || 0, item.rotZ || 0);

        // Soft shadow on shelf underneath.
        const shadowR = item.sizeWorld * 0.55;
        const shadow = new THREE.Mesh(
          new THREE.CircleGeometry(shadowR, 32),
          new THREE.MeshBasicMaterial({
            map: TEX.shadow,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.set(item.x, SHELF.y + 0.0005, item.z);
        scene.add(shadow);

        pivot.userData.id = i;
        pivot.userData.name = item.name;
        pivot.userData.found = false;
        pivot.userData.shadow = shadow;
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

// ---- Off-axis projection.
//
// Head (eye) position is in screen-centred world coords. Screen rectangle
// is at z=0 spanning (-SCREEN_W/2, -SCREEN_H/2) to (+SCREEN_W/2, +SCREEN_H/2).
// Camera is placed at head position and faces straight down -Z, but we
// override its projection matrix so the frustum corners map to the screen
// corners.
const headPos = DEFAULT_HEAD.clone();
const smoothedHead = DEFAULT_HEAD.clone();

function updateCameraProjection() {
  const near = 0.02;
  const far = 10.0;
  const ex = smoothedHead.x;
  const ey = smoothedHead.y;
  const ez = Math.max(0.05, smoothedHead.z);

  const halfW = SCREEN_W / 2;
  const halfH = SCREEN_H / 2;

  // Frustum planes at the near plane, scaled from the screen rectangle.
  const left   = (-halfW - ex) * near / ez;
  const right  = ( halfW - ex) * near / ez;
  const bottom = (-halfH - ey) * near / ez;
  const top    = ( halfH - ey) * near / ez;

  camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  camera.position.set(ex, ey, ez);
  camera.updateMatrixWorld();
}

// ---- Face tracking
let faceLandmarker = null;
let videoReady = false;
let lastVideoTime = -1;
let trackingActive = false;

// Assumed horizontal FoV of the front camera (typical wide front cam ≈ 65°
// horizontal). Used for pinhole → metric distance from landmarks.
const CAM_HFOV_DEG = 65;
const HUMAN_IPD_M = 0.063;

async function initFaceTracking() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((res) => {
    video.addEventListener('loadedmetadata', res, { once: true });
  });
  await video.play();
  videoReady = true;

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm',
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
  });
  trackingActive = true;
}

function updateHeadFromFace() {
  if (!faceLandmarker || !videoReady) return;
  const now = performance.now();
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const result = faceLandmarker.detectForVideo(video, now);
  const lm = result?.faceLandmarks?.[0];
  if (!lm || lm.length === 0) return;

  // Landmark indices for outer eye corners: 33 (left), 263 (right).
  const L = lm[33];
  const R = lm[263];
  if (!L || !R) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const lxPx = L.x * vw;
  const lyPx = L.y * vh;
  const rxPx = R.x * vw;
  const ryPx = R.y * vh;

  const eyeMidX = (lxPx + rxPx) / 2;
  const eyeMidY = (lyPx + ryPx) / 2;
  const ipdPx = Math.hypot(rxPx - lxPx, ryPx - lyPx);
  if (ipdPx < 1) return;

  // Pinhole: focal in pixels from assumed hFoV on video width.
  const fPx = (vw / 2) / Math.tan((CAM_HFOV_DEG / 2) * Math.PI / 180);
  const zFromCam = HUMAN_IPD_M * fPx / ipdPx;

  // Front camera mirrors the user, so flip X. Y in image grows downward.
  const xFromCam = -(eyeMidX - vw / 2) * zFromCam / fPx;
  const yFromCam = -(eyeMidY - vh / 2) * zFromCam / fPx;

  // Translate from camera frame to screen-centre frame (front cam is above
  // screen centre by CAMERA_TO_SCREEN_CENTER_Y).
  const xFromScreen = xFromCam;
  const yFromScreen = yFromCam + CAMERA_TO_SCREEN_CENTER_Y;
  const zFromScreen = zFromCam;

  headPos.set(xFromScreen, yFromScreen, zFromScreen);
}

// ---- Resize: keep canvas square-pixel, aspect is handled by off-axis matrix.
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
}
resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

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
  if (root.userData.shadow) root.userData.shadow.visible = false;
  foundCount += 1;
  updateCounter();
  if (foundCount >= ITEMS.length) {
    showToast('Alle gefunden!', 2400);
  } else {
    showToast('Gefunden!');
  }
}

// ---- Tap handler: raycast item groups.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function handleTap(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const live = itemObjects.filter((o) => o.visible && !o.userData.found);
  const hits = raycaster.intersectObjects(live, true);
  if (hits.length > 0) {
    let o = hits[0].object;
    while (o && !itemObjects.includes(o)) o = o.parent;
    if (o) onItemFound(o);
  }
}

canvas.addEventListener('pointerdown', (e) => handleTap(e.clientX, e.clientY), { passive: true });

// ---- Debug keyboard controls: arrow keys move the simulated head on
// desktop (useful when face tracking is off).
const debugKeys = { left: false, right: false, up: false, down: false, near: false, far: false };
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft')  debugKeys.left = true;
  if (e.key === 'ArrowRight') debugKeys.right = true;
  if (e.key === 'ArrowUp')    debugKeys.up = true;
  if (e.key === 'ArrowDown')  debugKeys.down = true;
  if (e.key === 'w')          debugKeys.near = true;
  if (e.key === 's')          debugKeys.far = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft')  debugKeys.left = false;
  if (e.key === 'ArrowRight') debugKeys.right = false;
  if (e.key === 'ArrowUp')    debugKeys.up = false;
  if (e.key === 'ArrowDown')  debugKeys.down = false;
  if (e.key === 'w')          debugKeys.near = false;
  if (e.key === 's')          debugKeys.far = false;
});
window.__setHead = (x, y, z) => { headPos.set(x, y, z); trackingActive = false; };

// ---- Animation loop
function renderFrame() {
  if (trackingActive) {
    updateHeadFromFace();
  } else {
    const step = 0.003;
    if (debugKeys.left)  headPos.x -= step;
    if (debugKeys.right) headPos.x += step;
    if (debugKeys.up)    headPos.y += step;
    if (debugKeys.down)  headPos.y -= step;
    if (debugKeys.near)  headPos.z -= step;
    if (debugKeys.far)   headPos.z += step;
  }
  smoothedHead.lerp(headPos, 0.35);
  updateCameraProjection();
  renderer.render(scene, camera);
  requestAnimationFrame(renderFrame);
}

// ---- Start
async function start() {
  startBtn.disabled = true;
  startBtn.textContent = 'Lade…';
  try {
    await loadItems();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = 'Starten';
    alert('Start fehlgeschlagen:\n' + (err?.message || err));
    return;
  }

  // Face tracking best-effort: if it fails, we still render with default head.
  try {
    await initFaceTracking();
  } catch (err) {
    console.warn('Face tracking unavailable:', err);
  }

  startEl.style.display = 'none';
  counterEl.classList.remove('hidden');
  updateCounter();
  requestAnimationFrame(renderFrame);
}

startBtn.addEventListener('click', start);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) start();
});
