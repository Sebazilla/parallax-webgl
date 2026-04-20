// Hidden-object "Find the Items" — static framed scene, no parallax.
//
// Astrid's feedback: parallax exposes the flat BG edges and makes 3D items
// still feel like floating stickers. So: fixed camera that frames the BG
// exactly. 7 GLB items placed onto surfaces in the scene. Tap to find.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- Scene composition.
// BG fills the screen. Camera is a plain PerspectiveCamera looking straight at it.
const BG = { name: 'wimmel_bg_v3', h: 1.0, aspect: 1024 / 1536, z: -1.5 };

// Items placed in screen-space (ndcX, ndcY) over specific surfaces in the
// painted BG. sizeRel = fraction of screen height. ndcX/ndcY are -1..+1.
//
// Surface guide (from wimmel_bg_v3):
//   sofa cushions:     y ≈ -0.10 .. -0.22,  x ≈ -0.25 .. +0.25
//   coffee table top:  y ≈ -0.45 .. -0.70,  x ≈ -0.30 .. +0.30
//   bookshelf shelf:   y ≈  0.20 .. +0.40,  x ≈ -0.65 .. -0.45
//   curtain left:      y ≈  0.10 .. -0.10,  x ≈ -0.55
//   mannequin/right:   y ≈  0.20 .. +0.05,  x ≈ +0.55
//   plants window:     y ≈  0.05 .. -0.05,  x ≈ ±0.20
const ITEMS = [
  // Sofa: small items tucked on cushions.
  { name: 'pocket_watch',     sizeRel: 0.06, ndcX: -0.15, ndcY: -0.15, rotY:  0.2, rotZ: -0.1 },
  { name: 'plush_mouse',      sizeRel: 0.08, ndcX:  0.18, ndcY: -0.17, rotY: -0.3 },
  // Bookshelf top area: small chess figurine as if on a shelf.
  { name: 'chess_queen',      sizeRel: 0.09, ndcX: -0.52, ndcY:  0.05, rotY: -0.2 },
  // On the side table by the typewriter.
  { name: 'skeleton_key',     sizeRel: 0.10, ndcX:  0.52, ndcY: -0.30, rotY: -0.2, rotZ: -0.5 },
  // Coffee table — lay flat facing up.
  { name: 'magnifying_glass', sizeRel: 0.13, ndcX:  0.22, ndcY: -0.44, rotY:  0.3, rotZ:  0.4 },
  { name: 'eyeglasses',       sizeRel: 0.11, ndcX: -0.20, ndcY: -0.52, rotY:  0.05, rotZ: -0.05 },
  { name: 'fountain_pen',     sizeRel: 0.12, ndcX:  0.06, ndcY: -0.56, rotY:  0.4, rotZ:  0.3 },
];

// Items sit at this world-z. Kept close to BG.z so they feel inside the frame
// rather than floating far in front.
const ITEM_Z = -1.35;

// ---- DOM
const canvas = document.getElementById('scene');
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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  const screenAspect = w / h;
  camera.aspect = screenAspect;

  // Make BG fill the frame: pick whichever axis is binding. In portrait, BG
  // is taller-than-wide and so is the screen, but screen aspect is tighter,
  // so BG width usually binds.
  const bgW = BG.h * BG.aspect;
  const bgH = BG.h;
  const distance = Math.abs(BG.z);
  // Vertical FOV needed to exactly fit BG height:
  const fovToFitH = 2 * Math.atan((bgH / 2) / distance) * 180 / Math.PI;
  // Vertical FOV needed to exactly fit BG width (given current aspect):
  const fovToFitW = 2 * Math.atan((bgW / 2 / screenAspect) / distance) * 180 / Math.PI;
  camera.fov = Math.max(fovToFitH, fovToFitW);
  camera.updateProjectionMatrix();
}

resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// Lighting for 3D items.
// Warm key from upper-left matches BG's lamp; cool fill from window/right.
scene.add(new THREE.AmbientLight(0xffe8c8, 0.75));
const keyLight = new THREE.DirectionalLight(0xffd88a, 1.1);
keyLight.position.set(-0.6, 0.5, 0.5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x7fa5d8, 0.45);
fillLight.position.set(0.6, 0.2, 0.3);
scene.add(fillLight);

const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

function makeShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 60);
  g.addColorStop(0.0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.35)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const SHADOW_TEX = makeShadowTexture();

// ---- BG plane
function addBackground() {
  const geom = new THREE.PlaneGeometry(BG.h * BG.aspect, BG.h);
  const tex = texLoader.load(`./assets/${BG.name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshBasicMaterial({ map: tex, depthWrite: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(0, 0, BG.z);
  mesh.renderOrder = 0;
  scene.add(mesh);
}

addBackground();

// ---- Items
const itemObjects = [];

// Convert (ndcX, ndcY) at ITEM_Z into world (x, y).
function ndcToWorld(ndcX, ndcY, worldZ) {
  const fovY = camera.fov * Math.PI / 180;
  const halfH = Math.abs(worldZ) * Math.tan(fovY / 2);
  const halfW = halfH * camera.aspect;
  return { x: ndcX * halfW, y: ndcY * halfH };
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
        root.position.sub(center);

        const pivot = new THREE.Group();
        pivot.add(root);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        // Convert sizeRel (fraction of screen height) to world units at ITEM_Z.
        const fovY = camera.fov * Math.PI / 180;
        const worldH = 2 * Math.abs(ITEM_Z) * Math.tan(fovY / 2);
        const targetWorldSize = item.sizeRel * worldH;
        const scale = targetWorldSize / maxDim;
        pivot.scale.setScalar(scale);

        // Soft blob shadow under item to anchor it on the underlying surface.
        const shadowR = targetWorldSize * 0.55;
        const shadow = new THREE.Mesh(
          new THREE.CircleGeometry(shadowR, 32),
          new THREE.MeshBasicMaterial({
            map: SHADOW_TEX,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        );
        shadow.renderOrder = 5;

        const pos = ndcToWorld(item.ndcX, item.ndcY, ITEM_Z);
        pivot.position.set(pos.x, pos.y, ITEM_Z);
        shadow.position.set(pos.x, pos.y - targetWorldSize * 0.35, ITEM_Z - 0.005);
        scene.add(shadow);
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

// ---- Animation loop
function renderFrame() {
  renderer.render(scene, camera);
  if (hud) {
    hud.textContent = `${foundCount}/${ITEMS.length}`;
  }
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
  startEl.style.display = 'none';
  counterEl.classList.remove('hidden');
  updateCounter();
  requestAnimationFrame(renderFrame);
}

startBtn.addEventListener('click', start);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) start();
});
