import * as THREE from 'three';
import {
  CPU_LEVELS, DASH_COOLDOWN, DOHYO_HEIGHT, JELLY_HEIGHT, RING_RADIUS, START_GAP, WALL, addVelocity, averageSpacing,
  bindVertices, bodySummary, collideBodies, cpuMove, createBody, createMatch, deformVertices, displayName,
  farthestPointSample, floorAt, guessFacing, hopVelocity, isOut, normalize2, recordRound, roundWinner, stepBody,
  stiffnessFromSoftness, surfaceSamples, toFloatArray, translateBody,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { clayBall, parseModel } from '../shared/models.js';
import { listCharacters, readCharacter } from '../shared/storage.js';

const CLAY_BALL = { segments: [48, 32], roughness: 0.4 };
const PARTICLE_COUNT = 120;
const CLUSTER_SCALE = 2.5;
const STEP = 1 / 120;
const MAX_STEPS = 4;
const HOP_INTERVAL = 0.35;
// これより短く小さい指の動きはタップ（ぶちかまし）
const TAP_TIME = 250;
const TAP_MOVE = 14;
const DRAG_DEADZONE = 12;
const CLAY = 'clay';

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const overlayEl = document.getElementById('overlay');
const callEl = document.getElementById('call');
const modeEl = document.getElementById('mode');
const softnessEl = document.getElementById('softness');
const characterEls = [document.getElementById('left-character'), document.getElementById('right-character')];

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
const LOOK_AT = new THREE.Vector3(0, DOHYO_HEIGHT + 0.4, 0);
const VIEW_DIRECTION = new THREE.Vector3(0, 3.2, 6).normalize();
// 土俵の左右の端と、少し外まで画面に入れる
const VISIBLE_HALF_WIDTH = RING_RADIUS + 0.6;
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 8, 5);
scene.add(hemisphere, sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(WALL * 2, WALL * 2), new THREE.MeshStandardMaterial({ roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const dohyo = new THREE.Mesh(new THREE.CylinderGeometry(RING_RADIUS, RING_RADIUS + 0.25, DOHYO_HEIGHT, 64), new THREE.MeshStandardMaterial({ roughness: 0.95 }));
dohyo.position.y = DOHYO_HEIGHT / 2;
scene.add(dohyo);
// 俵（土俵の縁）と、仕切り線
const tawara = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS - 0.04, 0.05, 8, 96), new THREE.MeshStandardMaterial({ roughness: 0.8 }));
tawara.rotation.x = Math.PI / 2;
tawara.position.y = DOHYO_HEIGHT;
scene.add(tawara);
const lineMaterial = new THREE.MeshBasicMaterial();
for (const x of [-0.35, 0.35]) {
  const line = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.6), lineMaterial);
  line.rotation.x = -Math.PI / 2;
  line.position.set(x, DOHYO_HEIGHT + 0.003, 0);
  scene.add(line);
}

function makeShadow() {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.45, 32), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2;
  scene.add(mesh);
  return mesh;
}

// ---- 力士（ぷるぷるの体） ----
// sides[0] がひだり（あなた）、sides[1] がみぎ（あいて）

const sides = [
  { jelly: null, shadow: makeShadow(), x: -START_GAP, yaw: Math.PI / 2, hopTimer: 0, dashTimer: 0, input: [0, 0], wantDash: false, cpu: null },
  { jelly: null, shadow: makeShadow(), x: START_GAP, yaw: -Math.PI / 2, hopTimer: 0, dashTimer: 0, input: [0, 0], wantDash: false, cpu: null },
];

// メッシュを頂点に焼き込み、高さ JELLY_HEIGHT・正面が相手の方を向くようにそろえ、表面に粒を置いてぷるぷるの体を作る
function prepareJelly(object, facing, yaw) {
  const holder = new THREE.Group();
  holder.add(object);
  holder.rotation.y = facing + yaw;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? JELLY_HEIGHT / Math.max(size.y, size.x * 0.8, size.z * 0.8) : 1;
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
    mesh.frustumCulled = false;
    root.add(mesh);
    meshes.push(mesh);
  });
  if (meshes.length === 0) throw new Error('メッシュがないモデル');
  const samples = surfaceSamples(meshes.map((mesh) => ({
    positions: mesh.geometry.attributes.position.array, index: mesh.geometry.index?.array ?? null,
  })), 3000);
  const particles = Float32Array.from(farthestPointSample(samples, PARTICLE_COUNT).flat());
  const spacing = averageSpacing(particles);
  const body = createBody(particles, spacing * CLUSTER_SCALE);
  const parts = meshes.map((mesh) => {
    const rest = mesh.geometry.attributes.position.array.slice();
    return { mesh, rest, binding: bindVertices(rest, particles) };
  });
  return { root, parts, body, spacing };
}

function disposeJelly(jelly) {
  if (!jelly) return;
  scene.remove(jelly.root);
  jelly.root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.dispose();
    for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose();
  });
}

// 元の形に戻して、仕切り線の後ろに置く
function placeAtStart(side) {
  const { body } = side.jelly;
  body.positions.set(body.rest);
  body.velocities.fill(0);
  body.rotations.forEach((q) => q.splice(0, 4, 0, 0, 0, 1));
  body.pinned.clear();
  translateBody(body, [side.x, DOHYO_HEIGHT + 0.02, 0]);
  side.hopTimer = 0;
  side.dashTimer = 0;
}

let library = [];

async function loadObject(choice, index) {
  const record = library.find((r) => r.id === choice);
  if (!record) {
    const ball = clayBall(CLAY_BALL);
    // あいての粘土の玉は青くする
    if (index === 1) ball.children[0].material.color.set(cssValue('--piece-j'));
    return { object: ball, facing: 0, name: '粘土の玉' };
  }
  const object = await parseModel(record, { stlNormals: true });
  const facing = record.facing ?? guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
  return { object, facing, name: displayName(record.name) };
}

async function setSide(index) {
  const side = sides[index];
  const choice = characterEls[index].value;
  let loaded;
  try {
    loaded = await loadObject(choice, index);
  } catch (error) {
    console.warn(error);
    setStatus('キャラクターを読み込めなかったので、粘土の玉にしました。');
    loaded = await loadObject(CLAY, index);
  }
  if (characterEls[index].value !== choice) return;
  disposeJelly(side.jelly);
  side.jelly = prepareJelly(loaded.object, loaded.facing, side.yaw);
  side.name = loaded.name;
  scene.add(side.jelly.root);
  placeAtStart(side);
}

function fillCharacterSelects(currentId) {
  const options = [[CLAY, '粘土の玉'], ...library.map((r) => [r.id, displayName(r.name)])];
  characterEls.forEach((el) => {
    el.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  });
  // ひだりはいま使っているキャラクター、みぎはそれ以外からひとつ
  const left = library.some((r) => r.id === currentId) ? currentId : CLAY;
  const others = library.filter((r) => r.id !== left);
  characterEls[0].value = left;
  characterEls[1].value = others.length > 0 ? others[Math.floor(Math.random() * others.length)].id : CLAY;
}

async function loadCharacters() {
  let currentId = null;
  try {
    library = await listCharacters();
    const current = await readCharacter();
    currentId = current?.id ?? null;
    // 一覧ができる前に保存したキャラクターしかないとき
    if (current && !current.id) {
      library.push({ ...current, id: 'current' });
      currentId = 'current';
    }
  } catch (error) {
    console.warn(error);
  }
  fillCharacterSelects(currentId);
  await Promise.all([setSide(0), setSide(1)]);
}

// ---- 操作 ----

const isTwoPlayers = () => modeEl.value === 'two';
const pointers = new Map();

function sideForPointer(event) {
  if (!isTwoPlayers()) return 0;
  const rect = renderer.domElement.getBoundingClientRect();
  return event.clientX - rect.left < rect.width / 2 ? 0 : 1;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const side = sideForPointer(event);
  // 同じ側の指は 1 本だけ
  for (const pointer of pointers.values()) if (pointer.side === side) return;
  pointers.set(event.pointerId, { side, x: event.clientX, y: event.clientY, time: performance.now(), moved: 0 });
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.moved = Math.max(pointer.moved, Math.hypot(dx, dy));
  // カメラは手前から見ているので、画面の右が +x、下へなぞると手前（+z）
  sides[pointer.side].input = Math.hypot(dx, dy) > DRAG_DEADZONE ? normalize2([dx, dy]) : [0, 0];
});
function endPointer(event) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  pointers.delete(event.pointerId);
  sides[pointer.side].input = [0, 0];
  if (performance.now() - pointer.time < TAP_TIME && pointer.moved < TAP_MOVE) sides[pointer.side].wantDash = true;
}
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', dash: 'Space' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', dash: 'Enter' },
];
const pressed = new Set();
function keySide(code) {
  const index = KEYS.findIndex((keys) => Object.values(keys).includes(code));
  // 1 人のときは、矢印キーでもひだりを動かせる
  return index === 1 && !isTwoPlayers() ? 0 : index;
}
window.addEventListener('keydown', (event) => {
  const index = keySide(event.code);
  if (index < 0 || event.target.closest?.('select, input')) return;
  event.preventDefault();
  const keys = KEYS.find((set) => Object.values(set).includes(event.code));
  if (event.code === keys.dash && !event.repeat) sides[index].wantDash = true;
  pressed.add(event.code);
});
window.addEventListener('keyup', (event) => pressed.delete(event.code));
window.addEventListener('blur', () => pressed.clear());

function keyboardInput(index) {
  const sets = isTwoPlayers() ? [KEYS[index]] : index === 0 ? KEYS : [];
  let x = 0;
  let z = 0;
  for (const keys of sets) {
    if (pressed.has(keys.left)) x -= 1;
    if (pressed.has(keys.right)) x += 1;
    if (pressed.has(keys.up)) z -= 1;
    if (pressed.has(keys.down)) z += 1;
  }
  return normalize2([x, z]);
}

// ---- 取組の進行 ----
// ready（開始前）→ call（はっけよい）→ fight → decided（勝負あり）→ 次の取組か、over

let state = 'ready';
let match = createMatch();
let stateTime = 0;

function labels() {
  return isTwoPlayers() ? ['ひだり', 'みぎ'] : ['あなた', 'あいて'];
}

function updateHud() {
  const [left, right] = labels();
  document.getElementById('left-score').textContent = `${left} ${'●'.repeat(match.wins[0])}${'○'.repeat(2 - match.wins[0])}`;
  document.getElementById('right-score').textContent = `${right} ${'●'.repeat(match.wins[1])}${'○'.repeat(2 - match.wins[1])}`;
  document.getElementById('round').textContent = `${match.round} 番目`;
}

function showCall(text) {
  callEl.textContent = text;
  callEl.hidden = !text;
}

function startRound() {
  for (const side of sides) {
    if (side.jelly) placeAtStart(side);
    side.input = [0, 0];
    side.wantDash = false;
    side.cpu = null;
  }
  state = 'call';
  stateTime = 0;
  showCall('はっけよい…');
  updateHud();
}

function startMatch() {
  match = createMatch();
  overlayEl.hidden = true;
  startRound();
}

function decide(winner) {
  match = recordRound(match, winner);
  state = 'decided';
  stateTime = 0;
  const [left, right] = labels();
  showCall(`${winner === 0 ? left : right}の勝ち！`);
  updateHud();
}

function finishMatch() {
  state = 'over';
  showCall('');
  const [left, right] = labels();
  const winner = match.winner === 0 ? left : right;
  document.getElementById('overlay-title').textContent = isTwoPlayers()
    ? `${winner}の優勝！`
    : match.winner === 0 ? 'あなたの優勝！' : 'あいての優勝…';
  document.getElementById('overlay-text').textContent = `${match.wins[0]} 勝 ${match.wins[1]} 敗`;
  document.getElementById('start').textContent = 'もう一回';
  overlayEl.hidden = false;
}

function updateState(dt) {
  stateTime += dt;
  if (state === 'call' && stateTime > 1.1) {
    state = 'fight';
    stateTime = 0;
    showCall('のこった！');
  } else if (state === 'fight') {
    if (stateTime > 0.8) showCall('');
    const summaries = sides.map((side) => bodySummary(side.jelly.body.positions));
    const outs = summaries.map(isOut);
    const winner = roundWinner(outs[0], outs[1], ...summaries.map((s) => Math.hypot(s.center[0], s.center[2])));
    if (winner !== null) decide(winner);
  } else if (state === 'decided' && stateTime > 1.8) {
    if (match.winner !== null) finishMatch();
    else startRound();
  }
}

// 指・キー・CPU の入力で跳ねさせる
function drive(index, dt) {
  const side = sides[index];
  const other = sides[1 - index];
  side.hopTimer -= dt;
  side.dashTimer -= dt;
  if (state !== 'fight') {
    side.wantDash = false;
    return;
  }
  const self = bodySummary(side.jelly.body.positions);
  const them = bodySummary(other.jelly.body.positions);
  let dir = side.input;
  if (dir[0] === 0 && dir[1] === 0) dir = keyboardInput(index);
  let dash = side.wantDash;
  if (index === 1 && !isTwoPlayers()) {
    const level = CPU_LEVELS[modeEl.value] ?? CPU_LEVELS.normal;
    side.cpu ??= { timer: 0, move: { dir: [0, 0], dash: false } };
    side.cpu.timer -= dt;
    if (side.cpu.timer <= 0) {
      side.cpu.move = cpuMove([self.center[0], self.center[2]], [them.center[0], them.center[2]], level);
      side.cpu.timer = level.reaction;
    }
    dir = side.cpu.move.dir;
    dash = side.cpu.move.dash;
  }
  const grounded = side.jelly.body.grounded.some(Boolean);
  if (dash && side.dashTimer <= 0 && grounded) {
    // ぶちかましは、なぞっていなければ相手の方へ
    const aim = dir[0] === 0 && dir[1] === 0 ? [them.center[0] - self.center[0], them.center[2] - self.center[2]] : dir;
    const power = index === 1 && !isTwoPlayers() ? (CPU_LEVELS[modeEl.value] ?? CPU_LEVELS.normal).power : 1;
    addVelocity(side.jelly.body, hopVelocity(aim, { dash: true, power }));
    side.dashTimer = DASH_COOLDOWN;
    side.hopTimer = HOP_INTERVAL * 1.5;
    if (side.cpu) side.cpu.move.dash = false;
  } else if ((dir[0] !== 0 || dir[1] !== 0) && side.hopTimer <= 0 && grounded) {
    const power = index === 1 && !isTwoPlayers() ? (CPU_LEVELS[modeEl.value] ?? CPU_LEVELS.normal).power : 1;
    addVelocity(side.jelly.body, hopVelocity(dir, { power }));
    side.hopTimer = HOP_INTERVAL;
  }
  side.wantDash = false;
}

document.getElementById('start').addEventListener('click', startMatch);
characterEls.forEach((el, index) => el.addEventListener('change', async () => {
  await setSide(index);
  if (state !== 'ready' && state !== 'over') startRound();
}));
modeEl.addEventListener('change', () => {
  updateHud();
  if (state !== 'ready') {
    state = 'ready';
    showCall('');
    match = createMatch();
    for (const side of sides) if (side.jelly) placeAtStart(side);
    document.getElementById('overlay-title').textContent = 'ぷるぷる相撲';
    document.getElementById('start').textContent = '取組開始';
    overlayEl.hidden = false;
    updateHud();
  }
});
softnessEl.addEventListener('input', () => {
  document.getElementById('softness-value').textContent = `${softnessEl.value}%`;
});

// ---- 描画 ----

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  ground.material.color.set(cssValue('--bg'));
  dohyo.material.color.set(cssValue('--piece-o'));
  tawara.material.color.set(cssValue('--surface'));
  lineMaterial.color.set(cssValue('--surface'));
  for (const side of sides) side.shadow.material.color.set(cssValue('--text'));
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // 縦長の画面ほど遠くから見て、土俵の左右が切れないようにする
  const distance = Math.max(7, VISIBLE_HALF_WIDTH / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  camera.position.copy(LOOK_AT).addScaledVector(VIEW_DIRECTION, distance);
  camera.lookAt(LOOK_AT);
}

function drawSide(side) {
  const { jelly } = side;
  for (const part of jelly.parts) {
    deformVertices(part.mesh.geometry.attributes.position.array, part.rest, part.binding, jelly.body);
    part.mesh.geometry.attributes.position.needsUpdate = true;
    part.mesh.geometry.computeVertexNormals();
    part.mesh.geometry.computeBoundingSphere();
  }
  const { center, lowest } = bodySummary(jelly.body.positions);
  const floorY = floorAt(center[0], center[2]);
  side.shadow.position.set(center[0], floorY + 0.006, center[2]);
  const lift = Math.max(0, lowest - floorY);
  side.shadow.scale.setScalar(Math.max(0.4, 1 - lift * 0.2));
  side.shadow.material.opacity = Math.max(0.08, 0.3 - lift * 0.08);
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
resize();
applyTheme();
softnessEl.dispatchEvent(new Event('input'));
updateHud();
loadCharacters().then(() => {
  const names = sides.map((side) => side.name);
  setStatus(`ひだり：${names[0]}、みぎ：${names[1]}`);
});

const clock = new THREE.Timer();
let leftover = 0;
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const frame = Math.min(clock.getDelta(), 0.1);
  if (sides[0].jelly && sides[1].jelly) {
    leftover = Math.min(leftover + frame, STEP * MAX_STEPS);
    const options = {
      dt: STEP, stiffness: stiffnessFromSoftness(Number(softnessEl.value)), bounce: 0.25, wall: WALL, floorAt,
    };
    // 粒の間が粗いほうに合わせる。細かいほうに合わせると、粗い体の粒のすき間を相手がすり抜ける
    const distance = Math.max(sides[0].jelly.spacing, sides[1].jelly.spacing) * 1.2;
    while (leftover >= STEP) {
      drive(0, STEP);
      drive(1, STEP);
      for (const side of sides) stepBody(side.jelly.body, options);
      collideBodies(sides[0].jelly.body, sides[1].jelly.body, distance);
      leftover -= STEP;
    }
    sides.forEach(drawSide);
    updateState(frame);
  }
  renderer.render(scene, camera);
});
