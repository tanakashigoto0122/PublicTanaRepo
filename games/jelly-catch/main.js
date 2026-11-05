import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import {
  GAME_SECONDS, HAND_BONES, INDEX_TIP, JELLY_HEIGHT, LANDMARK_COUNT, TARGET_RADIUS, THUMB_TIP, WALL, averageSpacing,
  bindVertices, bodySummary, createBody, deformVertices, detectFormat, farthestPointSample, formatTime, grabMembers,
  guessFacing, handToWorld, isOnTarget, midpoint, palmSize, placeTarget, smoothPoints, stepBody,
  stiffnessFromSoftness, strideIndices, toFloatArray, translateBody, updatePinch,
} from './logic.js';

const PARTICLE_COUNT = 150;
const CLUSTER_SCALE = 2.5;
const STEP = 1 / 120;
const MAX_STEPS = 4;
// つかむ範囲と、つまんだ点からつかめる距離（ジェリーの高さに対する割合）
const GRAB_RADIUS = 0.2;
const GRAB_REACH = 0.5;
const START_POSITION = [0, 2.5, 0.8];
const RECALIBRATE_AFTER = 0.6;
const BEST_KEY = 'mini-games:jelly-catch:best';
const MEDIAPIPE = new URL('../../assets/vendor/mediapipe/', import.meta.url).href;
const DB_NAME = 'mini-games-mecha-blaster';
const DB_STORE = 'character';

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const overlayEl = document.getElementById('overlay');
const previewEl = document.getElementById('preview');
const cameraEl = document.getElementById('camera');
const softnessEl = document.getElementById('softness');

function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
// 床の的が見やすいよう、斜め上から見下ろす（視点は固定）。距離は画面の縦横比で決める（resize）
const LOOK_AT = new THREE.Vector3(0, 0.6, -0.6);
const VIEW_DIRECTION = new THREE.Vector3(0, 3, 8).normalize();
// 的を置く範囲の左右の端までが、画面に入るようにする幅（少し余裕を持たせる）
const VISIBLE_HALF_WIDTH = 2.9;
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 8, 5);
scene.add(hemisphere, sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(WALL * 2, WALL * 2), new THREE.MeshStandardMaterial({ roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
let grid = null;

// 的（床の上の輪）と、ジェリーの真下の影
const targetMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, side: THREE.DoubleSide });
const targetRingMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const targetMesh = new THREE.Group();
const targetDisk = new THREE.Mesh(new THREE.CircleGeometry(TARGET_RADIUS, 48), targetMaterial);
const targetRing = new THREE.Mesh(new THREE.RingGeometry(TARGET_RADIUS * 0.85, TARGET_RADIUS, 48), targetRingMaterial);
for (const mesh of [targetDisk, targetRing]) mesh.rotation.x = -Math.PI / 2;
targetRing.position.y = 0.002;
targetMesh.add(targetDisk, targetRing);
targetMesh.position.y = 0.004;
scene.add(targetMesh);
const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 32), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2;
shadow.position.y = 0.006;
scene.add(shadow);

// カメラの手
const jointGeometry = new THREE.SphereGeometry(1, 12, 8);
const handMaterial = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.85 });
const pinchMaterial = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.9 });
const boneMaterial = new THREE.LineBasicMaterial();
function makeHandView() {
  const joints = new THREE.InstancedMesh(jointGeometry, handMaterial, LANDMARK_COUNT);
  const bones = new THREE.LineSegments(new THREE.BufferGeometry(), boneMaterial);
  bones.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3));
  joints.frustumCulled = false;
  bones.frustumCulled = false;
  const group = new THREE.Group();
  group.add(joints, bones);
  group.visible = false;
  scene.add(group);
  return { group, joints, bones };
}
const handViews = [makeHandView(), makeHandView()];

// ---- ジェリー ----

let jelly = null;

// メッシュを頂点に焼き込み、高さ JELLY_HEIGHT・正面がカメラ向きにそろえ、表面に粒を置いてぷるぷるの体を作る
function prepareJelly(object, facing) {
  const holder = new THREE.Group();
  holder.add(object);
  holder.rotation.y = facing;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? JELLY_HEIGHT / size.y : 1;
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
  const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  const samples = [];
  for (const mesh of meshes) {
    const array = mesh.geometry.attributes.position.array;
    const count = mesh.geometry.attributes.position.count;
    for (const i of strideIndices(count, Math.ceil((3000 * count) / total))) samples.push([array[i * 3], array[i * 3 + 1], array[i * 3 + 2]]);
  }
  const particles = Float32Array.from(farthestPointSample(samples, PARTICLE_COUNT).flat());
  const body = createBody(particles, averageSpacing(particles) * CLUSTER_SCALE);
  const parts = meshes.map((mesh) => {
    const rest = mesh.geometry.attributes.position.array.slice();
    return { mesh, rest, binding: bindVertices(rest, particles) };
  });
  return { root, parts, body };
}

function setJelly(next) {
  if (jelly) {
    scene.remove(jelly.root);
    jelly.root.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose();
    });
  }
  jelly = next;
  scene.add(jelly.root);
  holders.clear();
  placeAtStart();
}

// 元の形に戻して、スタート地点の上に置く
function placeAtStart() {
  const { body } = jelly;
  body.positions.set(body.rest);
  body.velocities.fill(0);
  body.rotations.forEach((q) => q.splice(0, 4, 0, 0, 0, 1));
  body.pinned.clear();
  translateBody(body, START_POSITION);
}

function clayBall() {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshStandardMaterial({ color: cssValue('--piece-l'), roughness: 0.4 }));
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
      const object = await parseModel(record);
      const facing = record.facing ?? guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
      setJelly(prepareJelly(object, facing));
      setStatus(`キャラクター（${record.name}）で遊びます。`);
      return;
    }
  } catch (error) {
    console.warn(error);
  }
  if (!quiet) setStatus('キャラクターがまだありません。メカ・ブラスターなどで読み込んでね。');
}

// ---- つかむ（指でもカメラの手でも同じ） ----
// holders は、つかんでいる指や手ごとの { members, offsets }

const holders = new Map();

function grab(key, point) {
  const { positions } = jelly.body;
  const members = grabMembers(positions, point, GRAB_RADIUS * JELLY_HEIGHT, GRAB_REACH * JELLY_HEIGHT);
  if (members.length === 0) return false;
  holders.set(key, {
    offsets: new Map(members.map((i) => [i, [positions[i * 3] - point[0], positions[i * 3 + 1] - point[1], positions[i * 3 + 2] - point[2]]])),
  });
  holdAt(key, point);
  return true;
}

function holdAt(key, point) {
  const holder = holders.get(key);
  if (!holder) return;
  for (const [i, offset] of holder.offsets) {
    jelly.body.pinned.set(i, [point[0] + offset[0], Math.max(0, point[1] + offset[1]), point[2] + offset[2]]);
  }
}

// 離すと、そのときの勢いのまま飛んでいく
function release(key) {
  const holder = holders.get(key);
  if (!holder) return;
  for (const i of holder.offsets.keys()) jelly.body.pinned.delete(i);
  holders.delete(key);
}

const raycaster = new THREE.Raycaster();
let touch = null;

function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  ), camera);
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!jelly || touch || stream) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointerRay(event);
  const [hit] = raycaster.intersectObjects(jelly.parts.map((p) => p.mesh), false);
  if (!hit || !grab('touch', hit.point.toArray())) return;
  // カメラの方を向いた面の上で動かす（斜め上から見ているので、上へ振ると奥へも動く）
  const facing = new THREE.Vector3();
  camera.getWorldDirection(facing);
  touch = { id: event.pointerId, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing.negate(), hit.point) };
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!touch || event.pointerId !== touch.id) return;
  pointerRay(event);
  const target = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(touch.plane, target)) holdAt('touch', target.toArray());
});
function endTouch(event) {
  if (!touch || event.pointerId !== touch.id) return;
  release('touch');
  touch = null;
}
renderer.domElement.addEventListener('pointerup', endTouch);
renderer.domElement.addEventListener('pointercancel', endTouch);

// ---- カメラの手 ----

let landmarker = null;
let stream = null;
let lastVideoTime = -1;
const hands = new Map();

function visibleView() {
  // 的のあるあたり（ジェリーのスタート地点の奥行き）で、画面に映る幅と高さ
  const height = 2 * camera.position.distanceTo(LOOK_AT) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return { width: height * camera.aspect, height, centerY: LOOK_AT.y + 0.6 };
}

async function startCamera() {
  cameraEl.disabled = true;
  setStatus('カメラと手の検出を準備中…（初回は数秒かかります）');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    previewEl.srcObject = stream;
    await previewEl.play();
    if (!landmarker) {
      const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}wasm`);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: `${MEDIAPIPE}models/hand_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
      });
      try {
        landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
      } catch (error) {
        console.warn(error);
        landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      }
    }
  } catch (error) {
    console.warn(error);
    stopCamera();
    setStatus(error?.name === 'NotAllowedError'
      ? 'カメラが許可されませんでした。指で遊べます。'
      : 'このブラウザでは手の検出を使えませんでした。指で遊べます。');
    return;
  }
  previewEl.hidden = false;
  cameraEl.textContent = 'カメラを止める';
  cameraEl.disabled = false;
  setStatus('カメラに手のひらを向けて、親指と人差し指でつまんでね。');
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  previewEl.hidden = true;
  previewEl.srcObject = null;
  for (const key of hands.keys()) release(`hand-${key}`);
  hands.clear();
  for (const view of handViews) view.group.visible = false;
  cameraEl.textContent = 'カメラで手を使う';
  cameraEl.disabled = false;
}

function trackHands(now) {
  if (!landmarker || !stream || previewEl.readyState < 2 || previewEl.currentTime === lastVideoTime) return;
  lastVideoTime = previewEl.currentTime;
  const result = landmarker.detectForVideo(previewEl, now);
  const view = visibleView();
  const seen = new Set();
  result.landmarks.forEach((landmarks, i) => {
    const key = result.handedness?.[i]?.[0]?.categoryName ?? String(i);
    if (seen.has(key)) return;
    seen.add(key);
    let hand = hands.get(key);
    if (!hand || now - hand.lastSeen > RECALIBRATE_AFTER * 1000) {
      release(`hand-${key}`);
      // 手は最初、スタート地点のあたりの奥行きに出る
      hand = { palmRef: palmSize(landmarks), points: null, pinching: false };
      hands.set(key, hand);
    }
    hand.lastSeen = now;
    const world = handToWorld(landmarks, { view, palmRef: hand.palmRef, startZ: START_POSITION[2], jointDepth: 0.5 });
    hand.points = smoothPoints(hand.points, world, 0.7);
    const pinching = updatePinch(hand.pinching, landmarks);
    const point = midpoint(hand.points[THUMB_TIP], hand.points[INDEX_TIP]);
    if (pinching && !hand.pinching) grab(`hand-${key}`, point);
    else if (pinching) holdAt(`hand-${key}`, point);
    else if (hand.pinching) release(`hand-${key}`);
    hand.pinching = pinching;
  });
  for (const [key, hand] of hands) {
    if (seen.has(key)) continue;
    if (hand.pinching) release(`hand-${key}`);
    hand.pinching = false;
    hand.points = null;
  }
}

function drawHands() {
  const visible = [...hands.values()].filter((h) => h.points);
  const radius = 0.025 * visibleView().width;
  const matrix = new THREE.Matrix4();
  handViews.forEach((view, n) => {
    const hand = visible[n];
    view.group.visible = Boolean(hand);
    if (!hand) return;
    view.joints.material = hand.pinching ? pinchMaterial : handMaterial;
    hand.points.forEach((p, i) => {
      matrix.makeScale(radius, radius, radius).setPosition(p[0], p[1], p[2]);
      view.joints.setMatrixAt(i, matrix);
    });
    view.joints.instanceMatrix.needsUpdate = true;
    const array = view.bones.geometry.attributes.position.array;
    HAND_BONES.forEach(([a, b], i) => array.set([...hand.points[a], ...hand.points[b]], i * 6));
    view.bones.geometry.attributes.position.needsUpdate = true;
  });
}

// ---- ゲームの進行 ----

let state = 'ready';
let timeLeft = GAME_SECONDS;
let score = 0;
let best = loadBest();
let target = placeTarget();
let flash = 0;

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
  document.getElementById('score').textContent = `${score} 点`;
  document.getElementById('best').textContent = `ベスト ${best}`;
}

function moveTarget() {
  target = placeTarget({ avoid: target });
  targetMesh.position.set(target[0], 0.004, target[1]);
}

function startGame() {
  score = 0;
  timeLeft = GAME_SECONDS;
  state = 'playing';
  overlayEl.hidden = true;
  for (const key of [...holders.keys()]) release(key);
  placeAtStart();
  moveTarget();
  updateHud();
}

function endGame() {
  state = 'over';
  const isBest = score > best;
  if (isBest) {
    best = score;
    saveBest();
  }
  document.getElementById('overlay-title').textContent = 'タイムアップ！';
  document.getElementById('overlay-text').textContent = `${score} 点${isBest ? '（ベスト更新！）' : ''}`;
  document.getElementById('start').textContent = 'もう一回';
  overlayEl.hidden = false;
  updateHud();
}

function checkScore(dt) {
  if (state !== 'playing') return;
  timeLeft -= dt;
  if (isOnTarget(bodySummary(jelly.body.positions), target, holders.size > 0)) {
    score++;
    flash = 0.4;
    moveTarget();
  }
  updateHud();
  if (timeLeft <= 0) endGame();
}

document.getElementById('start').addEventListener('click', startGame);
cameraEl.addEventListener('click', () => (stream ? stopCamera() : startCamera()));
document.getElementById('use-character').addEventListener('click', () => useCharacter());
document.getElementById('clay').addEventListener('click', () => {
  setJelly(prepareJelly(clayBall(), 0));
  setStatus('粘土の玉で遊びます。');
});
softnessEl.addEventListener('input', () => {
  document.getElementById('softness-value').textContent = `${softnessEl.value}%`;
});

// ---- 描画 ----

// 的の色（入ったときに光らせる）。毎フレーム CSS を読まないよう、テーマが変わったときだけ読む
const targetColors = { normal: new THREE.Color(), hit: new THREE.Color() };

function applyTheme() {
  targetColors.normal.set(cssValue('--piece-s'));
  targetColors.hit.set(cssValue('--piece-o'));
  scene.background = new THREE.Color(cssValue('--surface'));
  floor.material.color.set(cssValue('--bg'));
  targetMaterial.color.set(cssValue('--piece-s'));
  targetRingMaterial.color.set(cssValue('--piece-s'));
  shadow.material.color.set(cssValue('--text'));
  handMaterial.color.set(cssValue('--accent'));
  pinchMaterial.color.set(cssValue('--piece-o'));
  boneMaterial.color.set(cssValue('--accent'));
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
  // 縦長の画面ほど遠くから見て、的を置く範囲の左右が切れないようにする
  const distance = Math.max(7.5, VISIBLE_HALF_WIDTH / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  camera.position.copy(LOOK_AT).addScaledVector(VIEW_DIRECTION, distance);
  camera.lookAt(LOOK_AT);
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

resize();
applyTheme();
softnessEl.dispatchEvent(new Event('input'));
targetMesh.position.set(target[0], 0.004, target[1]);
updateHud();
setJelly(prepareJelly(clayBall(), 0));
useCharacter({ quiet: true });

const clock = new THREE.Timer();
let leftover = 0;
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const frame = Math.min(clock.getDelta(), 0.1);
  trackHands(performance.now());
  if (stream) drawHands();
  if (jelly) {
    leftover = Math.min(leftover + frame, STEP * MAX_STEPS);
    const options = { dt: STEP, stiffness: stiffnessFromSoftness(Number(softnessEl.value)), bounce: 0.25, wall: WALL };
    while (leftover >= STEP) {
      stepBody(jelly.body, options);
      leftover -= STEP;
    }
    for (const part of jelly.parts) {
      deformVertices(part.mesh.geometry.attributes.position.array, part.rest, part.binding, jelly.body);
      part.mesh.geometry.attributes.position.needsUpdate = true;
      part.mesh.geometry.computeVertexNormals();
      part.mesh.geometry.computeBoundingSphere();
    }
    const summary = bodySummary(jelly.body.positions);
    shadow.position.set(summary.center[0], 0.006, summary.center[2]);
    // 高く飛ぶほど影を小さく薄くする
    const lift = Math.max(0, summary.lowest);
    shadow.scale.setScalar(Math.max(0.4, 1 - lift * 0.15));
    shadow.material.opacity = Math.max(0.08, 0.3 - lift * 0.05);
    checkScore(frame);
  }
  // 入ったときに的を光らせる
  flash = Math.max(0, flash - frame);
  targetRingMaterial.color.copy(flash > 0 ? targetColors.hit : targetColors.normal);
  renderer.render(scene, camera);
});
