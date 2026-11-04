import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as CANNON from 'cannon-es';
import {
  ARENA_HALF, CHARACTER_HEIGHT, CRATE_SIZE, GAME_SECONDS, characterScale, detectFormat, finalScore, formatTime,
  guessFacing, headingOf, isKnocked, joystickVector, keyboardVector, moveVelocity, towerLayout, turnTowards,
  wrapAngle,
} from './logic.js';

const STEP = 1 / 60;
const MOVE_SPEED = 6;
const TURN_SPEED = 10;
// カメラがメカの向きに追いつく速さ（ラジアン/秒）
const CAMERA_TURN_SPEED = 2.2;
const JUMP_SPEED = 7;
const SHOT_SPEED = 30;
const SHOT_INTERVAL = 0.18;
const SHOT_LIFETIME = 1.5;
const PLAYER_MASS = 8;
const BEST_KEY = 'mini-games:mecha-blaster:best';
const DB_NAME = 'mini-games-mecha-blaster';
const DB_STORE = 'character';
const PALETTE = ['--piece-z', '--piece-l', '--piece-o', '--piece-s', '--piece-i', '--piece-j', '--piece-t'];

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const timeEl = document.getElementById('time');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const overlayEl = document.getElementById('overlay');
const stickEl = document.getElementById('stick');
const knobEl = document.getElementById('knob');
const characterNameEl = document.getElementById('character-name');

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
viewerEl.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x666666, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(8, 16, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -ARENA_HALF - 2, right: ARENA_HALF + 2, top: ARENA_HALF + 2, bottom: -ARENA_HALF - 2, near: 1, far: 50 });
scene.add(hemisphere, sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = null;
const wallMaterial = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.35 });
const crateGeometry = new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
const crateMaterials = PALETTE.map(() => new THREE.MeshStandardMaterial({ roughness: 0.5 }));
const knockedMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8 });
// カメラとメカの間に入った箱は透かして、メカが隠れないようにする
const seeThrough = (material) => Object.assign(material.clone(), { transparent: true, opacity: 0.25, depthWrite: false });
const crateGhosts = crateMaterials.map(seeThrough);
const knockedGhost = seeThrough(knockedMaterial);
const shotGeometry = new THREE.SphereGeometry(0.16, 16, 12);
const shotMaterial = new THREE.MeshBasicMaterial();

// メカの見た目を入れる入れ物。中身（キャラクター）は差し替えられる
const avatar = new THREE.Group();
const avatarPose = new THREE.Group();
avatar.add(avatarPose);
scene.add(avatar);
let character = null;
// 撃ったときに銃口を光らせる
const muzzleFlash = new THREE.PointLight(0xffffff, 0, 6);
muzzleFlash.position.set(0, 0.2, 0.8);
avatar.add(muzzleFlash);

// ---- 物理 ----

const world = new CANNON.World();
world.gravity.set(0, -9.82, 0);
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 15;
world.defaultContactMaterial.friction = 0.4;
world.defaultContactMaterial.restitution = 0.05;
const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

// アリーナのまわりの壁（物は外へ出ないが、見た目は半透明にして中が見えるようにする）
for (const [x, z, w, d] of [[0, ARENA_HALF, ARENA_HALF * 2, 0.4], [0, -ARENA_HALF, ARENA_HALF * 2, 0.4], [ARENA_HALF, 0, 0.4, ARENA_HALF * 2], [-ARENA_HALF, 0, 0.4, ARENA_HALF * 2]]) {
  const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(w / 2, 1, d / 2)), position: new CANNON.Vec3(x, 1, z) });
  world.addBody(body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 2, d), wallMaterial);
  mesh.position.set(x, 1, z);
  scene.add(mesh);
}

// メカの体。倒れないように回転を止め、横の動きは毎回の入力で決める
const playerBody = new CANNON.Body({
  mass: PLAYER_MASS,
  shape: new CANNON.Box(new CANNON.Vec3(0.4, CHARACTER_HEIGHT / 2, 0.4)),
  position: new CANNON.Vec3(0, CHARACTER_HEIGHT / 2, 0),
  fixedRotation: true,
});
// 足元を調べる光線がメカ自身に当たらないよう、メカだけ別の当たり判定グループにする
playerBody.collisionFilterGroup = 2;
world.addBody(playerBody);

// 箱は { body, mesh, start, knocked }、弾は { body, mesh, born }
let crates = [];
let shots = [];
let playerYaw = 0;
let cameraYaw = 0;
let state = 'ready';
let timeLeft = GAME_SECONDS;
let knockedCount = 0;
let lastShot = -Infinity;
let best = loadBest();
let walkPhase = 0;
let recoil = 0;

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

function clearCrates() {
  for (const crate of crates) {
    world.removeBody(crate.body);
    scene.remove(crate.mesh);
  }
  crates = [];
}

function buildCrates() {
  clearCrates();
  towerLayout().forEach(([x, y, z], i) => {
    const body = new CANNON.Body({
      mass: 1,
      shape: new CANNON.Box(new CANNON.Vec3(CRATE_SIZE / 2, CRATE_SIZE / 2, CRATE_SIZE / 2)),
      position: new CANNON.Vec3(x, y, z),
    });
    world.addBody(body);
    const color = i % crateMaterials.length;
    const mesh = new THREE.Mesh(crateGeometry, crateMaterials[color]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    crates.push({ body, mesh, start: [x, y, z], knocked: false, material: crateMaterials[color], ghost: crateGhosts[color] });
  });
  knockedCount = 0;
}

function removeShot(shot) {
  world.removeBody(shot.body);
  scene.remove(shot.mesh);
}

function fire() {
  if (state !== 'playing' || world.time - lastShot < SHOT_INTERVAL) return;
  lastShot = world.time;
  const forward = new CANNON.Vec3(Math.sin(playerYaw), 0, Math.cos(playerYaw));
  const origin = playerBody.position.vadd(forward.scale(0.9)).vadd(new CANNON.Vec3(0, 0.2, 0));
  const body = new CANNON.Body({ mass: 2, shape: new CANNON.Sphere(0.16), position: origin });
  body.velocity.copy(forward.scale(SHOT_SPEED));
  // 弾はまっすぐ飛ぶように、重力の影響を打ち消す
  body.addEventListener('collide', () => { body.userData.hit = true; });
  body.userData = { hit: false };
  world.addBody(body);
  const mesh = new THREE.Mesh(shotGeometry, shotMaterial);
  scene.add(mesh);
  shots.push({ body, mesh, born: world.time });
  muzzleFlash.intensity = 12;
  recoil = 1;
}

function grounded() {
  const from = playerBody.position;
  const to = new CANNON.Vec3(from.x, from.y - CHARACTER_HEIGHT / 2 - 0.08, from.z);
  const result = new CANNON.RaycastResult();
  world.raycastClosest(from, to, { skipBackfaces: true, collisionFilterMask: 1 }, result);
  return result.hasHit;
}

function jump() {
  if (state !== 'playing' || !grounded()) return;
  playerBody.velocity.y = JUMP_SPEED;
}

// ---- 入力 ----

const keys = new Set();
let stick = { x: 0, y: 0, magnitude: 0 };
let stickPointer = null;
let firing = false;

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

// 撃つボタンは押しっぱなしで連射できる
const fireEl = document.getElementById('fire');
fireEl.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  fireEl.setPointerCapture(event.pointerId);
  firing = true;
  fire();
});
for (const type of ['pointerup', 'pointercancel']) fireEl.addEventListener(type, () => { firing = false; });
document.getElementById('jump').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  jump();
});
// 長押しでメニューが出ないようにする
viewerEl.addEventListener('contextmenu', (event) => event.preventDefault());
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button === 0) fire();
});

document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, select, textarea')) return;
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
    keys.add(key);
    event.preventDefault();
  } else if (key === ' ') {
    event.preventDefault();
    if (state === 'playing') jump();
  } else if (key === 'j' || key === 'enter') {
    event.preventDefault();
    if (state === 'playing') firing = true;
    else startGame();
  }
});
document.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  keys.delete(key);
  if (key === 'j' || key === 'enter') firing = false;
});
// 別のアプリに切り替えたら、押しっぱなしの入力を離す
window.addEventListener('blur', () => {
  keys.clear();
  firing = false;
});

// ---- ゲームの進行 ----

function updateHud() {
  timeEl.textContent = formatTime(timeLeft);
  scoreEl.textContent = `倒した ${knockedCount} / ${crates.length}`;
  bestEl.textContent = `ベスト ${best}`;
}

function startGame() {
  for (const shot of shots) removeShot(shot);
  shots = [];
  buildCrates();
  playerBody.position.set(0, CHARACTER_HEIGHT / 2, 0);
  playerBody.velocity.setZero();
  playerYaw = 0;
  cameraYaw = 0;
  timeLeft = GAME_SECONDS;
  state = 'playing';
  overlayEl.hidden = true;
  updateHud();
}

function endGame() {
  state = 'over';
  firing = false;
  const score = finalScore(knockedCount, crates.length, timeLeft);
  const isBest = score > best;
  if (isBest) {
    best = score;
    saveBest();
  }
  const allDown = knockedCount === crates.length;
  document.getElementById('overlay-title').textContent = allDown ? '全部倒した！' : 'タイムアップ！';
  document.getElementById('overlay-text').textContent = `${knockedCount} / ${crates.length} 個${allDown ? `、残り ${formatTime(timeLeft)} 秒のボーナス` : ''}。スコア ${score}${isBest ? '（ベスト更新！）' : ''}`;
  document.getElementById('start').textContent = 'もう一度';
  overlayEl.hidden = false;
  updateHud();
}

function stepGame(dt) {
  if (state === 'playing') {
    const input = currentInput();
    const [vx, vz] = moveVelocity(input, cameraYaw, MOVE_SPEED);
    // 横の速さは入力にすばやく近づける（止まるときもすぐ止まる）
    const blend = Math.min(1, dt * 12);
    playerBody.velocity.x += (vx - playerBody.velocity.x) * blend;
    playerBody.velocity.z += (vz - playerBody.velocity.z) * blend;
    if (input.magnitude > 0) {
      playerYaw = turnTowards(playerYaw, headingOf(vx, vz), TURN_SPEED * dt);
      cameraYaw = turnTowards(cameraYaw, playerYaw, CAMERA_TURN_SPEED * dt * input.magnitude);
      walkPhase += dt * 10 * input.magnitude;
    }
    if (firing) fire();
    timeLeft -= dt;
  } else {
    playerBody.velocity.x = 0;
    playerBody.velocity.z = 0;
  }

  for (const crate of crates) {
    if (crate.knocked) continue;
    if (isKnocked(crate.start, crate.body.position.toArray(), crate.body.quaternion.toArray())) {
      crate.knocked = true;
      crate.material = knockedMaterial;
      crate.ghost = knockedGhost;
      if (state === 'playing') knockedCount++;
    }
  }
  // 弾は重力で落ちないように、毎回まっすぐの速さに戻す。何かに当たったら落ちるに任せる
  for (const shot of [...shots]) {
    if (!shot.body.userData.hit) shot.body.velocity.y = 0;
    if (world.time - shot.born > SHOT_LIFETIME) {
      removeShot(shot);
      shots.splice(shots.indexOf(shot), 1);
    }
  }
  if (state === 'playing') {
    updateHud();
    if (timeLeft <= 0 || knockedCount === crates.length) endGame();
  }
}

world.addEventListener('postStep', () => stepGame(STEP));

// ---- 描画 ----

function updateView(frameSeconds) {
  avatar.position.copy(playerBody.position);
  avatar.rotation.y = playerYaw;
  // 歩くときは上下に揺れて少し前かがみに、撃つと少しのけぞる
  const moving = state === 'playing' && currentInput().magnitude > 0;
  avatarPose.position.y = moving ? Math.abs(Math.sin(walkPhase)) * 0.08 : 0;
  recoil = Math.max(0, recoil - frameSeconds * 8);
  avatarPose.rotation.x = (moving ? 0.12 : 0) - recoil * 0.12;
  avatarPose.rotation.z = moving ? Math.sin(walkPhase) * 0.04 : 0;
  muzzleFlash.intensity = Math.max(0, muzzleFlash.intensity - frameSeconds * 120);

  for (const crate of crates) {
    crate.mesh.position.copy(crate.body.position);
    crate.mesh.quaternion.copy(crate.body.quaternion);
  }
  for (const shot of shots) shot.mesh.position.copy(shot.body.position);

  // メカの後ろ上からのぞき込む
  const behind = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
  const target = avatar.position.clone().add(new THREE.Vector3(0, 0.8, 0));
  const desired = target.clone().addScaledVector(behind, 6.5).add(new THREE.Vector3(0, 3, 0));
  camera.position.lerp(desired, Math.min(1, frameSeconds * 6));
  camera.lookAt(target.clone().addScaledVector(behind, -3));

  const toAvatar = target.clone().sub(camera.position);
  occlusionRay.set(camera.position, toAvatar.clone().normalize());
  occlusionRay.far = toAvatar.length();
  const hidden = new Set(occlusionRay.intersectObjects(crates.map((c) => c.mesh), false).map((hit) => hit.object));
  for (const crate of crates) crate.mesh.material = hidden.has(crate.mesh) ? crate.ghost : crate.material;
}
const occlusionRay = new THREE.Raycaster();

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  ground.material.color.set(cssValue('--bg'));
  wallMaterial.color.set(cssValue('--border'));
  knockedMaterial.color.set(cssValue('--muted'));
  knockedGhost.color.set(cssValue('--muted'));
  shotMaterial.color.set(cssValue('--piece-o'));
  muzzleFlash.color.set(cssValue('--piece-o'));
  PALETTE.forEach((name, i) => {
    crateMaterials[i].color.set(cssValue(name));
    crateGhosts[i].color.set(cssValue(name));
  });
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(ARENA_HALF * 2, ARENA_HALF * 2, cssValue('--muted'), cssValue('--border'));
  grid.position.y = 0.002;
  scene.add(grid);
  if (!character?.custom) setCharacter(defaultRobot(), null);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// ---- キャラクター ----

// 自分のモデルがないときの仮のロボ。高さ CHARACTER_HEIGHT、足元が y = -CHARACTER_HEIGHT / 2、正面が +z
function defaultRobot() {
  const group = new THREE.Group();
  const material = (name) => new THREE.MeshStandardMaterial({ color: cssValue(name), roughness: 0.45, metalness: 0.2 });
  const part = (size, position, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(name));
    mesh.position.set(...position);
    group.add(mesh);
  };
  part([0.8, 0.8, 0.5], [0, 0.15, 0], '--piece-j');
  part([0.45, 0.4, 0.45], [0, 0.8, 0], '--piece-i');
  part([0.36, 0.08, 0.05], [0, 0.82, 0.24], '--piece-o');
  part([0.25, 0.75, 0.3], [-0.2, -0.62, 0], '--piece-t');
  part([0.25, 0.75, 0.3], [0.2, -0.62, 0], '--piece-t');
  part([0.2, 0.65, 0.25], [-0.52, 0.12, 0], '--piece-j');
  part([0.22, 0.22, 0.9], [0.55, 0.2, 0.35], '--piece-z');
  group.traverse((child) => {
    if (child.isMesh) child.castShadow = true;
  });
  return group;
}

// モデルを、高さ CHARACTER_HEIGHT・足元が物理の箱の底・中心が真ん中になるようにそろえ、正面の向きを合わせる
function fitCharacter(object, facing) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = characterScale(size.toArray());
  // 元の位置を保ったまま拡大縮小し、足元の中心が原点に来るようにずらす
  object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z)).multiplyScalar(scale);
  object.scale.multiplyScalar(scale);
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.rotation.y = facing;
  wrapper.position.y = -CHARACTER_HEIGHT / 2;
  wrapper.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return wrapper;
}

function setCharacter(object, record) {
  if (character) avatarPose.remove(character.object);
  character = { object, custom: Boolean(record), record };
  avatarPose.add(object);
  characterNameEl.textContent = record ? `いまのキャラクター：${record.name}` : 'いまのキャラクター：仮のロボ';
}

async function parseModel({ format, data }) {
  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    return (await loader.parseAsync(format === 'gltf' ? new TextDecoder().decode(data) : data, '')).scene;
  }
  const material = () => new THREE.MeshStandardMaterial({ color: cssValue('--piece-j'), roughness: 0.45 });
  if (format === 'obj') {
    const object = new OBJLoader().parse(new TextDecoder().decode(data));
    object.traverse((child) => {
      if (child.isMesh) child.material = material();
    });
    return object;
  }
  const geometry = new STLLoader().parse(data);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material());
  mesh.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

async function useRecord(record) {
  const object = await parseModel(record);
  if (record.facing === undefined) {
    record.facing = guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
  }
  setCharacter(fitCharacter(object, record.facing), record);
}

// ---- キャラクターの保存（このブラウザの IndexedDB だけに保存し、どこにも送らない） ----

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

async function saveCharacter(record) {
  try {
    await withStore('readwrite', (store) => (record ? store.put(record, 'current') : store.delete('current')));
  } catch (error) {
    console.warn(error);
    setStatus('このブラウザには保存できないので、キャラクターはページを閉じると元に戻ります。');
  }
}

async function loadSavedCharacter() {
  try {
    const record = await withStore('readonly', (store) => store.get('current'));
    if (record?.data instanceof ArrayBuffer && detectFormat(record.name)) await useRecord(record);
  } catch (error) {
    console.warn(error);
  }
}

document.getElementById('character-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const format = detectFormat(file.name);
  if (!format) {
    setStatus(`「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`);
    return;
  }
  setStatus(`「${file.name}」を読み込み中…`);
  const record = { name: file.name, format, data: await file.arrayBuffer() };
  try {
    await useRecord(record);
  } catch (error) {
    console.warn(error);
    setStatus(`「${file.name}」を読み込めませんでした。`);
    return;
  }
  await saveCharacter(record);
  setStatus(`「${file.name}」をキャラクターにしました。正面が前を向いていなければ「向きを回す」で合わせてね。`);
});
document.getElementById('turn').addEventListener('click', async () => {
  if (!character?.custom) return setStatus('仮のロボは向きを回せません。');
  character.record.facing = wrapAngle(character.record.facing + Math.PI / 2);
  character.object.rotation.y = character.record.facing;
  await saveCharacter(character.record);
});
document.getElementById('default-character').addEventListener('click', async () => {
  setCharacter(defaultRobot(), null);
  await saveCharacter(null);
  setStatus('仮のロボに戻しました。');
});
document.getElementById('start').addEventListener('click', startGame);

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

resize();
applyTheme();
buildCrates();
updateHud();
loadSavedCharacter();
const clock = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  clock.update(time);
  world.fixedStep(STEP, 5);
  updateView(Math.min(clock.getDelta(), 0.1));
  renderer.render(scene, camera);
});
