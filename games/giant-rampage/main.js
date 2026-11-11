import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  BLOCK_SIZE, CITY_HALF, GAME_SECONDS, STOMP_COOLDOWN, START_HEIGHT, buildingBlocks, cityLayout, clampToCity,
  displayName, formatTime, giantHeight, guessFacing, headingOf, isToppled, joystickVector, keyboardVector,
  moveVelocity, stompVelocity, turnTowards, walkSpeed,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { parseModel } from '../shared/models.js';
import { listCharacters, readCharacter } from '../shared/storage.js';

const STEP = 1 / 60;
const ROBOT = 'robot';
const BEST_KEY = 'mini-games:giant-rampage:best';
const TURN_SPEED = 6;
const CAMERA_TURN_SPEED = 1.6;
const GROW_TIME = 0.8;
const STOMP_TIME = 0.4;
const BUILDING_COLORS = ['--piece-i', '--piece-s', '--piece-o', '--piece-t'];

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const overlayEl = document.getElementById('overlay');
const stickEl = document.getElementById('stick');
const knobEl = document.getElementById('knob');
const stompEl = document.getElementById('stomp');
const growEl = document.getElementById('grow');
const characterEl = document.getElementById('character');

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.4);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(10, 30, 15);
scene.add(hemisphere, sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(CITY_HALF * 4, CITY_HALF * 4), new THREE.MeshStandardMaterial({ roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
let grid = null;

// ---- 物理の世界とビル ----

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.defaultContactMaterial.friction = 0.6;
world.defaultContactMaterial.restitution = 0.05;
const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

const blockGeometry = new THREE.BoxGeometry(BLOCK_SIZE * 0.98, BLOCK_SIZE * 0.98, BLOCK_SIZE * 0.98);
const blockShape = new CANNON.Box(new CANNON.Vec3(BLOCK_SIZE / 2, BLOCK_SIZE / 2, BLOCK_SIZE / 2));
const buildingMaterials = BUILDING_COLORS.map(() => new THREE.MeshStandardMaterial({ roughness: 0.7 }));
// blocks は { body, start, toppled, mesh, index }
let blocks = [];
let blockMeshes = [];

function buildCity() {
  for (const block of blocks) world.removeBody(block.body);
  for (const mesh of blockMeshes) {
    scene.remove(mesh);
    mesh.dispose();
  }
  blocks = [];
  const groups = BUILDING_COLORS.map(() => []);
  for (const building of cityLayout()) {
    for (const start of buildingBlocks(building)) {
      const body = new CANNON.Body({ mass: 1, shape: blockShape, sleepSpeedLimit: 0.3, sleepTimeLimit: 0.5 });
      body.position.set(...start);
      world.addBody(body);
      // 最初は眠らせておく（何百個もの箱を、触られるまで計算しない）
      body.sleep();
      const block = { body, start, toppled: false, color: building.color };
      groups[building.color].push(block);
      blocks.push(block);
    }
  }
  blockMeshes = groups.map((group, color) => {
    const mesh = new THREE.InstancedMesh(blockGeometry, buildingMaterials[color], Math.max(1, group.length));
    mesh.count = group.length;
    group.forEach((block, i) => {
      block.mesh = mesh;
      block.index = i;
    });
    scene.add(mesh);
    return mesh;
  });
  syncBlocks(true);
}

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const unit = new THREE.Vector3(1, 1, 1);

function syncBlocks(all = false) {
  const touched = new Set();
  for (const block of blocks) {
    if (!all && block.body.sleepState === CANNON.Body.SLEEPING && block.synced) continue;
    position.copy(block.body.position);
    quaternion.copy(block.body.quaternion);
    block.mesh.setMatrixAt(block.index, matrix.compose(position, quaternion, unit));
    block.synced = block.body.sleepState === CANNON.Body.SLEEPING;
    touched.add(block.mesh);
  }
  for (const mesh of touched) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
}

// ---- 巨人 ----

// 巨人の体は、決めた速さで動く（ぶつかっても押し返されない）箱。ビルの箱を押しのける
// 眠ると、止まっている箱とのぶつかりが調べられなくなるので、眠らせない
const giantBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, allowSleep: false });
world.addBody(giantBody);
const giant = {
  wrapper: new THREE.Group(),
  model: null,
  facing: 0,
  heading: 0,
  height: START_HEIGHT,
  shownHeight: START_HEIGHT,
  growFrom: START_HEIGHT,
  growTime: GROW_TIME,
  stompTime: STOMP_TIME,
  stompCooldown: 0,
  walkPhase: 0,
  // 高さ 1 にしたときの横幅と奥行き
  aspect: [0.5, 0.35],
};
scene.add(giant.wrapper);

function defaultRobot() {
  const group = new THREE.Group();
  const material = (name) => new THREE.MeshStandardMaterial({ color: cssValue(name), roughness: 0.45, metalness: 0.2 });
  const part = (size, at, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(name));
    mesh.position.set(...at);
    group.add(mesh);
  };
  part([0.8, 0.8, 0.5], [0, 0.15, 0], '--piece-j');
  part([0.45, 0.4, 0.45], [0, 0.8, 0], '--piece-i');
  part([0.36, 0.08, 0.05], [0, 0.82, 0.24], '--piece-o');
  part([0.25, 0.75, 0.3], [-0.2, -0.62, 0], '--piece-t');
  part([0.25, 0.75, 0.3], [0.2, -0.62, 0], '--piece-t');
  part([0.2, 0.65, 0.25], [-0.52, 0.12, 0], '--piece-j');
  part([0.2, 0.65, 0.25], [0.52, 0.12, 0], '--piece-j');
  return group;
}

// モデルを高さ 1・足元が原点・正面が +z にそろえる
function fitModel(object, facing) {
  const holder = new THREE.Group();
  holder.add(object);
  holder.rotation.y = facing;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? 1 / size.y : 1;
  holder.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  holder.scale.setScalar(scale);
  const outer = new THREE.Group();
  outer.add(holder);
  return { model: outer, aspect: [Math.max(0.35, size.x * scale), Math.max(0.3, size.z * scale)] };
}

function setGiantModel(object, facing) {
  if (giant.model) {
    giant.wrapper.remove(giant.model);
    giant.model.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose();
    });
  }
  const fitted = fitModel(object, facing);
  giant.model = fitted.model;
  // 横に長い向きのモデルでも当たりの箱が大きくなりすぎないようにする
  giant.aspect = fitted.aspect.map((v) => Math.min(v, 0.8));
  giant.wrapper.add(giant.model);
  setGiantSize(giant.height);
}

function setGiantSize(height) {
  giant.shownHeight = height;
  giant.model.scale.setScalar(height);
  const half = new CANNON.Vec3(giant.aspect[0] * height / 2, height / 2, giant.aspect[1] * height / 2);
  while (giantBody.shapes.length > 0) giantBody.removeShape(giantBody.shapes[0]);
  giantBody.addShape(new CANNON.Box(half));
  giantBody.position.y = height / 2;
}

let library = [];

async function loadGiant() {
  const choice = characterEl.value;
  const record = library.find((r) => r.id === choice);
  let object = null;
  let facing = 0;
  if (record) {
    try {
      object = await parseModel(record, { stlNormals: true });
      facing = record.facing ?? guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
    } catch (error) {
      console.warn(error);
      setStatus('キャラクターを読み込めなかったので、仮のロボにしました。');
    }
  }
  if (characterEl.value !== choice) return;
  setGiantModel(object ?? defaultRobot(), object ? facing : 0);
  setStatus(`${record && object ? displayName(record.name) : '仮のロボ'}が街にやってきた！`);
}

async function loadCharacters() {
  let currentId = null;
  try {
    library = await listCharacters();
    const current = await readCharacter();
    currentId = current?.id ?? null;
    if (current && !current.id) {
      library.push({ ...current, id: 'current' });
      currentId = 'current';
    }
  } catch (error) {
    console.warn(error);
  }
  characterEl.replaceChildren(new Option('仮のロボ', ROBOT), ...library.map((r) => new Option(displayName(r.name), r.id)));
  characterEl.value = library.some((r) => r.id === currentId) ? currentId : ROBOT;
  await loadGiant();
}

// ---- 入力 ----

const keys = new Set();
let stick = { x: 0, y: 0, magnitude: 0 };
let stickPointer = null;

function currentInput() {
  if (stick.magnitude > 0) return stick;
  return keyboardVector({
    up: keys.has('w') || keys.has('arrowup'),
    down: keys.has('s') || keys.has('arrowdown'),
    left: keys.has('a') || keys.has('arrowleft'),
    right: keys.has('d') || keys.has('arrowright'),
  });
}

function updateStick(event) {
  const rect = stickEl.getBoundingClientRect();
  const radius = rect.width / 2;
  const dx = event.clientX - (rect.left + radius);
  const dy = event.clientY - (rect.top + radius);
  stick = joystickVector(dx, dy, radius);
  const length = Math.min(Math.hypot(dx, dy), radius);
  const angle = Math.atan2(dy, dx);
  knobEl.style.transform = `translate(${Math.cos(angle) * length}px, ${Math.sin(angle) * length}px)`;
}

stickEl.addEventListener('pointerdown', (event) => {
  stickPointer = event.pointerId;
  stickEl.setPointerCapture(event.pointerId);
  updateStick(event);
});
stickEl.addEventListener('pointermove', (event) => {
  if (event.pointerId === stickPointer) updateStick(event);
});
for (const type of ['pointerup', 'pointercancel']) {
  stickEl.addEventListener(type, (event) => {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null;
    stick = { x: 0, y: 0, magnitude: 0 };
    knobEl.style.transform = '';
  });
}
stompEl.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  stomp();
});
window.addEventListener('keydown', (event) => {
  if (event.target.closest?.('select, input')) return;
  const key = event.key.toLowerCase();
  if (key === ' ') {
    event.preventDefault();
    if (!event.repeat) stomp();
    return;
  }
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
    event.preventDefault();
    keys.add(key);
  }
});
window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

// ---- ゲームの進行 ----

let state = 'ready';
let timeLeft = GAME_SECONDS;
let knocked = 0;
let best = loadBest();
let cameraYaw = 0;
let shake = 0;
let growMessageTimer = 0;

function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    // 保存できなくても遊べる
  }
}

function updateHud() {
  document.getElementById('time').textContent = formatTime(timeLeft);
  document.getElementById('score').textContent = `${knocked} 個`;
  document.getElementById('size').textContent = `身長 ${giant.height}`;
  document.getElementById('best').textContent = `ベスト ${best}`;
}

function resetGame() {
  buildCity();
  knocked = 0;
  timeLeft = GAME_SECONDS;
  giant.height = START_HEIGHT;
  giant.growTime = GROW_TIME;
  giant.stompTime = STOMP_TIME;
  giant.stompCooldown = 0;
  giant.heading = 0;
  cameraYaw = 0;
  giantBody.position.set(0, START_HEIGHT / 2, 0);
  giantBody.velocity.set(0, 0, 0);
  if (giant.model) setGiantSize(START_HEIGHT);
  updateHud();
}

function startGame() {
  resetGame();
  state = 'playing';
  overlayEl.hidden = true;
}

function endGame() {
  state = 'over';
  giantBody.velocity.set(0, 0, 0);
  const isBest = knocked > best;
  if (isBest) {
    best = knocked;
    saveBest();
  }
  document.getElementById('overlay-title').textContent = 'タイムアップ！';
  document.getElementById('overlay-text').textContent = `${knocked} 個こわした（身長 ${giant.height}）${isBest ? '　ベスト更新！' : ''}`;
  document.getElementById('start').textContent = 'もう一回';
  overlayEl.hidden = false;
  updateHud();
}

// 足踏み：少し跳ねて、着地したときにまわりの箱を揺らす
function stomp() {
  if (state !== 'playing' || giant.stompCooldown > 0) return;
  giant.stompTime = 0;
  giant.stompCooldown = STOMP_COOLDOWN;
}

function landStomp() {
  const center = [giantBody.position.x, 0, giantBody.position.z];
  const radius = giant.height * 1.1;
  const power = 2.5 + giant.height * 0.7;
  for (const block of blocks) {
    const at = block.body.position;
    const velocity = stompVelocity([at.x, at.y, at.z], center, radius, power);
    if (!velocity) continue;
    block.body.wakeUp();
    block.body.velocity.set(block.body.velocity.x + velocity[0], block.body.velocity.y + velocity[1], block.body.velocity.z + velocity[2]);
    block.body.angularVelocity.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
  }
  shake = 0.35;
}

function countToppled() {
  for (const block of blocks) {
    if (block.toppled || block.body.sleepState === CANNON.Body.SLEEPING) continue;
    const p = block.body.position;
    const q = block.body.quaternion;
    if (isToppled(block.start, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w])) {
      block.toppled = true;
      knocked++;
    }
  }
  const next = giantHeight(knocked);
  if (next > giant.height) {
    giant.growFrom = giant.shownHeight;
    giant.height = next;
    giant.growTime = 0;
    growEl.textContent = `巨大化！ 身長 ${next}`;
    growMessageTimer = 1.5;
  }
}

function updateGiant(dt) {
  const input = state === 'playing' ? currentInput() : { x: 0, y: 0, magnitude: 0 };
  // 大きくなる途中は、少しずつ伸ばす
  if (giant.growTime < GROW_TIME) {
    giant.growTime = Math.min(GROW_TIME, giant.growTime + dt);
    const t = giant.growTime / GROW_TIME;
    setGiantSize(giant.growFrom + (giant.height - giant.growFrom) * (1 - (1 - t) ** 3));
  }
  const speed = walkSpeed(giant.shownHeight);
  const [vx, vz] = input.magnitude > 0 ? moveVelocity(input, cameraYaw, speed) : [0, 0];
  giantBody.velocity.set(vx, 0, vz);
  if (input.magnitude > 0) {
    giant.heading = turnTowards(giant.heading, headingOf(vx, vz), TURN_SPEED * dt);
    // カメラは、歩く向きへゆっくり回り込む
    if (input.y >= -0.3) cameraYaw = turnTowards(cameraYaw, giant.heading, CAMERA_TURN_SPEED * dt * input.magnitude);
    giant.walkPhase += dt * speed * 1.4 / giant.shownHeight * Math.PI;
  }
  giantBody.quaternion.setFromEuler(0, giant.heading, 0);
  // 足踏み
  giant.stompCooldown = Math.max(0, giant.stompCooldown - dt);
  stompEl.disabled = giant.stompCooldown > 0;
  let lift = 0;
  if (giant.stompTime < STOMP_TIME) {
    const before = giant.stompTime;
    giant.stompTime = Math.min(STOMP_TIME, giant.stompTime + dt);
    lift = Math.sin((giant.stompTime / STOMP_TIME) * Math.PI) * giant.shownHeight * 0.15;
    if (before < STOMP_TIME && giant.stompTime >= STOMP_TIME) landStomp();
  }
  const bob = input.magnitude > 0 ? Math.abs(Math.sin(giant.walkPhase)) * giant.shownHeight * 0.03 : 0;
  giant.wrapper.position.set(giantBody.position.x, lift + bob, giantBody.position.z);
  giant.wrapper.rotation.y = giant.heading;
  // 歩くと左右に少し揺れる
  giant.wrapper.rotation.z = input.magnitude > 0 ? Math.sin(giant.walkPhase) * 0.05 : 0;
}

function afterStep() {
  // 街の外へ出ないように戻す
  const [x, z] = clampToCity([giantBody.position.x, giantBody.position.z], giant.shownHeight * 0.3);
  giantBody.position.x = x;
  giantBody.position.z = z;
  giantBody.position.y = giant.shownHeight / 2;
}

document.getElementById('start').addEventListener('click', startGame);
characterEl.addEventListener('change', loadGiant);

// ---- 描画 ----

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  ground.material.color.set(cssValue('--bg'));
  buildingMaterials.forEach((m, i) => m.color.set(cssValue(BUILDING_COLORS[i])));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(CITY_HALF * 2, CITY_HALF / 4 * 2, cssValue('--muted'), cssValue('--border'));
  grid.position.y = 0.01;
  scene.add(grid);
}

function updateCamera(dt) {
  const h = giant.shownHeight;
  const behind = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
  // 巨人の少し前を見る。大きくなるほど遠く高くから見て、巨人で前が隠れないようにする
  const target = new THREE.Vector3(giantBody.position.x, h * 0.5, giantBody.position.z).addScaledVector(behind, -h * 0.6);
  camera.position.copy(target).addScaledVector(behind, h * 2.6 + 3).add(new THREE.Vector3(0, h * 1.3 + 2, 0));
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    camera.position.y += Math.sin(shake * 80) * shake * 0.6;
  }
  camera.lookAt(target);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
resize();
applyTheme();
resetGame();
loadCharacters();

const clock = new THREE.Timer();
let leftover = 0;
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const frame = Math.min(clock.getDelta(), 0.1);
  if (giant.model) {
    leftover = Math.min(leftover + frame, STEP * 3);
    while (leftover >= STEP) {
      updateGiant(STEP);
      world.step(STEP);
      afterStep();
      leftover -= STEP;
    }
    syncBlocks();
    if (state === 'playing') {
      countToppled();
      timeLeft -= frame;
      if (timeLeft <= 0) endGame();
      updateHud();
    }
  }
  growMessageTimer = Math.max(0, growMessageTimer - frame);
  growEl.style.opacity = String(Math.min(1, growMessageTimer * 2));
  updateCamera(frame);
  renderer.render(scene, camera);
});
