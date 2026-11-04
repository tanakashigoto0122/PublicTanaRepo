import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import {
  HAND_BONES, INDEX_TIP, LANDMARK_COUNT, THUMB_TIP, applyOffset, brushWeights, customName, detectFormat,
  fillZeroNormals, guessFacing, handToWorld, midpoint, nearestVertex, palmSize, pushOut, smoothPoints, springStep,
  springVector, toFloatArray, updatePinch, vectorLength,
} from './logic.js';

const MODEL_HEIGHT = 2;
const MEDIAPIPE = new URL('../../assets/vendor/mediapipe/', import.meta.url).href;
// つまんだ所から、これより遠くにしか頂点がなければ何もつかまない
const GRAB_REACH = 0.35;
// 関節の球の半径（画面の幅に対する割合。手の大きさのスライダーで変わる）
const JOINT_RADIUS = 0.028;
// 手が見えなくなってからこれだけ経ってまた見えたら、そのときの大きさを奥行きの基準にし直す（秒）
const RECALIBRATE_AFTER = 0.6;
const SPRING_EPSILON = 1e-4;
const DB_NAME = 'mini-games-mecha-blaster';
const DB_STORE = 'character';
const HINTS = {
  pinch: 'カメラ：親指と人差し指をくっつけてつまみ、そのまま手を動かす。指：モデルをつかんでドラッグ。',
  press: 'カメラ：スマホに手を近づけると、手が奥へ進んでモデルに手の形の跡が付く。指：モデルを押すとへこむ。',
};

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const badgeEl = document.getElementById('badge');
const previewEl = document.getElementById('preview');
const cameraEl = document.getElementById('camera');
const radiusEl = document.getElementById('radius');
const handSizeEl = document.getElementById('hand-size');
const elasticEl = document.getElementById('elastic');
const showPreviewEl = document.getElementById('show-preview');
const modeButtons = [...document.querySelectorAll('[data-mode]')];

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
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 5, 6);
scene.add(hemisphere, sun);
let grid = null;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// 画面の中の手（最大 2 本）。関節の球と骨の線
const jointGeometry = new THREE.SphereGeometry(1, 16, 12);
const handMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, transparent: true, opacity: 0.85 });
const pinchMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, transparent: true, opacity: 0.9 });
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

// いまのモデル。parts はメッシュごとの { mesh, positions, original }
let model = null;
let mode = 'pinch';

// ---- モデルの準備 ----

// メッシュの位置・向き・大きさを頂点に焼き込み、高さ MODEL_HEIGHT・足元が床・真ん中が原点、正面がカメラを向くようにそろえる
function prepareModel(object, name, facing) {
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
  const parts = [];
  holder.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry.clone();
    geometry.setAttribute('position', new THREE.BufferAttribute(toFloatArray(geometry.attributes.position), 3));
    geometry.deleteAttribute('normal');
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(normalize, child.matrixWorld));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = Array.isArray(child.material) ? child.material.map((m) => m.clone()) : child.material.clone();
    const mesh = new THREE.Mesh(geometry, material);
    root.add(mesh);
    const positions = geometry.attributes.position.array;
    parts.push({ mesh, positions, original: positions.slice() });
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
  clearInteractions();
}

function refresh(part) {
  const { geometry } = part.mesh;
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

function snapshot() {
  return model.parts.map((part) => part.positions.slice());
}

function clayBall() {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 120), new THREE.MeshStandardMaterial({ color: cssValue('--piece-l'), roughness: 0.6 }));
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
  setModel(prepareModel(object, record.name, facing));
}

// ---- つまむ ----
// 何本の手（と指）がつまんでいても、形は「つまみ始めたときの形 base」に、それぞれの引っぱり量を足して作る。
// 離したら（ぷるんのとき）その引っぱり量がばねで 0 に戻り、全部戻ったら base の形に戻る

let base = null;
const grabs = new Map();

function brushRadius() {
  return (Number(radiusEl.value) / 100) * MODEL_HEIGHT;
}

function startGrab(key, point) {
  if (!model) return false;
  let best = null;
  model.parts.forEach((part, i) => {
    const found = nearestVertex(part.positions, point);
    if (found.index >= 0 && (!best || found.distance < best.distance)) best = { ...found, part: i };
  });
  if (!best || best.distance > GRAB_REACH) return false;
  if (!base) base = snapshot();
  const p = model.parts[best.part].positions;
  const center = [p[best.index * 3], p[best.index * 3 + 1], p[best.index * 3 + 2]];
  grabs.set(key, {
    start: [...point],
    delta: [0, 0, 0],
    velocity: [0, 0, 0],
    holding: true,
    brushes: base.map((positions) => brushWeights(positions, center, brushRadius())),
  });
  return true;
}

function moveGrab(key, point) {
  const grab = grabs.get(key);
  if (grab?.holding) grab.delta = point.map((v, k) => v - grab.start[k]);
}

function releaseGrab(key) {
  const grab = grabs.get(key);
  if (!grab) return;
  if (elasticEl.checked) {
    grab.holding = false;
    return;
  }
  // そのまま固定：この手の引っぱり分を base に足し込んで、つまみを終える
  base.forEach((positions, i) => applyOffset(positions, positions.slice(), grab.brushes[i], grab.delta));
  grabs.delete(key);
}

function updateGrabs(dt) {
  if (!base) return;
  for (const [key, grab] of grabs) {
    if (grab.holding) continue;
    const next = springVector(grab.delta, grab.velocity, { dt });
    grab.delta = next.value;
    grab.velocity = next.velocity;
    if (vectorLength(grab.delta) < SPRING_EPSILON && vectorLength(grab.velocity) * dt < SPRING_EPSILON) grabs.delete(key);
  }
  model.parts.forEach((part, i) => {
    part.positions.set(base[i]);
    for (const grab of grabs.values()) {
      const brush = grab.brushes[i];
      for (let n = 0; n < brush.indices.length; n++) {
        const v = brush.indices[n] * 3;
        for (let k = 0; k < 3; k++) part.positions[v + k] += grab.delta[k] * brush.weights[n];
      }
    }
    refresh(part);
  });
  if (grabs.size === 0) base = null;
}

// ---- 押す ----
// 手の関節の球に入った頂点を押し出す。ぷるんのときは、押す前の形 rest へ、ばねで揺れながら戻す

let press = null;

function startPress() {
  if (!press) {
    press = {
      rest: snapshot(),
      velocities: model.parts.map((part) => new Float32Array(part.positions.length)),
      active: model.parts.map(() => new Set()),
    };
  }
}

function updatePress(spheres, dt) {
  if (!model || (!press && spheres.length === 0)) return;
  startPress();
  let settling = false;
  model.parts.forEach((part, i) => {
    if (elasticEl.checked && press.active[i].size > 0) {
      const largest = springStep(part.positions, press.velocities[i], press.rest[i], press.active[i], { dt });
      if (largest >= SPRING_EPSILON) settling = true;
    }
    const moved = pushOut(part.positions, spheres);
    for (const v of moved) {
      press.active[i].add(v);
      for (let k = 0; k < 3; k++) press.velocities[i][v * 3 + k] = 0;
    }
    if (moved.length > 0) settling = true;
    if (press.active[i].size > 0 || moved.length > 0) refresh(part);
  });
  if (!elasticEl.checked) {
    // 跡を残すときは、いまの形を押す前の形として扱う
    press.rest = snapshot();
    press.active.forEach((set) => set.clear());
  }
  if (!settling) {
    // 揺れが収まったら、元の位置にぴったり戻して終える
    model.parts.forEach((part, i) => {
      if (press.active[i].size === 0) return;
      for (const v of press.active[i]) for (let k = 0; k < 3; k++) part.positions[v * 3 + k] = press.rest[i][v * 3 + k];
      refresh(part);
    });
    if (spheres.length === 0) press = null;
  }
}

function clearInteractions() {
  grabs.clear();
  base = null;
  press = null;
}

// 揺れている途中のものを止めて、いまの形を確定させる
function settle() {
  if (base) {
    for (const [key, grab] of grabs) {
      if (!grab.holding) grabs.delete(key);
    }
    updateGrabs(0);
  }
  if (press && elasticEl.checked) {
    model.parts.forEach((part, i) => {
      for (const v of press.active[i]) for (let k = 0; k < 3; k++) part.positions[v * 3 + k] = press.rest[i][v * 3 + k];
      refresh(part);
    });
  }
  clearInteractions();
}

// ---- カメラの手 ----

let landmarker = null;
let stream = null;
let lastVideoTime = -1;
// 手ごとの状態。キーは MediaPipe の左右の判定（"Left" / "Right"）
const hands = new Map();

function visibleView() {
  const height = 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return { width: height * camera.aspect, height, centerY: controls.target.y };
}

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${MEDIAPIPE}models/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (error) {
    // GPU が使えない端末では CPU で動かす
    console.warn(error);
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

async function startCamera() {
  cameraEl.disabled = true;
  setStatus('カメラと手の検出を準備中…（初回は数秒かかります）');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    previewEl.srcObject = stream;
    await previewEl.play();
    landmarker ??= await createLandmarker();
  } catch (error) {
    console.warn(error);
    stopCamera();
    setStatus(error?.name === 'NotAllowedError'
      ? 'カメラが許可されませんでした。指で操作できます。'
      : 'このブラウザでは手の検出を使えませんでした。指で操作できます。');
    return;
  }
  // 手は正面から見て合わせるので、視点を正面に戻して固定する
  resetView();
  controls.enabled = false;
  previewEl.hidden = !showPreviewEl.checked;
  cameraEl.textContent = 'カメラを止める';
  cameraEl.disabled = false;
  badgeEl.textContent = '手をさがしています…';
  setStatus('カメラに手のひらを向けてね。');
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  previewEl.hidden = true;
  previewEl.srcObject = null;
  for (const key of hands.keys()) releaseHand(key);
  hands.clear();
  for (const view of handViews) view.group.visible = false;
  controls.enabled = true;
  cameraEl.textContent = 'カメラで手を使う';
  cameraEl.disabled = false;
  badgeEl.textContent = '指で操作中';
}

function releaseHand(key) {
  const hand = hands.get(key);
  if (hand?.pinching) releaseGrab(`hand-${key}`);
}

function jointRadius(view) {
  return JOINT_RADIUS * view.width * (Number(handSizeEl.value) / 100);
}

function trackHands(now) {
  if (!landmarker || !stream || previewEl.readyState < 2 || previewEl.currentTime === lastVideoTime) return null;
  lastVideoTime = previewEl.currentTime;
  const result = landmarker.detectForVideo(previewEl, now);
  const view = visibleView();
  const seen = new Set();
  result.landmarks.forEach((landmarks, i) => {
    const key = result.handedness?.[i]?.[0]?.categoryName ?? String(i);
    if (seen.has(key)) return;
    seen.add(key);
    let hand = hands.get(key);
    // 久しぶりに見えた手は、そのときの大きさを奥行きの基準にする（画面の手前、モデルに触れない所から始まる）
    if (!hand || now - hand.lastSeen > RECALIBRATE_AFTER * 1000) {
      if (hand?.pinching) releaseGrab(`hand-${key}`);
      hand = { palmRef: palmSize(landmarks), points: null, pinching: false };
      hands.set(key, hand);
    }
    hand.lastSeen = now;
    hand.landmarks = landmarks;
    // 手は最初、モデルより手前（z = 1.6）に出る。関節の奥行きの差は控えめにする（大きいと指先だけ奥に刺さる）
    const world = handToWorld(landmarks, { view, palmRef: hand.palmRef, startZ: 1.6, jointDepth: 0.5 });
    hand.points = smoothPoints(hand.points, world, 0.6);
    const pinching = updatePinch(hand.pinching, landmarks);
    if (mode === 'pinch') {
      const pinchPoint = midpoint(hand.points[THUMB_TIP], hand.points[INDEX_TIP]);
      if (pinching && !hand.pinching) hand.grabbing = startGrab(`hand-${key}`, pinchPoint);
      else if (pinching && hand.grabbing) moveGrab(`hand-${key}`, pinchPoint);
      else if (!pinching && hand.pinching && hand.grabbing) {
        releaseGrab(`hand-${key}`);
        hand.grabbing = false;
      }
    }
    hand.pinching = pinching;
  });
  // 見えなくなった手は、つまんでいた物を離す
  for (const [key, hand] of hands) {
    if (seen.has(key)) continue;
    if (hand.grabbing) {
      releaseGrab(`hand-${key}`);
      hand.grabbing = false;
    }
    hand.points = null;
  }
  badgeEl.textContent = seen.size > 0 ? `手 ${seen.size} 本` : '手をさがしています…';
  return view;
}

function drawHands(view) {
  const visible = [...hands.values()].filter((h) => h.points);
  const radius = jointRadius(view ?? visibleView());
  const matrix = new THREE.Matrix4();
  handViews.forEach((handView, n) => {
    const hand = visible[n];
    handView.group.visible = Boolean(hand);
    if (!hand) return;
    handView.joints.material = hand.pinching && mode === 'pinch' ? pinchMaterial : handMaterial;
    hand.points.forEach((p, i) => {
      matrix.makeScale(radius, radius, radius).setPosition(p[0], p[1], p[2]);
      handView.joints.setMatrixAt(i, matrix);
    });
    handView.joints.instanceMatrix.needsUpdate = true;
    const array = handView.bones.geometry.attributes.position.array;
    HAND_BONES.forEach(([a, b], i) => array.set([...hand.points[a], ...hand.points[b]], i * 6));
    handView.bones.geometry.attributes.position.needsUpdate = true;
  });
}

// 押すときの手の形。関節だけでなく骨の途中にも球を置いて、指や手のひらが途切れずに跡になるようにする
function handSpheres(view) {
  if (mode !== 'press') return [];
  const radius = jointRadius(view ?? visibleView());
  return [...hands.values()].filter((h) => h.points).flatMap((h) => {
    const centers = [...h.points];
    for (const [a, b] of HAND_BONES) {
      for (const t of [1 / 3, 2 / 3]) centers.push(h.points[a].map((v, k) => v + (h.points[b][k] - v) * t));
    }
    return centers.map((center) => ({ center, radius }));
  });
}

// ---- 指で操作（カメラを使わないとき） ----

const raycaster = new THREE.Raycaster();
let touch = null;

function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  ), camera);
}

function touchRadius() {
  return brushRadius() * 0.5;
}

// 指で押す球は、中心を表面より少し手前（カメラ側）に置く。中心が表面より奥にあると、
// 頂点が手前へ押し出されて、へこむどころか盛り上がってしまう
function pressPoint(surface, facing) {
  return surface.clone().addScaledVector(facing, -touchRadius() * 0.5).toArray();
}

function touchSpheres() {
  if (!touch || touch.mode !== 'press' || !touch.point) return [];
  return [{ center: touch.point, radius: touchRadius() }];
}

// OrbitControls より先に登録して、モデルにさわったときは視点が回らないようにする
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (stream || !model || touch) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointerRay(event);
  const [hit] = raycaster.intersectObjects(model.parts.map((p) => p.mesh), false);
  if (!hit) return;
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
  const facing = new THREE.Vector3();
  camera.getWorldDirection(facing);
  touch = { id: event.pointerId, mode, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing.clone().negate(), hit.point), facing };
  if (mode === 'pinch') startGrab('touch', hit.point.toArray());
  else touch.point = pressPoint(hit.point, facing);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!touch || event.pointerId !== touch.id) return;
  pointerRay(event);
  if (touch.mode === 'pinch') {
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(touch.plane, target)) moveGrab('touch', target.toArray());
  } else {
    const [hit] = raycaster.intersectObjects(model.parts.map((p) => p.mesh), false);
    if (hit) touch.point = pressPoint(hit.point, touch.facing);
  }
});
function endTouch(event) {
  if (!touch || event.pointerId !== touch.id) return;
  if (touch.mode === 'pinch') releaseGrab('touch');
  touch = null;
  controls.enabled = !stream;
}
renderer.domElement.addEventListener('pointerup', endTouch);
renderer.domElement.addEventListener('pointercancel', endTouch);

// ---- 保存（キャラクターはこのブラウザの IndexedDB だけに保存し、どこにも送らない） ----

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeMode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, storeMode);
      const request = action(transaction.objectStore(DB_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

async function useCharacter({ quiet = false } = {}) {
  try {
    const record = await withStore('readonly', (store) => store.get('current'));
    if (record?.data instanceof ArrayBuffer && detectFormat(record.name)) {
      await loadRecord(record);
      setStatus(`キャラクター（${record.name}）を読み込みました。`);
      return;
    }
  } catch (error) {
    console.warn(error);
  }
  if (!quiet) setStatus('キャラクターがまだありません。「3D モデルを読み込む」から選んでね。');
}

async function exportGlb() {
  settle();
  for (const part of model.parts) fillZeroNormals(part.mesh.geometry.attributes.normal.array);
  // 正面をカメラに向けるために回した分を戻して、ほかのゲームと同じ向きで書き出す
  const holder = new THREE.Group();
  holder.rotation.y = -model.facing;
  holder.add(...model.root.children.map((mesh) => mesh.clone()));
  return new GLTFExporter().parseAsync(holder, { binary: true });
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
  try {
    const data = await exportGlb();
    const record = { name: customName(model.name), format: 'glb', data, facing: model.facing };
    await withStore('readwrite', (store) => store.put(record, 'current'));
    setStatus(`「${record.name}」をキャラクターにしました。`);
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
cameraEl.addEventListener('click', () => (stream ? stopCamera() : startCamera()));
document.getElementById('recalibrate').addEventListener('click', () => {
  for (const key of hands.keys()) releaseHand(key);
  hands.clear();
  setStatus('奥行きを合わせ直しました。いまの手の位置が、モデルの手前になります。');
});
document.getElementById('reset').addEventListener('click', () => {
  clearInteractions();
  for (const part of model.parts) {
    part.positions.set(part.original);
    refresh(part);
  }
  setStatus('最初の形に戻しました。');
});
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    settle();
    mode = button.dataset.mode;
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b === button));
    document.getElementById('hint').textContent = HINTS[mode];
  });
}
elasticEl.addEventListener('change', settle);
showPreviewEl.addEventListener('change', () => { previewEl.hidden = !stream || !showPreviewEl.checked; });
for (const el of [radiusEl, handSizeEl]) el.addEventListener('input', updateLabels);

function updateLabels() {
  document.getElementById('radius-value').textContent = `${radiusEl.value}%`;
  document.getElementById('hand-size-value').textContent = `${handSizeEl.value}%`;
}

// ---- 描画 ----

function resetView() {
  camera.position.set(0, MODEL_HEIGHT / 2, 5);
  controls.target.set(0, MODEL_HEIGHT / 2, 0);
  controls.update();
}

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  handMaterial.color.set(cssValue('--accent'));
  pinchMaterial.color.set(cssValue('--piece-o'));
  boneMaterial.color.set(cssValue('--accent'));
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
resetView();
updateLabels();
document.getElementById('hint').textContent = HINTS[mode];
setModel(prepareModel(clayBall(), 'clay', 0));
useCharacter({ quiet: true });
const clock = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const view = trackHands(performance.now());
  if (stream) drawHands(view);
  if (model) {
    updateGrabs(dt);
    updatePress([...handSpheres(view), ...touchSpheres()], dt);
  }
  controls.update();
  renderer.render(scene, camera);
});
