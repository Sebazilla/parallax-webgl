// Head-tracked parallax Wimmelbild in the browser.
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
// Vertical distance from camera lens DOWN to screen center.
const CAMERA_TO_SCREEN_CENTER_Y = 0.086;

// ---- Face tracking defaults
// Average adult inter-ocular distance (pupil to pupil).
const IOD_METERS = 0.063;
// iPhone front camera horizontal FOV ~70°.
const CAMERA_HFOV_DEG = 70;

// ---- Parallax layer descriptors. Order = back to front.
// heightMeters = physical height of the layer plane in scene space.
// x, y = offset from SCREEN CENTER (not scene origin).
// z = depth (negative = behind screen). Range compressed for subtler parallax.
// Cat sits as second-to-last layer; teddy_bear is closest.
const LAYERS = [
  { name: 'wimmel_bg',        h: 0.80,  aspect: 0.67, x:  0.000, y:  0.000, z: -0.28 },
  { name: 'obj_rug',          h: 0.03,  aspect: 1.60, x: -0.010, y: -0.058, z: -0.25 },
  { name: 'obj_wall_clock',   h: 0.05,  aspect: 0.75, x:  0.085, y:  0.012, z: -0.24 },
  { name: 'obj_framed_photo', h: 0.03,  aspect: 1.33, x: -0.085, y:  0.045, z: -0.23 },
  { name: 'obj_curtain_left', h: 0.28,  aspect: 0.57, x: -0.080, y:  0.010, z: -0.21 },
  { name: 'curtain_right',    h: 0.28,  aspect: 0.57, x:  0.080, y:  0.010, z: -0.20 },
  { name: 'obj_floor_lamp',   h: 0.16,  aspect: 0.40, x: -0.060, y:  0.000, z: -0.18 },
  { name: 'obj_plant',        h: 0.06,  aspect: 0.75, x:  0.070, y: -0.040, z: -0.15 },
  { name: 'obj_throw_pillow', h: 0.03,  aspect: 1.00, x:  0.020, y: -0.028, z: -0.12 },
  { name: 'obj_teapot',       h: 0.04,  aspect: 1.00, x: -0.020, y: -0.052, z: -0.11 },
  { name: 'obj_teacup',       h: 0.025, aspect: 1.00, x:  0.010, y: -0.050, z: -0.10 },
  { name: 'obj_books_stack',  h: 0.025, aspect: 1.20, x: -0.050, y: -0.030, z: -0.09 },
  { name: 'obj_flower_vase',  h: 0.04,  aspect: 0.67, x:  0.050, y: -0.020, z: -0.08 },
  { name: 'obj_candle',       h: 0.04,  aspect: 0.50, x:  0.030, y: -0.050, z: -0.07 },
  { name: 'cat',              h: 0.08,  aspect: 1.00, x:  0.000, y: -0.050, z: -0.06 },
  { name: 'obj_teddy_bear',   h: 0.06,  aspect: 0.75, x: -0.010, y: -0.040, z: -0.05 },
];

const FAR = 10.0;
const NEAR_RESCALE = 0.01; // 1 cm — numerical-stability trick from the Unity reference.

// ---- DOM
const canvas = document.getElementById('scene');
const video = document.getElementById('cam');
const startEl = document.getElementById('start');
const startBtn = document.getElementById('startBtn');
const hud = document.getElementById('hud');

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

// Off-axis camera: base THREE.Camera so Three.js doesn't overwrite our projection.
const camera = new THREE.Camera();
camera.matrixAutoUpdate = true;

// Build parallax layer meshes.
const loader = new THREE.TextureLoader();
const layerMeshes = [];
for (let i = 0; i < LAYERS.length; i++) {
  const L = LAYERS[i];
  const geom = new THREE.PlaneGeometry(L.h * L.aspect, L.h);
  const tex = loader.load(`./assets/${L.name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: i === 0, // only background writes depth
    depthTest: true,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(L.x, -CAMERA_TO_SCREEN_CENTER_Y + L.y, L.z);
  mesh.renderOrder = i;
  scene.add(mesh);
  layerMeshes.push(mesh);
}

// ---- Off-axis projection matrix (row-major for THREE.Matrix4.set()).
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
// Smoothed eye position in scene space (meters). Start at a comfortable default.
const eye = { x: 0, y: 0, z: 0.45 };
const EMA = 0.35; // smoothing factor: new sample weight

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
  // Wait until dimensions are available.
  if (video.videoWidth === 0) {
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
}

// Update smoothed `eye` from newest landmarks. Returns true if a face was found.
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

  // Landmarks: 1 = nose tip; 33 = right-eye outer corner; 263 = left-eye outer corner.
  // MediaPipe normalises (x, y) to [0, 1] in image space. z is relative depth (not useful for
  // metric distance).
  const nose = lm[1];
  const right = lm[33];
  const left = lm[263];
  const W = video.videoWidth;
  const H = video.videoHeight;

  // Inter-ocular distance in pixels (use 2D, since z is not metric).
  const iodPx = Math.hypot((left.x - right.x) * W, (left.y - right.y) * H);
  if (iodPx < 1) return false;

  // Focal length estimate from horizontal FOV.
  const focalPx = W / (2 * Math.tan((CAMERA_HFOV_DEG * 0.5) * Math.PI / 180));

  // Distance from camera to face.
  const dist = (IOD_METERS * focalPx) / iodPx;

  // Face centre in image coords (pixels, origin at image top-left).
  const cxPx = nose.x * W;
  const cyPx = nose.y * H;

  // Offset from image centre.
  const dxPx = cxPx - W * 0.5;
  const dyPx = cyPx - H * 0.5;

  // Back-project to metric offsets at the face plane.
  let fx = (dxPx * dist) / focalPx;
  const fy = -(dyPx * dist) / focalPx;   // image Y points down; flip so up is positive
  // Front camera stream is mirrored relative to the user, so invert X.
  fx = -fx;

  // Low-pass smoothing.
  eye.x += EMA * (fx - eye.x);
  eye.y += EMA * (fy - eye.y);
  eye.z += EMA * (dist - eye.z);
  hasFace = true;
  return true;
}

function updateCameraProjection() {
  // Clamp ez so the near plane is sane if the user gets super close.
  const ez = Math.max(eye.z, 0.05);

  // Position the camera at the eye.
  camera.position.set(eye.x, eye.y, ez);
  camera.quaternion.identity();
  camera.updateMatrixWorld(true);

  // Asymmetric frustum: the screen is the near plane for projection.
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
  hud.classList.remove('hidden');
  requestAnimationFrame(renderFrame);
}

startBtn.addEventListener('click', start);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) start();
});
