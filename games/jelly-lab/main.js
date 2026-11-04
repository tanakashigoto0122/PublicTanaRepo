import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  MODEL_HEIGHT, addVelocity, averageSpacing, bindVertices, createBody, deformVertices, detectFormat,
  farthestPointSample, guessFacing, stepBody, stiffnessFromSoftness, strideIndices, toFloatArray, translateBody,
} from './logic.js';

const PARTICLE_COUNT = 200;
// まとまりの半径（粒の平均の間隔に対する倍率）。大きいほど広い範囲がいっしょに動く
const CLUSTER_SCALE = 2.5;
const STEP = 1 / 120;
const MAX_STEPS = 4;
// つかんだ所から、この範囲の粒をいっしょにつかむ（モデルの高さに対する割合）
const GRAB_RADIUS = 0.15;
const DROP_HEIGHT = 3;
const JUMP_SPEED = 6;
const WALL = 4;
const DB_NAME = 'mini-games-mecha-blaster';
const DB_STORE = 'character';

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const softnessEl = document.getElementById('softness');
const bounceEl = document.getElementById('bounce');

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 8, 5);
scene.add(hemisphere, sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(WALL * 2, WALL * 2), new THREE.MeshStandardMaterial({ roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
let grid = null;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// 床の下へ回り込まないようにする
controls.maxPolarAngle = Math.PI / 2 - 0.05;

// いまのモデル。parts はメッシュごとの { mesh, rest, binding }、body はぷるぷるの体
let model = null;

// メッシュの位置・向き・大きさを頂点に焼き込み、高さ MODEL_HEIGHT・足元が床・真ん中が原点、正面がカメラを向くようにそろえる
function prepareModel(object, facing) {
  const holder = new THREE.Group();
  holder.add(object);
  holder.rotation.y = facing;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? MODEL_HEIGHT / size.y : 1;
  const normalize = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  const root = new THREE.Group();
  const meshes = [];
  holder.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry.clone();
    geometry.setAttribute('position', new THREE.BufferAttribute(toFloatArray(geometry.attributes.position), 3));
    geometry.deleteAttribute('normal');
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(normalize, child.matrixWorld));
    geometry.computeVertexNormals();
    const material = Array.isArray(child.material) ? child.material.map((m) => m.clone()) : child.material.clone();
    const mesh = new THREE.Mesh(geometry, material);
    // 形が毎フレーム変わるので、画面の外判定で消えないようにする
    mesh.frustumCulled = false;
    root.add(mesh);
    meshes.push(mesh);
  });
  if (meshes.length === 0) throw new Error('メッシュがないモデル');

  // 表面から、互いに離れた粒を選ぶ
  const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  const samples = [];
  for (const mesh of meshes) {
    const array = mesh.geometry.attributes.position.array;
    const count = mesh.geometry.attributes.position.count;
    for (const i of strideIndices(count, Math.ceil((4000 * count) / total))) samples.push([array[i * 3], array[i * 3 + 1], array[i * 3 + 2]]);
  }
  const particles = Float32Array.from(farthestPointSample(samples, PARTICLE_COUNT).flat());
  const body = createBody(particles, averageSpacing(particles) * CLUSTER_SCALE);
  const parts = meshes.map((mesh) => {
    const rest = mesh.geometry.attributes.position.array.slice();
    return { mesh, rest, binding: bindVertices(rest, particles) };
  });
  return { root, parts, body };
}

function setModel(next) {
  if (model) {
    scene.remove(model.root);
    model.root.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose();
    });
  }
  model = next;
  scene.add(model.root);
  grab = null;
}

function clayBall() {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshStandardMaterial({ color: cssValue('--piece-l'), roughness: 0.4 }));
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

async function parseModel({ format, data }) {
  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    return (await loader.parseAsync(format === 'gltf' ? new TextDecoder().decode(data) : data, '')).scene;
  }
  const material = () => new THREE.MeshStandardMaterial({ color: cssValue('--piece-j'), roughness: 0.5 });
  if (format === 'obj') {
    const object = new OBJLoader().parse(new TextDecoder().decode(data));
    object.traverse((child) => {
      if (child.isMesh) child.material = material();
    });
    return object;
  }
  const mesh = new THREE.Mesh(new STLLoader().parse(data), material());
  mesh.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

async function loadRecord(record) {
  const object = await parseModel(record);
  const facing = record.facing ?? guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
  setModel(prepareModel(object, facing));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCharacter() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function useCharacter({ quiet = false } = {}) {
  try {
    const record = await readCharacter();
    if (record?.data instanceof ArrayBuffer && detectFormat(record.name)) {
      await loadRecord(record);
      setStatus(`キャラクター（${record.name}）がぷるぷるになりました。`);
      return;
    }
  } catch (error) {
    console.warn(error);
  }
  if (!quiet) setStatus('キャラクターがまだありません。「3D モデルを読み込む」から選んでね。');
}

// ---- つかむ ----

const raycaster = new THREE.Raycaster();
let grab = null;

function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  ), camera);
}

// OrbitControls より先に登録して、モデルをつかんだときは視点が回らないようにする
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!model || grab) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointerRay(event);
  const [hit] = raycaster.intersectObjects(model.parts.map((p) => p.mesh), false);
  if (!hit) return;
  // つかんだ点の近くの粒を、いまの位置からのずれを保ったまま指についてこさせる
  const { positions } = model.body;
  const radius = GRAB_RADIUS * MODEL_HEIGHT;
  const members = [];
  let nearest = { index: -1, distance: Infinity };
  for (let i = 0; i < positions.length / 3; i++) {
    const d = Math.hypot(positions[i * 3] - hit.point.x, positions[i * 3 + 1] - hit.point.y, positions[i * 3 + 2] - hit.point.z);
    if (d < radius) members.push(i);
    if (d < nearest.distance) nearest = { index: i, distance: d };
  }
  if (members.length === 0) members.push(nearest.index);
  const facing = new THREE.Vector3();
  camera.getWorldDirection(facing);
  grab = {
    id: event.pointerId,
    start: hit.point.clone(),
    plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing.negate(), hit.point),
    offsets: new Map(members.map((i) => [i, [positions[i * 3] - hit.point.x, positions[i * 3 + 1] - hit.point.y, positions[i * 3 + 2] - hit.point.z]])),
  };
  moveGrab(hit.point);
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
});

function moveGrab(point) {
  model.body.pinned.clear();
  for (const [i, offset] of grab.offsets) {
    // 床より下には引っぱり込まない
    model.body.pinned.set(i, [point.x + offset[0], Math.max(0, point.y + offset[1]), point.z + offset[2]]);
  }
}

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!grab || event.pointerId !== grab.id) return;
  pointerRay(event);
  const target = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(grab.plane, target)) moveGrab(target);
});
function endGrab(event) {
  if (!grab || event.pointerId !== grab.id) return;
  // 離すと、そのときの勢いのまま飛んでいく
  model.body.pinned.clear();
  grab = null;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endGrab);
renderer.domElement.addEventListener('pointercancel', endGrab);

// ---- ボタン ----

function lowestY() {
  let lowest = Infinity;
  for (let i = 1; i < model.body.positions.length; i += 3) lowest = Math.min(lowest, model.body.positions[i]);
  return lowest;
}

document.getElementById('drop').addEventListener('click', () => {
  translateBody(model.body, [0, DROP_HEIGHT - lowestY(), 0]);
  setStatus('');
});
document.getElementById('jump').addEventListener('click', () => {
  addVelocity(model.body, [0, JUMP_SPEED, 0]);
});
document.getElementById('reset').addEventListener('click', () => {
  model.body.positions.set(model.body.rest);
  model.body.velocities.fill(0);
  model.body.rotations.forEach((q) => q.splice(0, 4, 0, 0, 0, 1));
  model.body.pinned.clear();
  setStatus('元に戻しました。');
});
document.getElementById('file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const format = detectFormat(file.name);
  if (!format) return setStatus(`「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`);
  setStatus(`「${file.name}」を読み込み中…`);
  try {
    await loadRecord({ name: file.name, format, data: await file.arrayBuffer() });
    setStatus(`「${file.name}」がぷるぷるになりました。`);
  } catch (error) {
    console.warn(error);
    setStatus(`「${file.name}」を読み込めませんでした。`);
  }
});
document.getElementById('use-character').addEventListener('click', () => useCharacter());
document.getElementById('clay').addEventListener('click', () => {
  setModel(prepareModel(clayBall(), 0));
  setStatus('粘土の玉にしました。');
});
for (const el of [softnessEl, bounceEl]) el.addEventListener('input', updateLabels);

function updateLabels() {
  document.getElementById('softness-value').textContent = `${softnessEl.value}%`;
  document.getElementById('bounce-value').textContent = `${bounceEl.value}%`;
}

// ---- 描画 ----

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  floor.material.color.set(cssValue('--bg'));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(WALL * 2, 16, cssValue('--muted'), cssValue('--border'));
  grid.position.y = 0.002;
  scene.add(grid);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

resize();
applyTheme();
updateLabels();
camera.position.set(0, 2.6, 6.5);
controls.target.set(0, 1, 0);
controls.update();
setModel(prepareModel(clayBall(), 0));
useCharacter({ quiet: true });

const clock = new THREE.Timer();
let leftover = 0;
renderer.setAnimationLoop((time) => {
  clock.update(time);
  if (model) {
    // 画面の速さに関係なく、決まった刻みで物理を進める（重い端末では遅れを捨てる）
    leftover = Math.min(leftover + clock.getDelta(), STEP * MAX_STEPS);
    const options = {
      dt: STEP,
      stiffness: stiffnessFromSoftness(Number(softnessEl.value)),
      bounce: Number(bounceEl.value) / 100,
      wall: WALL,
    };
    while (leftover >= STEP) {
      stepBody(model.body, options);
      leftover -= STEP;
    }
    for (const part of model.parts) {
      deformVertices(part.mesh.geometry.attributes.position.array, part.rest, part.binding, model.body);
      part.mesh.geometry.attributes.position.needsUpdate = true;
      part.mesh.geometry.computeVertexNormals();
      part.mesh.geometry.computeBoundingSphere();
    }
  }
  controls.update();
  renderer.render(scene, camera);
});
