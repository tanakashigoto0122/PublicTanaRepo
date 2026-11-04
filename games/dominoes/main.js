import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';
import {
  DOMINO_SIZE, MAX_DOMINOES, heartPath, isFallen, placeAlongPath, removeTooClose, spiralPath, summary,
  zigzagPath,
} from './logic.js';
import { fitDistance } from '../model-viewer/logic.js';

const STEP = 1 / 60;
const DOMINO_MASS = 0.15;
// 押すときに、ドミノの上のほうへ前向きに加える力積
const PUSH_IMPULSE = 0.1;
// なぞった点をこれより細かくは記録しない（m）
const DRAW_RESOLUTION = 0.05;
// 床の上でドミノを置ける範囲（中心からの距離）
const AREA = 25;
// お手本は、どの形でも最後まで倒れることを確かめた間隔で並べる
const SAMPLE_SPACING = 0.45;
// 最後に倒れてからこれだけ何も倒れなければ、結果を出す（物理の世界の秒。画面が重くて遅れても数え方は変わらない）
const SETTLE_SECONDS = 1.5;
const PALETTE = ['--piece-z', '--piece-l', '--piece-o', '--piece-s', '--piece-i', '--piece-j', '--piece-t'];
const SAMPLES = { spiral: spiralPath, heart: heartPath, zigzag: zigzagPath };
const HINTS = {
  draw: '床を 1 本指でなぞるとドミノが並ぶ。2 本指で拡大・移動。',
  push: 'ドミノをタップすると、その向きに倒れる。ドラッグで視点が回る。',
  erase: 'ドミノをタップすると消える。ドラッグで視点が回る。',
};

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const countsEl = document.getElementById('counts');
const hintEl = document.getElementById('hint');
const spacingEl = document.getElementById('spacing');
const modeButtons = [...document.querySelectorAll('[data-mode]')];

// 色は style.css の CSS 変数から読む（ダークモードの切り替えにも追従する）
function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
viewerEl.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);

const hemisphere = new THREE.HemisphereLight(0xffffff, 0x666666, 1.2);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(6, 14, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 50 });
scene.add(hemisphere, sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(AREA * 2, AREA * 2), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = null;

// なぞっている途中の線。点の数だけ表示を切り替えるよう、入れ物は最初に最大の大きさで作っておく
const MAX_STROKE_POINTS = 4000;
const strokePositions = new Float32Array(MAX_STROKE_POINTS * 3);
const strokeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
strokeLine.geometry.setAttribute('position', new THREE.BufferAttribute(strokePositions, 3));
strokeLine.geometry.setDrawRange(0, 0);
strokeLine.frustumCulled = false;
scene.add(strokeLine);

const dominoGeometry = new THREE.BoxGeometry(...DOMINO_SIZE);
const dominoMaterials = PALETTE.map(() => new THREE.MeshStandardMaterial({ roughness: 0.45 }));

// ---- 物理 ----

const world = new CANNON.World();
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 20;
world.gravity.set(0, -9.82, 0);
// 止まっているドミノは計算を休ませる（たくさん並べても重くならないように）
world.allowSleep = true;

// ドミノどうしの摩擦は 0 にする。試したところ、この物理エンジンではドミノどうしに少しでも摩擦があると、
// 倒れかけたドミノが次のドミノにもたれかかったまま止まり、連鎖が途中で切れた。
// 床との摩擦は、倒れるときに根元が滑らない程度にしておく。
const floorMaterial = new CANNON.Material('floor');
const dominoMaterial = new CANNON.Material('domino');
world.addContactMaterial(new CANNON.ContactMaterial(floorMaterial, dominoMaterial, { friction: 0.6, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(dominoMaterial, dominoMaterial, { friction: 0, restitution: 0 }));

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: floorMaterial });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);
const dominoShape = new CANNON.Box(new CANNON.Vec3(...DOMINO_SIZE.map((v) => v / 2)));

// ドミノは { body, mesh, placement, line }。placement は置いたときの位置と向き（起こすときに使う）
const dominoes = [];
// なぞった線ごとのドミノ。1 本もどすときに使う
const lines = [];
let mode = 'draw';
// 倒し始めてからの記録
let run = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function fallenCount() {
  return dominoes.filter((d) => isFallen(d.body.quaternion.toArray())).length;
}

function updateCounts() {
  countsEl.textContent = `ドミノ ${dominoes.length} 個（最大 ${MAX_DOMINOES} 個）`;
}

function addDomino(placement, colorIndex, line) {
  const [x, z] = placement.position;
  const body = new CANNON.Body({
    mass: DOMINO_MASS,
    shape: dominoShape,
    material: dominoMaterial,
    position: new CANNON.Vec3(x, DOMINO_SIZE[1] / 2, z),
    sleepSpeedLimit: 0.05,
    sleepTimeLimit: 1,
  });
  body.quaternion.setFromEuler(0, placement.yaw, 0);
  const mesh = new THREE.Mesh(dominoGeometry, dominoMaterials[colorIndex % dominoMaterials.length]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  world.addBody(body);
  scene.add(mesh);
  const domino = { body, mesh, placement, line };
  mesh.userData.domino = domino;
  dominoes.push(domino);
  syncMesh(domino);
  return domino;
}

function removeDomino(domino) {
  world.removeBody(domino.body);
  scene.remove(domino.mesh);
  dominoes.splice(dominoes.indexOf(domino), 1);
  const line = lines.find((l) => l.includes(domino));
  if (line) line.splice(line.indexOf(domino), 1);
}

// なぞった線（[x, z] の配列）に沿ってドミノを並べる。並べた数を返す
function placeLine(path, spacing) {
  const existing = dominoes.map((d) => d.placement);
  // ほかの線のドミノと重ならないように、ドミノの幅くらいは離す
  let placements = removeTooClose(placeAlongPath(path, spacing), existing, DOMINO_SIZE[0]);
  const room = MAX_DOMINOES - dominoes.length;
  const truncated = placements.length > room;
  placements = placements.slice(0, room);
  if (placements.length === 0) {
    setStatus(room === 0 ? `ドミノは ${MAX_DOMINOES} 個までです。` : 'ここには並べられません（短すぎるか、ほかのドミノと重なっています）。');
    return 0;
  }
  const line = [];
  // 4 個ずつ色を変えて、虹色のグラデーションにする
  placements.forEach((placement, i) => line.push(addDomino(placement, Math.floor(i / 4), line)));
  lines.push(line);
  run = null;
  updateCounts();
  setStatus(truncated ? `ドミノは ${MAX_DOMINOES} 個までなので、途中までにしました。` : '');
  return placements.length;
}

function clearAll() {
  for (const domino of [...dominoes]) removeDomino(domino);
  lines.length = 0;
  run = null;
  updateCounts();
}

// ドミノの上のほうを、ドミノが向いている向き（進む向き）へ押す
function push(domino) {
  const { body } = domino;
  const forward = body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
  const top = body.quaternion.vmult(new CANNON.Vec3(0, DOMINO_SIZE[1] * 0.4, 0));
  body.wakeUp();
  body.applyImpulse(forward.scale(PUSH_IMPULSE), top);
  if (!run) run = { start: world.time, lastFall: world.time, lastCount: fallenCount(), done: false };
  setStatus('倒れていく…');
}

function topple() {
  const starts = lines.map((line) => line[0]).filter((d) => d && !isFallen(d.body.quaternion.toArray()));
  if (starts.length === 0) {
    setStatus(dominoes.length === 0 ? 'まず床をなぞってドミノを並べてね。' : '倒せるドミノがありません。「起こす」で並べ直せます。');
    return;
  }
  for (const domino of starts) push(domino);
}

function resetAll() {
  for (const { body, placement } of dominoes) {
    const [x, z] = placement.position;
    body.position.set(x, DOMINO_SIZE[1] / 2, z);
    body.quaternion.setFromEuler(0, placement.yaw, 0);
    body.velocity.setZero();
    body.angularVelocity.setZero();
    body.sleep();
  }
  run = null;
  setStatus(dominoes.length > 0 ? '起こしました。' : '');
}

// 倒れていく様子を見て、全部止まったら結果を出す
function watchRun() {
  if (!run || run.done) return;
  const now = world.time;
  const count = fallenCount();
  if (count > run.lastCount) {
    run.lastCount = count;
    run.lastFall = now;
    setStatus(`倒れていく… ${count} / ${dominoes.length}`);
  }
  if (now - run.lastFall > SETTLE_SECONDS) {
    run.done = true;
    const seconds = run.lastCount > 0 ? run.lastFall - run.start : null;
    setStatus(summary(count, dominoes.length, seconds));
  }
}

function syncMesh({ body, mesh }) {
  mesh.position.copy(body.position);
  mesh.quaternion.copy(body.quaternion);
}

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  ground.material.color.set(cssValue('--bg'));
  strokeLine.material.color.set(cssValue('--accent'));
  PALETTE.forEach((name, i) => dominoMaterials[i].color.set(cssValue(name)));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(AREA * 2, AREA * 2, cssValue('--muted'), cssValue('--border'));
  grid.position.y = 0.002;
  scene.add(grid);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// ---- 入力 ----

const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function castRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  ), camera);
}

function floorPoint(event) {
  castRay(event);
  const point = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(floorPlane, point)) return null;
  if (Math.abs(point.x) > AREA || Math.abs(point.z) > AREA) return null;
  return [point.x, point.z];
}

function pickDomino(event) {
  castRay(event);
  const [hit] = raycaster.intersectObjects(dominoes.map((d) => d.mesh), false);
  return hit ? hit.object.userData.domino : null;
}

function updateStroke(path) {
  path.forEach(([x, z], i) => strokePositions.set([x, 0.02, z], i * 3));
  strokeLine.geometry.setDrawRange(0, path.length);
  strokeLine.geometry.attributes.position.needsUpdate = true;
}

let stroke = null;
let tap = null;
const activePointers = new Set();

// OrbitControls より先に登録する
renderer.domElement.addEventListener('pointerdown', (event) => {
  activePointers.add(event.pointerId);
  if (activePointers.size > 1) {
    // 2 本指は拡大・移動に使うので、なぞるのをやめる
    stroke = null;
    tap = null;
    updateStroke([]);
    return;
  }
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (mode === 'draw') {
    const point = floorPoint(event);
    if (!point) return;
    renderer.domElement.setPointerCapture(event.pointerId);
    stroke = [point];
  } else {
    tap = { x: event.clientX, y: event.clientY };
  }
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!stroke) return;
  const point = floorPoint(event);
  const last = stroke[stroke.length - 1];
  if (!point || stroke.length >= MAX_STROKE_POINTS) return;
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < DRAW_RESOLUTION) return;
  stroke.push(point);
  updateStroke(stroke);
});
function onPointerEnd(event) {
  activePointers.delete(event.pointerId);
  if (stroke && event.type === 'pointerup') placeLine(stroke, Number(spacingEl.value));
  stroke = null;
  updateStroke([]);
  if (tap && event.type === 'pointerup' && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 6) {
    const domino = pickDomino(event);
    if (domino && mode === 'push') push(domino);
    if (domino && mode === 'erase') {
      removeDomino(domino);
      run = null;
      updateCounts();
    }
  }
  tap = null;
}
renderer.domElement.addEventListener('pointerup', onPointerEnd);
renderer.domElement.addEventListener('pointercancel', onPointerEnd);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI / 2 - 0.05;

// 並んでいるドミノが全部画面に入る距離から、斜め上に見下ろす
function resetView() {
  const radius = Math.max(4, ...dominoes.map((d) => Math.hypot(...d.placement.position) + DOMINO_SIZE[1]));
  const distance = fitDistance(radius, camera.fov, camera.aspect, 1);
  camera.position.set(0, 11, 10).setLength(distance);
  orbit.target.set(0, 0, 0);
  orbit.update();
}

function setMode(next) {
  mode = next;
  // 描くときは 1 本指で視点が回らないようにする（2 本指の拡大・移動はそのまま）
  orbit.enableRotate = next !== 'draw';
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === next));
  hintEl.textContent = HINTS[next];
}

function placeSample(name) {
  clearAll();
  placeLine(SAMPLES[name](), SAMPLE_SPACING);
  resetView();
  setStatus(`お手本（${dominoes.length} 個）を並べました。「倒す」を押してね。`);
}

function updateSpacingLabel() {
  document.getElementById('spacing-value').textContent = `${Number(spacingEl.value).toFixed(2)}（高さの ${Math.round(spacingEl.value * 100)}%）`;
}

document.getElementById('topple').addEventListener('click', topple);
document.getElementById('reset').addEventListener('click', resetAll);
document.getElementById('undo').addEventListener('click', () => {
  const line = lines.pop();
  if (!line) return setStatus('もどす線がありません。');
  for (const domino of [...line]) removeDomino(domino);
  run = null;
  updateCounts();
  setStatus('');
});
document.getElementById('reset-view').addEventListener('click', resetView);
document.getElementById('clear').addEventListener('click', () => {
  clearAll();
  setStatus('');
});
document.getElementById('place-sample').addEventListener('click', () => placeSample(document.getElementById('sample').value));
for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
spacingEl.addEventListener('input', updateSpacingLabel);

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

resize();
applyTheme();
setMode('draw');
updateSpacingLabel();
placeSample('spiral');
renderer.setAnimationLoop(() => {
  world.fixedStep(STEP, 5);
  for (const domino of dominoes) syncMesh(domino);
  watchRun();
  orbit.update();
  renderer.render(scene, camera);
});
