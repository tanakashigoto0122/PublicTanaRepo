import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  MODEL_HEIGHT, applyOffset, brushWeights, customName, detectFormat, fillZeroNormals, groupByPosition, groupedNormals,
  inflate,
  pushHistory, smooth, springStep, toFloatArray,
} from './logic.js';

// ふくらます・へこますの速さ（1 秒あたり、モデルの高さに対する割合。強さ 100% のとき）
const INFLATE_RATE = 0.25;
const SMOOTH_RATE = 6;
// 離したあとの揺れが、これより小さくなったら止める
const SPRING_EPSILON = 1e-4;
// キャラクターはメカ・ブラスターとぶっ飛ばしチャレンジと同じ場所に保存する
const DB_NAME = 'mini-games-mecha-blaster';
const DB_STORE = 'character';
const HINTS = {
  view: '1 本指で回す、2 本指で拡大・移動。モデルにさわっても形は変わらない。',
  grab: 'モデルの好きな所をつかんで引っぱる。何もない所のドラッグは視点の回転。',
  inflate: 'モデルの表面をなでると、そこがふくらむ（押している間ふくらみ続ける）。',
  deflate: 'モデルの表面をなでると、そこがへこむ。',
  smooth: 'でこぼこした所をなでると、なめらかになる。',
};

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const radiusEl = document.getElementById('radius');
const strengthEl = document.getElementById('strength');
const elasticEl = document.getElementById('elastic');
const undoEl = document.getElementById('undo');
const toolButtons = [...document.querySelectorAll('[data-tool]')];

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
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6, 4);
scene.add(hemisphere, sun);
let grid = null;

// ブラシの範囲を示す半透明の球
const cursor = new THREE.Mesh(
  new THREE.SphereGeometry(1, 24, 16),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false }),
);
cursor.visible = false;
scene.add(cursor);

// いま改造しているモデル。parts はメッシュごとの { mesh, positions, original, grouping }
let model = null;
let history = [];
let tool = 'grab';
// 離したあとに揺れながら戻っている頂点。{ part, rest, velocities, indices }
let springs = [];

// ---- モデルの準備 ----

// モデルのメッシュを、位置・向き・大きさを頂点に焼き込んだ形に作り直し、
// 高さ MODEL_HEIGHT・足元が y = 0・真ん中が原点になるようにそろえる
function prepareModel(object, name, facing) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? MODEL_HEIGHT / size.y : 1;
  const normalize = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));

  const root = new THREE.Group();
  const parts = [];
  object.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry.clone();
    // 量子化された値なども、ふつうの小数にして書き換えられるようにする
    geometry.setAttribute('position', new THREE.BufferAttribute(toFloatArray(geometry.attributes.position), 3));
    geometry.deleteAttribute('normal');
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(normalize, child.matrixWorld));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = Array.isArray(child.material) ? child.material.map((m) => m.clone()) : child.material.clone();
    const mesh = new THREE.Mesh(geometry, material);
    root.add(mesh);
    const positions = geometry.attributes.position.array;
    parts.push({ mesh, positions, original: positions.slice(), grouping: groupByPosition(positions) });
  });
  if (parts.length === 0) throw new Error('メッシュがないモデル');
  return { root, parts, name, facing };
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
  history = [];
  springs = [];
  undoEl.disabled = true;
  resetView();
}

function resetView() {
  camera.position.set(2.2, 1.8, 3.6);
  controls.target.set(0, MODEL_HEIGHT / 2, 0);
  controls.update();
}

function clayBall() {
  const geometry = new THREE.SphereGeometry(1, 160, 120);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: cssValue('--piece-l'), roughness: 0.6 }));
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

// ---- 形の変更 ----

function brushRadius() {
  return (Number(radiusEl.value) / 100) * MODEL_HEIGHT;
}

function strength() {
  return Number(strengthEl.value) / 100;
}

function snapshot() {
  return model.parts.map((part) => part.positions.slice());
}

function remember() {
  history = pushHistory(history, snapshot());
  undoEl.disabled = false;
}

function refresh(part) {
  const { geometry } = part.mesh;
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

function undo() {
  const previous = history.pop();
  if (!previous) return;
  springs = [];
  model.parts.forEach((part, i) => {
    part.positions.set(previous[i]);
    refresh(part);
  });
  undoEl.disabled = history.length === 0;
  setStatus('ひとつ前に戻しました。');
}

function resetShape() {
  remember();
  springs = [];
  for (const part of model.parts) {
    part.positions.set(part.original);
    refresh(part);
  }
  setStatus('最初の形に戻しました（「元に戻す」で取り消せます）。');
}

// ---- 入力 ----

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let stroke = null;

function pickSurface(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(model.parts.map((p) => p.mesh), false);
  return hit ?? null;
}

function showCursor(point) {
  cursor.visible = Boolean(point);
  if (!point) return;
  cursor.position.copy(point);
  cursor.scale.setScalar(brushRadius());
}

function startGrab(hit) {
  // 揺れて戻っている途中でも、いまの形からつかみ直す
  springs = [];
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  const center = hit.point.toArray();
  stroke = {
    tool: 'grab',
    start: hit.point.clone(),
    plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal.negate(), hit.point),
    before: snapshot(),
    brushes: model.parts.map((part) => brushWeights(part.positions, center, brushRadius())),
  };
  showCursor(hit.point);
}

function moveGrab(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const target = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(stroke.plane, target)) return;
  const delta = target.clone().sub(stroke.start).toArray();
  model.parts.forEach((part, i) => {
    if (stroke.brushes[i].indices.length === 0) return;
    applyOffset(part.positions, stroke.before[i], stroke.brushes[i], delta);
    refresh(part);
  });
  showCursor(target);
}

function endGrab() {
  if (elasticEl.checked) {
    // 引っぱる前の形へ、揺れながら戻す
    springs = model.parts.map((part, i) => ({
      part,
      rest: stroke.before[i],
      velocities: new Float32Array(part.positions.length),
      indices: stroke.brushes[i].indices,
    })).filter((s) => s.indices.length > 0);
  } else {
    history = pushHistory(history, stroke.before);
    undoEl.disabled = false;
  }
}

// なでる道具は、押している間ずっと少しずつ効かせる
function applyBrush(dt) {
  if (!stroke || stroke.tool === 'grab' || !stroke.event) return;
  const hit = pickSurface(stroke.event);
  showCursor(hit?.point);
  if (!hit) return;
  const center = hit.point.toArray();
  const radius = brushRadius();
  for (const part of model.parts) {
    const brush = brushWeights(part.positions, center, radius);
    if (brush.indices.length === 0) continue;
    if (stroke.tool === 'smooth') {
      const cellSize = radius * 0.25;
      const region = brushWeights(part.positions, center, radius + cellSize).indices;
      smooth(part.positions, brush, cellSize, SMOOTH_RATE * strength() * dt, region);
    } else {
      const normals = groupedNormals(part.mesh.geometry.attributes.normal.array, part.grouping);
      const sign = stroke.tool === 'inflate' ? 1 : -1;
      inflate(part.positions, normals, brush, sign * INFLATE_RATE * MODEL_HEIGHT * strength() * dt);
    }
    refresh(part);
  }
}

function stepSprings(dt) {
  if (springs.length === 0) return;
  let largest = 0;
  for (const spring of springs) {
    largest = Math.max(largest, springStep(spring.part.positions, spring.velocities, spring.rest, spring.indices, { dt }));
    refresh(spring.part);
  }
  if (largest < SPRING_EPSILON) {
    // 最後は元の位置にぴったり戻す
    for (const spring of springs) {
      for (const v of spring.indices) {
        for (let k = 0; k < 3; k++) spring.part.positions[v * 3 + k] = spring.rest[v * 3 + k];
      }
      refresh(spring.part);
    }
    springs = [];
  }
}

// OrbitControls より先に登録して、モデルにさわったときは視点が回らないようにする
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (stroke || !model || tool === 'view') return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const hit = pickSurface(event);
  if (!hit) return;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
  if (tool === 'grab') {
    startGrab(hit);
  } else {
    remember();
    stroke = { tool, event };
  }
  stroke.pointerId = event.pointerId;
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!stroke || event.pointerId !== stroke.pointerId) return;
  if (stroke.tool === 'grab') moveGrab(event);
  else stroke.event = event;
});
function endStroke(event) {
  if (!stroke || event.pointerId !== stroke.pointerId) return;
  if (stroke.tool === 'grab') endGrab();
  stroke = null;
  cursor.visible = false;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endStroke);
renderer.domElement.addEventListener('pointercancel', endStroke);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function setTool(next) {
  tool = next;
  for (const button of toolButtons) button.setAttribute('aria-pressed', String(button.dataset.tool === next));
  hintEl.textContent = HINTS[next];
}

function updateLabels() {
  document.getElementById('radius-value').textContent = `${radiusEl.value}%`;
  document.getElementById('strength-value').textContent = `${strengthEl.value}%`;
}

// ---- 保存（キャラクターはこのブラウザの IndexedDB だけに保存し、どこにも送らない） ----

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode);
      const request = action(transaction.objectStore(DB_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

async function loadRecord(record) {
  setModel(prepareModel(await parseModel(record), record.name, record.facing));
}

async function useCharacter({ quiet = false } = {}) {
  try {
    const record = await withStore('readonly', (store) => store.get('current'));
    if (record?.data instanceof ArrayBuffer && detectFormat(record.name)) {
      await loadRecord(record);
      setStatus(`キャラクター（${record.name}）を読み込みました。`);
      return true;
    }
  } catch (error) {
    console.warn(error);
  }
  if (!quiet) setStatus('キャラクターがまだありません。メカ・ブラスターなどで読み込むか、ここで「3D モデルを読み込む」から選んでね。');
  return false;
}

async function exportGlb() {
  // 揺れている途中なら、止まった形を書き出す
  for (const spring of springs) {
    for (const v of spring.indices) {
      for (let k = 0; k < 3; k++) spring.part.positions[v * 3 + k] = spring.rest[v * 3 + k];
    }
    refresh(spring.part);
  }
  springs = [];
  for (const part of model.parts) fillZeroNormals(part.mesh.geometry.attributes.normal.array);
  return new GLTFExporter().parseAsync(model.root, { binary: true });
}

document.getElementById('file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const format = detectFormat(file.name);
  if (!format) return setStatus(`「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`);
  setStatus(`「${file.name}」を読み込み中…`);
  try {
    await loadRecord({ name: file.name, format, data: await file.arrayBuffer() });
    setStatus(`「${file.name}」を読み込みました。`);
  } catch (error) {
    console.warn(error);
    setStatus(`「${file.name}」を読み込めませんでした。`);
  }
});
document.getElementById('use-character').addEventListener('click', () => useCharacter());
document.getElementById('clay').addEventListener('click', () => {
  setModel(prepareModel(clayBall(), 'clay', 0));
  setStatus('粘土の玉にしました。');
});
document.getElementById('save-character').addEventListener('click', async () => {
  setStatus('保存中…');
  try {
    const data = await exportGlb();
    const record = { name: customName(model.name), format: 'glb', data, facing: model.facing };
    await withStore('readwrite', (store) => store.put(record, 'current'));
    setStatus(`「${record.name}」をキャラクターにしました。メカ・ブラスターやぶっ飛ばしチャレンジで使えます。`);
  } catch (error) {
    console.warn(error);
    setStatus('キャラクターにできませんでした。');
  }
});
document.getElementById('export').addEventListener('click', async () => {
  try {
    const data = await exportGlb();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
    link.download = customName(model.name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus(`${link.download} を書き出しました。`);
  } catch (error) {
    console.warn(error);
    setStatus('書き出せませんでした。');
  }
});
undoEl.addEventListener('click', undo);
document.getElementById('reset').addEventListener('click', resetShape);
for (const button of toolButtons) button.addEventListener('click', () => setTool(button.dataset.tool));
radiusEl.addEventListener('input', updateLabels);
strengthEl.addEventListener('input', updateLabels);

// ---- 描画 ----

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  cursor.material.color.set(cssValue('--accent'));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(6, 12, cssValue('--muted'), cssValue('--border'));
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
setTool('grab');
updateLabels();
setModel(prepareModel(clayBall(), 'clay', 0));
useCharacter({ quiet: true });
const clock = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  applyBrush(dt);
  stepSprings(dt);
  controls.update();
  renderer.render(scene, camera);
});
