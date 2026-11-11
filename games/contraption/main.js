import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  BALL_RADIUS, BOARD, GOAL_HOLD, GOAL_WALL, PART_TYPES, RUN_LIMIT, SANDBOX, STAGES, canPlace, canPut, inGoal, makePart,
  markCleared, parseCleared, pointInPart, remainingParts, rotatePart,
} from './logic.js';
import { buildWorld } from './physics.js';
import { cssValue } from '../shared/theme.js';

const STEP = 1 / 120;
const DEPTH = 0.6;
const CLEARED_KEY = 'mini-games:contraption:cleared';
const PART_COLORS = { ramp: '--piece-j', longRamp: '--piece-j', domino: '--piece-o', spring: '--piece-z', block: '--piece-t' };

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const overlayEl = document.getElementById('overlay');
const runEl = document.getElementById('run');
const paletteEl = document.getElementById('palette');
const stagesEl = document.getElementById('stages');

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
const CENTER = new THREE.Vector3(BOARD.width / 2, BOARD.height / 2, 0);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x666666, 1.5);
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-3, 8, 10);
scene.add(hemisphere, sun);

const materials = {
  board: new THREE.MeshStandardMaterial({ roughness: 1 }),
  ledge: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
  goal: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
  ball: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.3 }),
  light: new THREE.MeshStandardMaterial({ roughness: 0.4 }),
  seesaw: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
  selected: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
  invalid: new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, opacity: 0.6 }),
};
const partMaterials = Object.fromEntries(Object.keys(PART_TYPES).map((type) => [type, new THREE.MeshStandardMaterial({ roughness: 0.6 })]));

// 盤面の板（玉はこの手前の面を動く）
const boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.width, BOARD.height), materials.board);
boardMesh.position.set(BOARD.width / 2, BOARD.height / 2, -DEPTH / 2 - 0.01);
scene.add(boardMesh);
let grid = null;

function boxMesh({ w, h }, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, DEPTH), material);
}

function place(mesh, { x, y, angle = 0 }) {
  mesh.position.set(x, y, 0);
  mesh.rotation.set(0, 0, angle);
}

// ---- 盤面の中身 ----

let stageIndex = 0;
let stage = STAGES[0];
let placed = [];
let selected = null;
let paletteType = null;
let cleared = loadCleared();
// 表示している物：data（部品や固定物のデータ）→ mesh
const meshes = new Map();
const layer = new THREE.Group();
scene.add(layer);

function clearLayer() {
  for (const mesh of meshes.values()) {
    mesh.traverse((child) => {
      if (child.isMesh) child.geometry.dispose();
    });
  }
  meshes.clear();
  layer.clear();
}

function fixedMesh(item) {
  if (item.type === 'ball') {
    return new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 24, 16), item.light ? materials.light : materials.ball);
  }
  if (item.type === 'ledge') return boxMesh(item, materials.ledge);
  if (item.type === 'goal') {
    const group = new THREE.Group();
    const bottom = boxMesh({ w: item.w, h: 0.1 }, materials.goal);
    bottom.position.set(0, 0.05, 0);
    const left = boxMesh({ w: 0.1, h: GOAL_WALL }, materials.goal);
    left.position.set(-item.w / 2, GOAL_WALL / 2, 0);
    const right = left.clone();
    right.position.x = item.w / 2;
    group.add(bottom, left, right);
    return group;
  }
  if (item.type === 'seesaw') {
    // 支点の台は動かないので別に置き、ここでは板と縁を返す
    const group = new THREE.Group();
    const plank = boxMesh({ w: item.w, h: 0.12 }, materials.seesaw);
    const lip = boxMesh({ w: 0.1, h: 0.3 }, materials.seesaw);
    lip.position.set(item.w / 2 - 0.05, 0.2, 0);
    group.add(plank, lip);
    return group;
  }
  return boxMesh(item, partMaterials[item.type]);
}

function rebuildScene() {
  clearLayer();
  for (const item of stage.fixed) {
    const mesh = fixedMesh(item);
    layer.add(mesh);
    meshes.set(item, mesh);
    if (item.type === 'seesaw') {
      const stand = boxMesh({ w: 0.3, h: item.y - 0.1 }, materials.ledge);
      stand.position.set(item.x, item.y / 2 - 0.05, 0);
      layer.add(stand);
    }
  }
  for (const part of placed) {
    const mesh = boxMesh(part, partMaterials[part.type]);
    layer.add(mesh);
    meshes.set(part, mesh);
  }
  resetPositions();
  refreshSelection();
}

// 動く物を、置いた位置に戻す
function resetPositions() {
  for (const [item, mesh] of meshes) {
    if (item.type === 'goal') place(mesh, { x: item.x, y: item.y });
    else if (item.type === 'seesaw') place(mesh, { x: item.x, y: item.y + 0.08 });
    else place(mesh, item);
  }
}

function refreshSelection() {
  for (const part of placed) {
    const mesh = meshes.get(part);
    if (!mesh) continue;
    const valid = canPut(stage, part, placed);
    mesh.material = !valid ? materials.invalid : part === selected ? materials.selected : partMaterials[part.type];
  }
  document.getElementById('rotate').disabled = !selected || running();
  document.getElementById('remove').disabled = !selected || running();
}

function renderPalette() {
  const left = remainingParts(stage, placed);
  paletteEl.replaceChildren(...Object.keys(stage.parts).map((type) => {
    const button = document.createElement('button');
    const count = left[type];
    button.textContent = `${PART_TYPES[type].label}${Number.isFinite(count) ? ` ×${count}` : ''}`;
    button.disabled = running() || count <= 0;
    button.classList.toggle('selected', type === paletteType);
    button.addEventListener('click', () => {
      paletteType = paletteType === type ? null : type;
      selected = null;
      renderPalette();
      refreshSelection();
      if (paletteType) setStatus(`盤面をタップして「${PART_TYPES[type].label}」を置こう。`);
    });
    return button;
  }));
}

function renderStages() {
  const all = [...STAGES.map((s, i) => [i, `${i + 1}${cleared.includes(i) ? ' ✓' : ''}`]), [-1, 'じゆう']];
  stagesEl.replaceChildren(...all.map(([index, label]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.classList.toggle('current', index === stageIndex);
    button.addEventListener('click', () => loadStage(index));
    return button;
  }));
}

function loadStage(index) {
  stopRun();
  stageIndex = index;
  stage = index < 0 ? SANDBOX : STAGES[index];
  placed = [];
  selected = null;
  paletteType = null;
  overlayEl.hidden = true;
  document.getElementById('stage-title').textContent = index < 0 ? stage.title : `${index + 1}. ${stage.title}`;
  setStatus(stage.hint);
  rebuildScene();
  renderPalette();
  renderStages();
}

function loadCleared() {
  try {
    return parseCleared(localStorage.getItem(CLEARED_KEY));
  } catch {
    return [];
  }
}

function saveCleared() {
  try {
    localStorage.setItem(CLEARED_KEY, JSON.stringify(cleared));
  } catch {
    // 保存できなくても遊べる
  }
}

// ---- 置く・動かす ----

const raycaster = new THREE.Raycaster();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
let drag = null;

function boardPoint(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(boardPlane, hit) ? [hit.x, hit.y] : null;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (running() || drag) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const point = boardPoint(event);
  if (!point) return;
  // 置いた部品をつかむ（細い部品もつかみやすいよう、少し広めに）
  const hit = [...placed].reverse().find((part) => pointInPart(point, part, 0.15));
  if (hit) {
    selected = hit;
    paletteType = null;
    drag = { id: event.pointerId, part: hit, offset: [hit.x - point[0], hit.y - point[1]], last: [hit.x, hit.y] };
  } else if (paletteType && canPlace(stage, placed, paletteType)) {
    const part = makePart(paletteType, point);
    if (!canPut(stage, part, placed)) {
      setStatus('ほかの物と重なるので置けない。');
      return;
    }
    placed.push(part);
    selected = part;
    const mesh = boxMesh(part, partMaterials[part.type]);
    layer.add(mesh);
    meshes.set(part, mesh);
    place(mesh, part);
    if (!canPlace(stage, placed, paletteType)) paletteType = null;
    drag = { id: event.pointerId, part, offset: [0, 0], last: [part.x, part.y] };
    renderPalette();
  } else {
    selected = null;
  }
  refreshSelection();
  if (drag) renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  const point = boardPoint(event);
  if (!point) return;
  const moved = makePart(drag.part.type, [point[0] + drag.offset[0], point[1] + drag.offset[1]], drag.part.angle);
  drag.part.x = moved.x;
  drag.part.y = moved.y;
  place(meshes.get(drag.part), drag.part);
  // 置けない所では赤く見せ、置ける所を最後の位置として覚えておく
  if (canPut(stage, drag.part, placed)) drag.last = [drag.part.x, drag.part.y];
  refreshSelection();
});
function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  const { part, last } = drag;
  drag = null;
  if (!canPut(stage, part, placed)) {
    [part.x, part.y] = last;
    place(meshes.get(part), part);
  }
  refreshSelection();
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

document.getElementById('rotate').addEventListener('click', () => {
  if (!selected || running()) return;
  const before = selected.angle;
  selected.angle = rotatePart(selected.angle);
  // 回すと重なるなら、さらに回す（ひと回りしても駄目なら元に戻す）
  for (let i = 0; i < 12 && !canPut(stage, selected, placed); i++) selected.angle = rotatePart(selected.angle);
  if (!canPut(stage, selected, placed)) selected.angle = before;
  place(meshes.get(selected), selected);
  refreshSelection();
});
document.getElementById('remove').addEventListener('click', () => {
  if (!selected || running()) return;
  placed = placed.filter((part) => part !== selected);
  const mesh = meshes.get(selected);
  layer.remove(mesh);
  mesh.geometry.dispose();
  meshes.delete(selected);
  selected = null;
  renderPalette();
  refreshSelection();
});
document.getElementById('clear').addEventListener('click', () => {
  stopRun();
  placed = [];
  selected = null;
  rebuildScene();
  renderPalette();
});

// ---- 動かす ----

let sim = null;

function running() {
  return sim !== null;
}

function startRun() {
  selected = null;
  paletteType = null;
  // 置けない所にある部品は使わない
  const usable = placed.filter((part) => canPut(stage, part, placed));
  sim = { ...buildWorld(CANNON, stage, usable), time: 0, hold: 0, done: false, leftover: 0 };
  runEl.textContent = '止める';
  overlayEl.hidden = true;
  renderPalette();
  refreshSelection();
  setStatus('動け！');
}

function stopRun() {
  if (!sim) return;
  sim = null;
  runEl.textContent = 'スタート';
  resetPositions();
  renderPalette();
  refreshSelection();
}

function stepRun(frame) {
  sim.leftover = Math.min(sim.leftover + frame, STEP * 6);
  while (sim.leftover >= STEP) {
    sim.world.step(STEP);
    sim.time += STEP;
    sim.leftover -= STEP;
  }
  for (const body of sim.balls) place(meshes.get(body.item), { x: body.position.x, y: body.position.y, angle: angleOf(body) });
  for (const { body, item } of sim.moving) {
    place(meshes.get(item), { x: body.position.x, y: body.position.y, angle: angleOf(body) });
  }
  if (sim.done || stageIndex < 0) return;
  const scoring = stage.goalBall === undefined ? sim.balls : [sim.balls[stage.goalBall]];
  const inside = scoring.some((body) => sim.goals.some((goal) => inGoal([body.position.x, body.position.y], goal)));
  sim.hold = inside ? sim.hold + frame : 0;
  if (sim.hold >= GOAL_HOLD) {
    sim.done = true;
    cleared = markCleared(cleared, stageIndex);
    saveCleared();
    renderStages();
    const last = stageIndex === STAGES.length - 1;
    document.getElementById('overlay-text').textContent = last ? '全部のステージをクリア！ じゆうモードで好きな装置も作れる。' : `${placed.length} 個の部品でクリア`;
    document.getElementById('next').textContent = last ? 'じゆうへ' : '次へ';
    overlayEl.hidden = false;
    setStatus('');
  } else if (sim.time > RUN_LIMIT) {
    sim.done = true;
    setStatus('ゴールしなかった…。「止める」で戻して、置き方を変えてみよう。');
  }
}

const euler = new CANNON.Vec3();
function angleOf(body) {
  body.quaternion.toEuler(euler);
  return euler.z;
}

runEl.addEventListener('click', () => (running() ? stopRun() : startRun()));
document.getElementById('next').addEventListener('click', () => loadStage(stageIndex === STAGES.length - 1 ? -1 : stageIndex + 1));
document.getElementById('again').addEventListener('click', () => {
  stopRun();
  startRun();
});

// ---- 描画 ----

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  materials.board.color.set(cssValue('--bg'));
  materials.ledge.color.set(cssValue('--muted'));
  materials.goal.color.set(cssValue('--piece-s'));
  materials.ball.color.set(cssValue('--piece-l'));
  materials.light.color.set(cssValue('--piece-i'));
  materials.seesaw.color.set(cssValue('--piece-o'));
  materials.selected.color.set(cssValue('--accent'));
  materials.invalid.color.set(cssValue('--piece-z'));
  for (const [type, material] of Object.entries(partMaterials)) material.color.set(cssValue(PART_COLORS[type]));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(BOARD.height, BOARD.height, cssValue('--border'), cssValue('--border'));
  grid.rotation.x = Math.PI / 2;
  grid.position.set(BOARD.width / 2, BOARD.height / 2, -DEPTH / 2);
  grid.scale.set(BOARD.width / BOARD.height, 1, 1);
  scene.add(grid);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // 盤面の縦と横が両方入る距離（上に題名の分の余白）
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const distance = Math.max((BOARD.height / 2 + 0.7) / tan, (BOARD.width / 2 + 0.4) / (tan * camera.aspect));
  camera.position.set(CENTER.x, CENTER.y + 0.3, distance);
  camera.lookAt(CENTER.x, CENTER.y + 0.3, 0);
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
resize();
loadStage(Math.min(cleared.length, STAGES.length - 1));

const clock = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const frame = Math.min(clock.getDelta(), 0.1);
  if (sim) stepRun(frame);
  renderer.render(scene, camera);
});

