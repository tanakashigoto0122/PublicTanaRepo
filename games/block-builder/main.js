import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  addShape, createHistory, createSampleScene, createScene, deserialize, duplicateShape, findShape,
  record, redo, removeShape, serialize, undo, updateShape,
} from './logic.js';
import { cssValue } from '../shared/theme.js';

const SAVE_KEY = 'mini-games:block-builder:scene';
const KIND_NAMES = { box: '箱', sphere: '球', cylinder: '円柱', cone: '円すい', torus: 'ドーナツ' };
// タップと判定する指の移動量（ピクセル）。これより動いたら視点の操作とみなす
const TAP_TOLERANCE = 6;

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const kindEl = document.getElementById('kind');
const colorEl = document.getElementById('color');
const snapEl = document.getElementById('snap');
const buttons = {
  add: document.getElementById('add'),
  duplicate: document.getElementById('duplicate'),
  delete: document.getElementById('delete'),
  shrink: document.getElementById('shrink'),
  grow: document.getElementById('grow'),
  undo: document.getElementById('undo'),
  redo: document.getElementById('redo'),
  resetView: document.getElementById('reset-view'),
  export: document.getElementById('export'),
  clear: document.getElementById('clear'),
};
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const info = {
  name: document.getElementById('info-name'),
  position: document.getElementById('info-position'),
  scale: document.getElementById('info-scale'),
  rotation: document.getElementById('info-rotation'),
  count: document.getElementById('info-count'),
};

// 色は style.css の CSS 変数から読む（ダークモードの切り替えにも追従する）
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.append(renderer.domElement);

const scene3d = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const hemisphere = new THREE.HemisphereLight(0xffffff, 0x666666, 1.2);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(5, 10, 7);
scene3d.add(hemisphere, sun);

// 作品の形だけを入れるグループ。書き出しはこのグループだけを対象にする
const shapesGroup = new THREE.Group();
scene3d.add(shapesGroup);

const transform = new TransformControls(camera, renderer.domElement);
transform.size = window.matchMedia('(pointer: coarse)').matches ? 1.4 : 1;
scene3d.add(transform.getHelper());

const geometries = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 48, 32),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 48),
  cone: new THREE.ConeGeometry(0.5, 1, 48),
  torus: new THREE.TorusGeometry(0.35, 0.15, 24, 64),
};

const meshes = new Map();
let grid = null;
let outline = null;
let history = createHistory(loadScene());
let selectedId = null;
// ハンドルを掴んだ操作の直後は、指を離してもタップ（選択）として扱わない
let handledByGizmo = false;
let pointerStart = null;

function loadScene() {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    const scene = saved && deserialize(saved);
    if (scene) return scene;
  } catch {
    // 読めなければサンプルから始める
  }
  return createSampleScene(['--piece-z', '--piece-j', '--piece-o'].map(cssValue));
}

function saveScene() {
  try {
    localStorage.setItem(SAVE_KEY, serialize(history.present));
  } catch {
    // 保存できなくても遊べる
  }
}

function applyTheme() {
  scene3d.background = new THREE.Color(cssValue('--surface'));
  if (grid) {
    scene3d.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(20, 40, cssValue('--muted'), cssValue('--border'));
  scene3d.add(grid);
  if (outline) outline.material.color.set(cssValue('--accent'));
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function resetView() {
  camera.position.set(5, 5, 7);
  orbit.target.set(0, 1, 0);
  orbit.update();
}

// 作品のデータに合わせて 3D の形を作る・更新する・消す
function syncMeshes() {
  const { shapes } = history.present;
  const ids = new Set(shapes.map((s) => s.id));
  for (const [id, mesh] of meshes) {
    if (ids.has(id)) continue;
    shapesGroup.remove(mesh);
    mesh.material.dispose();
    meshes.delete(id);
  }
  for (const shape of shapes) {
    let mesh = meshes.get(shape.id);
    if (!mesh || mesh.userData.kind !== shape.kind) {
      if (mesh) {
        shapesGroup.remove(mesh);
        mesh.material.dispose();
      }
      mesh = new THREE.Mesh(geometries[shape.kind], new THREE.MeshStandardMaterial({ roughness: 0.5 }));
      mesh.userData = { id: shape.id, kind: shape.kind };
      mesh.name = `${KIND_NAMES[shape.kind]} ${shape.id}`;
      meshes.set(shape.id, mesh);
      shapesGroup.add(mesh);
    }
    mesh.position.fromArray(shape.position);
    mesh.rotation.fromArray(shape.rotation);
    mesh.scale.fromArray(shape.scale);
    mesh.material.color.set(shape.color);
  }
  if (selectedId !== null && !ids.has(selectedId)) select(null);
  else select(selectedId);
}

function select(id) {
  selectedId = id;
  const mesh = id === null ? null : meshes.get(id);
  if (outline) {
    scene3d.remove(outline);
    outline.geometry.dispose();
    outline.material.dispose();
    outline = null;
  }
  if (mesh) {
    transform.attach(mesh);
    outline = new THREE.BoxHelper(mesh, cssValue('--accent'));
    scene3d.add(outline);
    colorEl.value = findShape(history.present, id).color;
  } else {
    transform.detach();
  }
  updateInfo();
}

function updateButtons() {
  const hasSelection = selectedId !== null;
  buttons.duplicate.disabled = !hasSelection;
  buttons.delete.disabled = !hasSelection;
  buttons.shrink.disabled = !hasSelection;
  buttons.grow.disabled = !hasSelection;
  buttons.undo.disabled = history.past.length === 0;
  buttons.redo.disabled = history.future.length === 0;
  buttons.clear.disabled = history.present.shapes.length === 0;
  buttons.export.disabled = history.present.shapes.length === 0;
}

function formatVector(values, digits = 2) {
  return values.map((v) => Number(v.toFixed(digits)).toString()).join(', ');
}

function updateInfo() {
  const mesh = selectedId === null ? null : meshes.get(selectedId);
  if (mesh) {
    info.name.textContent = mesh.name;
    info.position.textContent = formatVector(mesh.position.toArray());
    info.scale.textContent = formatVector(mesh.scale.toArray());
    info.rotation.textContent = formatVector(
      [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map(THREE.MathUtils.radToDeg), 0,
    ) + '（度）';
  } else {
    info.name.textContent = 'なし';
    info.position.textContent = '-';
    info.scale.textContent = '-';
    info.rotation.textContent = '-';
  }
  info.count.textContent = `${history.present.shapes.length} 個`;
  updateButtons();
}

// 作品を変える操作はすべてここを通し、履歴に記録して保存する
function commit(next) {
  history = record(history, next);
  syncMeshes();
  saveScene();
}

function changeHistory(next, message) {
  if (next === history) return;
  history = next;
  syncMeshes();
  saveScene();
  statusEl.textContent = message;
}

function sameValues(a, b) {
  return a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
}

// ハンドルで動かし終わったら、その結果を作品に反映する
function commitTransform() {
  const mesh = transform.object;
  if (!mesh) return;
  const shape = findShape(history.present, mesh.userData.id);
  const position = mesh.position.toArray();
  const rotation = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z];
  const scale = mesh.scale.toArray();
  if (sameValues(position, shape.position) && sameValues(rotation, shape.rotation) && sameValues(scale, shape.scale)) return;
  commit(updateShape(history.present, shape.id, { position, rotation, scale }));
}

function setMode(mode) {
  transform.setMode(mode);
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
}

function applySnap() {
  const on = snapEl.checked;
  transform.setTranslationSnap(on ? 0.25 : null);
  transform.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
  transform.setScaleSnap(on ? 0.25 : null);
}

function applyColor(color) {
  colorEl.value = color;
  if (selectedId === null) return;
  commit(updateShape(history.present, selectedId, { color }));
}

function pickShape(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects([...meshes.values()], false);
  return hit ? hit.object.userData.id : null;
}

async function exportGlb() {
  try {
    const data = await new GLTFExporter().parseAsync(shapesGroup, { binary: true });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
    link.download = 'blocks.glb';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    statusEl.textContent = 'blocks.glb を書き出しました。';
  } catch (error) {
    console.warn(error);
    statusEl.textContent = '書き出しに失敗しました。';
  }
}

transform.addEventListener('dragging-changed', (event) => {
  orbit.enabled = !event.value;
  if (event.value) handledByGizmo = true;
  else commitTransform();
});
transform.addEventListener('objectChange', () => {
  outline?.update();
  updateInfo();
});

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerStart = { x: event.clientX, y: event.clientY };
  handledByGizmo = transform.dragging;
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!pointerStart || handledByGizmo) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  pointerStart = null;
  if (moved > TAP_TOLERANCE) return;
  select(pickShape(event));
});

buttons.add.addEventListener('click', () => {
  const next = addShape(history.present, kindEl.value, colorEl.value);
  commit(next);
  select(next.shapes[next.shapes.length - 1].id);
  statusEl.textContent = '';
});
buttons.duplicate.addEventListener('click', () => {
  if (selectedId === null) return;
  const next = duplicateShape(history.present, selectedId);
  commit(next);
  select(next.shapes[next.shapes.length - 1].id);
});
buttons.delete.addEventListener('click', () => {
  if (selectedId === null) return;
  commit(removeShape(history.present, selectedId));
});
// 中央のハンドルでの拡大縮小は指だと加減が難しいので、ボタンでも縦横高さをまとめて変えられるようにする
function scaleSelected(factor) {
  if (selectedId === null) return;
  const shape = findShape(history.present, selectedId);
  commit(updateShape(history.present, selectedId, { scale: shape.scale.map((v) => v * factor) }));
}
buttons.shrink.addEventListener('click', () => scaleSelected(0.8));
buttons.grow.addEventListener('click', () => scaleSelected(1.25));
buttons.undo.addEventListener('click', () => changeHistory(undo(history), ''));
buttons.redo.addEventListener('click', () => changeHistory(redo(history), ''));
buttons.clear.addEventListener('click', () => {
  commit(createScene());
  statusEl.textContent = '全部消しました。「元に戻す」で戻せます。';
});
buttons.resetView.addEventListener('click', resetView);
buttons.export.addEventListener('click', exportGlb);

for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
document.getElementById('colors').addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (swatch) applyColor(cssValue(swatch.dataset.color));
});
// 色を選んでいる途中は見た目だけ変え、決まったときに記録する
colorEl.addEventListener('input', () => {
  meshes.get(selectedId)?.material.color.set(colorEl.value);
});
colorEl.addEventListener('change', () => applyColor(colorEl.value));
snapEl.addEventListener('change', applySnap);

document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, select, textarea')) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    buttons[event.shiftKey ? 'redo' : 'undo'].click();
  } else if (mod && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    buttons.redo.click();
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
    event.preventDefault();
    buttons.delete.click();
  } else if (event.key === 'Escape') {
    select(null);
  }
});

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

colorEl.value = cssValue('--piece-j');
resize();
applyTheme();
applySnap();
resetView();
syncMeshes();
renderer.setAnimationLoop(() => {
  orbit.update();
  outline?.update();
  renderer.render(scene3d, camera);
});
