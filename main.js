// Fish-tank-VR hidden-object scene.
//
// Camera tracks the user's head via MediaPipe FaceLandmarker and renders
// with off-axis projection so the screen acts as a window into a real
// 3D room. The room is populated with many 3D fixtures (side table,
// lamp, books, plant, sconce, rug) so when the camera moves the fixtures
// parallax naturally and the 7 hidden items feel like they sit IN the
// room, not floating in front of a painting.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/vision_bundle.mjs';

// ---- Physical geometry (metres).
// iPhone 16 Plus portrait: 77 × 160 mm, front cam offset +86 mm from screen
// centre. These values drift slightly across iPhone models but the illusion
// is robust within ±10 % error.
const SCREEN_W = 0.077;
const SCREEN_H = 0.160;
const CAMERA_TO_SCREEN_CENTER_Y = 0.086;

// World room. Larger than screen so walls stay off-screen edges during head
// movement. Scale is roughly "doll house" — 60 cm wide, 50 cm tall, 60 cm
// deep — which reads as a believable small room from arm's length.
const ROOM = {
  w: 0.60,
  h: 0.50,
  d: 0.60,
};

// Wall-mounted shelf at back wall.
const SHELF = {
  y: 0.02,
  zBack: -ROOM.d + 0.005,
  zFront: -ROOM.d + 0.11,
  thickness: 0.014,
};

// Side table in the room.
const TABLE = {
  w: 0.18,
  h: 0.18,          // height above floor
  d: 0.14,
  x: 0.18,          // right side
  z: -ROOM.d + 0.16,
  legThickness: 0.012,
};
const TABLE_TOP_Y = -ROOM.h / 2 + TABLE.h;

// Default viewer position (fallback when face tracking off).
const DEFAULT_HEAD = new THREE.Vector3(0, 0, 0.35);

// Parallax gain. Damps head motion relative to the raw MediaPipe estimate
// so objects don't fly when the pinhole model overshoots. Override via
// ?gain=0.8 in the URL.
const GAIN = Math.max(0.0, Math.min(2.0,
  parseFloat(new URLSearchParams(location.search).get('gain') || '0.5')));

// ---- Items. Each is placed on a real surface in the room.
// surface: 'shelf' | 'table' | 'floor' | 'books' | 'rug'
const ITEMS = [
  { name: 'chess_queen',      sizeWorld: 0.08, surface: 'table', x:  0.00, z:  0.00, rotY:  0.3 },
  { name: 'pocket_watch',     sizeWorld: 0.04, surface: 'shelf', x: -0.10, z:  0.03, rotY:  0.2, rotZ: -0.1 },
  { name: 'plush_mouse',      sizeWorld: 0.07, surface: 'rug',   x: -0.08, z: -0.38, rotY: -0.4 },
  { name: 'skeleton_key',     sizeWorld: 0.08, surface: 'shelf', x:  0.08, z:  0.02, rotY: -0.2, rotZ: -0.2 },
  { name: 'magnifying_glass', sizeWorld: 0.09, surface: 'rug',   x:  0.11, z: -0.20, rotY:  0.3, rotZ:  0.4 },
  { name: 'eyeglasses',       sizeWorld: 0.08, surface: 'table', x: -0.05, z:  0.03, rotY:  0.05 },
  { name: 'fountain_pen',     sizeWorld: 0.12, surface: 'books', x:  0.00, z:  0.00, rotY:  0.5, rotZ:  0.6 },
];

// ---- DOM
const canvas     = document.getElementById('scene');
const startEl    = document.getElementById('start');
const startBtn   = document.getElementById('startBtn');
const toast      = document.getElementById('toast');
const counterEl  = document.getElementById('counter');
const video      = document.getElementById('cam');
const hudEl      = document.getElementById('hud');

// ---- Three.js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setClearColor(0x0a0806, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 20);
camera.rotation.set(0, 0, 0);

// ---- Procedural textures
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

function makeRugTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8a4a3a';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = i % 4 < 2 ? '#6e3a2e' : '#a55a48';
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 2 + Math.random() * 3;
    ctx.beginPath();
    ctx.moveTo(0, i * size / 60);
    ctx.lineTo(size, i * size / 60);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#c4856a';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, size - 24, size - 24);
  ctx.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeBookSpineTexture(color, title = '') {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 256);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, 4, 256);
  ctx.fillRect(60, 0, 4, 256);
  ctx.fillStyle = '#d4a45a';
  ctx.fillRect(14, 40, 36, 4);
  ctx.fillRect(14, 212, 36, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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
  rug:      makeRugTexture(),
  shadow:   makeShadowTexture(),
};
TEX.floor.repeat.set(3, 3);
TEX.wallBack.repeat.set(3, 3);
TEX.wallSide.repeat.set(3, 3);

// ---- Materials
const matWoodDark = new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.6 });
const matBrass    = new THREE.MeshStandardMaterial({ color: 0xb08b4a, metalness: 0.8, roughness: 0.35 });
const matCreamShade = new THREE.MeshStandardMaterial({ color: 0xf4e4b8, roughness: 0.9, emissive: 0x402a10, emissiveIntensity: 0.35 });
const matTerracotta = new THREE.MeshStandardMaterial({ color: 0xa2553a, roughness: 0.85 });
const matLeaf     = new THREE.MeshStandardMaterial({ color: 0x4a6e3a, roughness: 0.8 });

// ---- Room geometry
const halfW = ROOM.w / 2;
const halfH = ROOM.h / 2;

function buildRoom() {
  // Walls as inward-facing planes.
  const back = new THREE.Mesh(
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

  // Crown molding at ceiling — thin bars of box geometry. Gives strong
  // parallax cue on the ceiling corner.
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x6e4a2a, roughness: 0.6 });
  for (const [w, h, d, x, y, z] of [
    [ROOM.w, 0.012, 0.012, 0, halfH - 0.006, -ROOM.d + 0.006],
    [0.012, 0.012, ROOM.d, -halfW + 0.006, halfH - 0.006, -ROOM.d / 2],
    [0.012, 0.012, ROOM.d,  halfW - 0.006, halfH - 0.006, -ROOM.d / 2],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), crownMat);
    m.position.set(x, y, z);
    scene.add(m);
  }
  // Floor skirting.
  for (const [w, h, d, x, y, z] of [
    [ROOM.w, 0.018, 0.012, 0, -halfH + 0.009, -ROOM.d + 0.006],
    [0.012, 0.018, ROOM.d, -halfW + 0.006, -halfH + 0.009, -ROOM.d / 2],
    [0.012, 0.018, ROOM.d,  halfW - 0.006, -halfH + 0.009, -ROOM.d / 2],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), crownMat);
    m.position.set(x, y, z);
    scene.add(m);
  }
}

function buildShelf() {
  const shelfDepth = SHELF.zFront - SHELF.zBack;
  const shelfMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, SHELF.thickness, shelfDepth),
    new THREE.MeshStandardMaterial({ map: TEX.shelf, roughness: 0.7 }),
  );
  shelfMesh.position.set(-0.08, SHELF.y - SHELF.thickness / 2, (SHELF.zFront + SHELF.zBack) / 2);
  scene.add(shelfMesh);

  // Small brackets.
  for (const x of [-0.23, 0.07]) {
    const bracket = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.035, 0.035),
      new THREE.MeshStandardMaterial({ color: 0x2a1d12 }),
    );
    bracket.position.set(x, SHELF.y - SHELF.thickness - 0.018, SHELF.zBack + 0.025);
    scene.add(bracket);
  }
}

function buildSideTable() {
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.w, 0.012, TABLE.d),
    matWoodDark,
  );
  top.position.set(TABLE.x, TABLE_TOP_Y, TABLE.z);
  scene.add(top);

  const legMat = new THREE.MeshStandardMaterial({ color: 0x3a2614, roughness: 0.55 });
  const legH = TABLE.h - 0.012;
  const lx = TABLE.w / 2 - TABLE.legThickness;
  const lz = TABLE.d / 2 - TABLE.legThickness;
  for (const [dx, dz] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]]) {
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.legThickness, legH, TABLE.legThickness),
      legMat,
    );
    leg.position.set(TABLE.x + dx, -halfH + legH / 2, TABLE.z + dz);
    scene.add(leg);
  }
}

function buildLamp() {
  // On the table. Base + pole + shade.
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.032, 0.012, 24),
    matBrass,
  );
  base.position.set(TABLE.x - 0.04, TABLE_TOP_Y + 0.012, TABLE.z - 0.02);
  scene.add(base);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.004, 0.004, 0.1, 16),
    matBrass,
  );
  pole.position.set(TABLE.x - 0.04, TABLE_TOP_Y + 0.012 + 0.05, TABLE.z - 0.02);
  scene.add(pole);

  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.04, 0.055, 32, 1, true),
    matCreamShade,
  );
  shade.position.set(TABLE.x - 0.04, TABLE_TOP_Y + 0.013 + 0.1 + 0.028, TABLE.z - 0.02);
  scene.add(shade);

  // Light inside the shade.
  const bulb = new THREE.PointLight(0xffcf7a, 0.8, 0.5, 1.8);
  bulb.position.set(TABLE.x - 0.04, TABLE_TOP_Y + 0.14, TABLE.z - 0.02);
  scene.add(bulb);
}

function buildBooks() {
  // Stack of books in corner of the shelf.
  const colors = ['#7a2e2a', '#2e4a7a', '#4a7a2e', '#7a5a2e', '#5a2e7a'];
  let yCursor = SHELF.y;
  const stackX = -0.20;
  const stackZ = (SHELF.zFront + SHELF.zBack) / 2 - 0.01;
  for (let i = 0; i < 5; i++) {
    const bw = 0.05 + Math.random() * 0.02;
    const bh = 0.015 + Math.random() * 0.006;
    const bd = 0.07;
    const tex = makeBookSpineTexture(colors[i]);
    const book = new THREE.Mesh(
      new THREE.BoxGeometry(bw, bh, bd),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }),
    );
    book.position.set(stackX + (Math.random() - 0.5) * 0.006, yCursor + bh / 2, stackZ);
    book.rotation.y = (Math.random() - 0.5) * 0.08;
    scene.add(book);
    yCursor += bh;
  }
  // Expose top of book stack so items can be placed on it.
  return { topY: yCursor, x: stackX, z: stackZ };
}

function buildPlant() {
  const potH = 0.055;
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038, 0.028, potH, 24),
    matTerracotta,
  );
  pot.position.set(-0.22, -halfH + potH / 2, -0.22);
  scene.add(pot);

  // Foliage: 3 overlapping spheres of leaves.
  for (const [dx, dy, dz, r] of [[0, 0.04, 0, 0.06], [0.03, 0.07, 0.01, 0.04], [-0.025, 0.065, -0.015, 0.045]]) {
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(r, 12, 10),
      matLeaf,
    );
    leaf.position.set(-0.22 + dx, -halfH + potH + dy, -0.22 + dz);
    scene.add(leaf);
  }
}

function buildPainting() {
  // Small framed wimmel print on back wall, slightly off-centre left.
  const paintingTex = new THREE.TextureLoader().load('./assets/wimmel_bg_v3.png');
  paintingTex.colorSpace = THREE.SRGBColorSpace;
  const frameDepth = 0.012;
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.16, frameDepth),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.6 }),
  );
  frame.position.set(-0.13, 0.12, -ROOM.d + frameDepth / 2);
  scene.add(frame);
  const canvasMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.095, 0.145),
    new THREE.MeshStandardMaterial({ map: paintingTex, roughness: 0.8 }),
  );
  canvasMesh.position.set(-0.13, 0.12, -ROOM.d + frameDepth + 0.001);
  scene.add(canvasMesh);
}

function buildRug() {
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(0.38, 0.26),
    new THREE.MeshStandardMaterial({ map: TEX.rug, roughness: 0.95 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.02, -halfH + 0.0005, -0.28);
  scene.add(rug);
}

function buildSconce() {
  // Wall-mounted round sconce on right wall for visual punctuation.
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.006, 0.04, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x2a1d12 }),
  );
  back.position.set(halfW - 0.003, 0.12, -ROOM.d + 0.15);
  scene.add(back);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 16, 12),
    matCreamShade,
  );
  bulb.position.set(halfW - 0.025, 0.12, -ROOM.d + 0.15);
  scene.add(bulb);
  const sconceLight = new THREE.PointLight(0xffcf7a, 0.5, 0.35, 1.8);
  sconceLight.position.set(halfW - 0.03, 0.12, -ROOM.d + 0.15);
  scene.add(sconceLight);
}

buildRoom();
buildShelf();
buildSideTable();
buildLamp();
const BOOKS = buildBooks();
buildPlant();
buildPainting();
buildRug();
buildSconce();

// ---- Lighting
scene.add(new THREE.AmbientLight(0xffe8c8, 0.35));

const keyLight = new THREE.DirectionalLight(0xffd88a, 0.9);
keyLight.position.set(-0.3, 0.4, 0.2);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x6a8cb8, 0.25);
fillLight.position.set(0.4, -0.1, 0.3);
scene.add(fillLight);

// ---- Items
const itemObjects = [];
const gltfLoader = new GLTFLoader();

function surfaceOrigin(surface, x, z) {
  switch (surface) {
    case 'shelf': return { x, y: SHELF.y, z: (SHELF.zFront + SHELF.zBack) / 2 + z };
    case 'table': return { x: TABLE.x + x, y: TABLE_TOP_Y, z: TABLE.z + z };
    case 'rug':   return { x, y: -halfH + 0.001, z };
    case 'books': return { x: BOOKS.x, y: BOOKS.topY, z: BOOKS.z };
    default:      return { x, y: 0, z };
  }
}

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
        root.position.set(-center.x, -box.min.y, -center.z);

        const pivot = new THREE.Group();
        pivot.add(root);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        pivot.scale.setScalar(item.sizeWorld / maxDim);

        const pos = surfaceOrigin(item.surface, item.x, item.z);
        pivot.position.set(pos.x, pos.y, pos.z);
        pivot.rotation.set(item.rotX || 0, item.rotY || 0, item.rotZ || 0);

        // Contact shadow pad on the surface.
        const shadowR = item.sizeWorld * 0.55;
        const shadow = new THREE.Mesh(
          new THREE.CircleGeometry(shadowR, 32),
          new THREE.MeshBasicMaterial({
            map: TEX.shadow,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
          }),
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.set(pos.x, pos.y + 0.0006, pos.z);
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

// ---- Off-axis projection
const headPos = DEFAULT_HEAD.clone();
const smoothedHead = DEFAULT_HEAD.clone();

function updateCameraProjection() {
  const near = 0.02;
  const far  = 20.0;
  const ex = smoothedHead.x;
  const ey = smoothedHead.y;
  const ez = Math.max(0.05, smoothedHead.z);

  const sw = SCREEN_W / 2;
  const sh = SCREEN_H / 2;

  const left   = (-sw - ex) * near / ez;
  const right  = ( sw - ex) * near / ez;
  const bottom = (-sh - ey) * near / ez;
  const top    = ( sh - ey) * near / ez;

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
let trackingError = '';

const CAM_HFOV_DEG = 65;
const HUMAN_IPD_M = 0.063;

async function initFaceTracking() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no getUserMedia');
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

  const fPx = (vw / 2) / Math.tan((CAM_HFOV_DEG / 2) * Math.PI / 180);
  const zFromCam = HUMAN_IPD_M * fPx / ipdPx;

  const xFromCam = -(eyeMidX - vw / 2) * zFromCam / fPx;
  const yFromCam = -(eyeMidY - vh / 2) * zFromCam / fPx;

  const xFromScreen = xFromCam * GAIN;
  const yFromScreen = (yFromCam + CAMERA_TO_SCREEN_CENTER_Y) * GAIN;

  headPos.set(xFromScreen, yFromScreen, zFromCam);
}

// ---- HUD
function updateHud() {
  if (!hudEl) return;
  const tracking = trackingActive ? 'AN' : (trackingError ? `FEHLER: ${trackingError}` : 'aus');
  const h = smoothedHead;
  hudEl.textContent = `Kamera: ${tracking}  x=${h.x.toFixed(3)} y=${h.y.toFixed(3)} z=${h.z.toFixed(3)}  gain=${GAIN}`;
}

// ---- Resize
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ---- Game
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
  showToast(foundCount >= ITEMS.length ? 'Alle gefunden!' : 'Gefunden!',
            foundCount >= ITEMS.length ? 2400 : 1200);
}

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

// Debug keyboard (desktop).
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

// ---- Loop
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
  smoothedHead.lerp(headPos, 0.18);
  updateCameraProjection();
  updateHud();
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

  try {
    await initFaceTracking();
  } catch (err) {
    console.warn('Face tracking unavailable:', err);
    trackingError = String(err?.message || err).slice(0, 40);
  }

  startEl.style.display = 'none';
  counterEl.classList.remove('hidden');
  if (hudEl) hudEl.classList.remove('hidden');
  updateCounter();
  requestAnimationFrame(renderFrame);
}

startBtn.addEventListener('click', start);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) start();
});
