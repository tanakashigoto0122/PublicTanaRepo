import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import * as CANNON from 'cannon-es';
import {
  BOOST, COURSE_LENGTH, PAD_BOOST, characterScale, courseLayout, detectFormat, distanceFrom, formatDistance,
  guessFacing, isResting, launchVelocity, markerPositions, restTimer, trajectory,
} from './logic.js';
import { MAX_HULL_POINTS, buildPolyhedron, farthestPointSample, strideIndices } from '../model-blocks/logic.js';

const STEP = 1 / 120;
const CHARACTER_HEIGHT = 2;
const CHARACTER_MASS = 5;
const START_X = 0;
// 発射台の上面の高さ
const PAD_TOP = 0.6;
// 引っぱりの最大の長さ（画面の短いほうの辺に対する割合）
const DRAG_RATIO = 0.4;
// 飛んでから止まるまでの、いちばん長い時間（秒）
const MAX_FLIGHT = 40;
const BEST_KEY = 'mini-games:launch-distance:best';
// キャラクターはメカ・ブラスターと同じ場所に保存する（どちらで読み込んでも両方で使えるように）
const DB_NAME = 'mini-games-mecha-blaster';
const DB_STORE = 'character';

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const distanceEl = document.getElementById('distance');
const bestEl = document.getElementById('best');
const hintEl = document.getElementById('hint');
const powerEl = document.getElementById('power');
const boostEl = document.getElementById('boost');
const overlayEl = document.getElementById('overlay');
const bounceEl = document.getElementById('bounce');
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
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x666666, 1.3);
// 影はキャラクターのまわりだけで十分なので、光はキャラクターについていく
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
scene.add(hemisphere, sun, sun.target);

const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 0.95 });
const ground = new THREE.Mesh(new THREE.BoxGeometry(COURSE_LENGTH + 60, 0.2, 8), groundMaterial);
ground.position.set(COURSE_LENGTH / 2, -0.1, 0);
ground.receiveShadow = true;
scene.add(ground);
const markerMaterial = new THREE.MeshStandardMaterial();
const featureMaterials = {
  trampoline: new THREE.MeshStandardMaterial({ roughness: 0.4 }),
  boost: new THREE.MeshStandardMaterial({ roughness: 0.4, emissiveIntensity: 0.4 }),
  mud: new THREE.MeshStandardMaterial({ roughness: 1 }),
};
const padMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6 });
const flagMaterial = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });

// 狙いの放物線（点線）
const AIM_POINTS = 80;
const aimPositions = new Float32Array(AIM_POINTS * 3);
const aimLine = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.25 }));
aimLine.geometry.setAttribute('position', new THREE.BufferAttribute(aimPositions, 3));
aimLine.geometry.setDrawRange(0, 0);
aimLine.frustumCulled = false;
scene.add(aimLine);

// キャラクターの見た目。物理の体と同じ位置・向きで動かす
const avatar = new THREE.Group();
scene.add(avatar);
let character = null;

// 自分のベスト記録の場所に立てる旗
const flag = new THREE.Group();
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3), markerMaterial);
pole.position.y = 1.5;
const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.6), flagMaterial);
cloth.position.set(0.5, 2.6, 0);
flag.add(pole, cloth);
flag.visible = false;
scene.add(flag);

// ---- 物理 ----

const world = new CANNON.World();
world.gravity.set(0, -9.82, 0);
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 10;
const groundPhysics = new CANNON.Material('ground');
const characterPhysics = new CANNON.Material('character');
const trampolinePhysics = new CANNON.Material('trampoline');
const mudPhysics = new CANNON.Material('mud');
const groundContact = new CANNON.ContactMaterial(groundPhysics, characterPhysics, { friction: 0.5, restitution: 0.4 });
world.addContactMaterial(groundContact);
// トランポリンは跳ね返りを 1 より少し大きくして、乗るたびに少し高く跳ねるようにする
world.addContactMaterial(new CANNON.ContactMaterial(trampolinePhysics, characterPhysics, { friction: 0.2, restitution: 1.05 }));
world.addContactMaterial(new CANNON.ContactMaterial(mudPhysics, characterPhysics, { friction: 2, restitution: 0 }));

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: groundPhysics });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

// 発射台
const padBody = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(1, PAD_TOP / 2, 1)), position: new CANNON.Vec3(START_X, PAD_TOP / 2, 0), material: groundPhysics });
world.addBody(padBody);
const padMesh = new THREE.Mesh(new THREE.BoxGeometry(2, PAD_TOP, 2), padMaterial);
padMesh.position.set(START_X, PAD_TOP / 2, 0);
padMesh.receiveShadow = true;
scene.add(padMesh);

// 横から見るゲームなので、キャラクターは奥行き方向へ動かさず、回るのも画面の中だけにする
const characterBody = new CANNON.Body({
  mass: CHARACTER_MASS,
  material: characterPhysics,
  angularDamping: 0.1,
  linearDamping: 0.01,
});
characterBody.linearFactor.set(1, 1, 0);
characterBody.angularFactor.set(0, 0, 1);
world.addBody(characterBody);

let course = [];
// 仕掛けの体と見た目
let featureObjects = [];
let state = 'aim';
let best = loadBest();
let rest = 0;
let flightTime = 0;
let boostUsed = false;
let drag = null;

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

function buildCourse() {
  for (const { body, mesh } of featureObjects) {
    world.removeBody(body);
    scene.remove(mesh);
  }
  featureObjects = [];
  course = courseLayout();
  for (const feature of course) {
    const height = feature.type === 'mud' ? 0.1 : 0.3;
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(feature.width / 2, height / 2, 2)),
      position: new CANNON.Vec3(feature.x + feature.width / 2, height / 2, 0),
      material: feature.type === 'trampoline' ? trampolinePhysics : feature.type === 'mud' ? mudPhysics : groundPhysics,
    });
    if (feature.type === 'boost') {
      // 触れたら 1 回だけ加速する（同じパッドの上で何度も加速しないように）
      body.addEventListener('collide', (event) => {
        if (event.body !== characterBody || feature.used) return;
        feature.used = true;
        characterBody.velocity.x += PAD_BOOST[0];
        characterBody.velocity.y += PAD_BOOST[1];
      });
    }
    world.addBody(body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(feature.width, height, 4), featureMaterials[feature.type]);
    mesh.position.copy(body.position);
    mesh.receiveShadow = true;
    scene.add(mesh);
    featureObjects.push({ body, mesh });
  }
}

// 25 m ごとに、距離を書いた札を立てる
function buildMarkers() {
  for (const x of markerPositions()) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    context.fillStyle = cssValue('--surface');
    context.fillRect(0, 0, 128, 64);
    context.fillStyle = cssValue('--text');
    context.font = 'bold 36px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`${x}m`, 64, 34);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sign.position.set(START_X + x, 2.2, -3);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8), markerMaterial);
    post.position.set(START_X + x, 0.9, -3);
    scene.add(sign, post);
  }
}

function resetCharacter() {
  // 細長いキャラクターは発射台の上で倒れてしまうので、発射するまでは動かない体にしておく
  characterBody.type = CANNON.Body.KINEMATIC;
  characterBody.position.set(START_X, PAD_TOP + CHARACTER_HEIGHT / 2 + 0.02, 0);
  characterBody.quaternion.set(0, 0, 0, 1);
  characterBody.velocity.setZero();
  characterBody.angularVelocity.setZero();
  for (const feature of course) feature.used = false;
  rest = 0;
  flightTime = 0;
  boostUsed = false;
  state = 'aim';
  hintEl.hidden = false;
  boostEl.hidden = true;
  overlayEl.hidden = true;
  powerEl.style.width = '0';
  updateHud();
  // 着地点に残ったカメラが戻ってくるのを待たずに、すぐ発射台を映す
  updateView(0, true);
}

function launch(velocity) {
  characterBody.type = CANNON.Body.DYNAMIC;
  characterBody.updateMassProperties();
  characterBody.wakeUp();
  characterBody.velocity.set(velocity.vx, velocity.vy, 0);
  // 少し回転をつけて、くるくる回りながら飛ばす
  characterBody.angularVelocity.set(0, 0, -2 - velocity.power * 4);
  state = 'flying';
  hintEl.hidden = true;
  boostEl.hidden = false;
  boostEl.disabled = false;
  aimLine.geometry.setDrawRange(0, 0);
  powerEl.style.width = '0';
}

function boost() {
  if (state !== 'flying' || boostUsed) return;
  boostUsed = true;
  characterBody.velocity.x += BOOST[0];
  characterBody.velocity.y += BOOST[1];
  boostEl.disabled = true;
}

function finish() {
  state = 'result';
  boostEl.hidden = true;
  const distance = distanceFrom(START_X, characterBody.position.x);
  const isBest = distance > best;
  if (isBest) {
    best = distance;
    saveBest();
  }
  placeFlag();
  document.getElementById('result-title').textContent = formatDistance(distance);
  document.getElementById('result-text').textContent = isBest ? 'ベスト更新！' : `ベストは ${formatDistance(best)}`;
  overlayEl.hidden = false;
  updateHud();
}

function placeFlag() {
  flag.visible = best > 0;
  flag.position.set(START_X + best, 0, -1.5);
}

function updateHud() {
  const current = state === 'aim' ? 0 : distanceFrom(START_X, characterBody.position.x);
  distanceEl.textContent = formatDistance(current);
  bestEl.textContent = `ベスト ${formatDistance(best)}`;
}

world.addEventListener('postStep', () => {
  if (state !== 'flying') return;
  flightTime += STEP;
  rest = restTimer(rest, characterBody.velocity.length(), STEP);
  if ((flightTime > 0.5 && isResting(rest)) || flightTime > MAX_FLIGHT) finish();
});

// ---- 入力（引っぱって離すと発射） ----

function maxDrag() {
  return Math.min(viewerEl.clientWidth, viewerEl.clientHeight) * DRAG_RATIO;
}

function showAim(velocity) {
  const start = [characterBody.position.x, characterBody.position.y];
  const points = velocity ? trajectory(start, [velocity.vx, velocity.vy], -world.gravity.y, { maxPoints: AIM_POINTS, step: 0.06 }) : [];
  points.forEach(([x, y], i) => aimPositions.set([x, y, 0], i * 3));
  aimLine.geometry.setDrawRange(0, points.length);
  aimLine.geometry.attributes.position.needsUpdate = true;
  powerEl.style.width = velocity ? `${Math.round(velocity.power * 100)}%` : '0';
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (state !== 'aim') return;
  renderer.domElement.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, velocity: null };
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  drag.velocity = launchVelocity(event.clientX - drag.x, event.clientY - drag.y, maxDrag());
  showAim(drag.velocity);
});
function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  const { velocity } = drag;
  drag = null;
  if (event.type === 'pointerup' && velocity && state === 'aim') launch(velocity);
  else showAim(null);
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
boostEl.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  boost();
});
viewerEl.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, select, textarea')) return;
  if (event.key === ' ') {
    event.preventDefault();
    if (state === 'flying') boost();
    else if (state === 'result') resetCharacter();
  }
});
document.getElementById('retry').addEventListener('click', resetCharacter);
document.getElementById('new-course').addEventListener('click', () => {
  buildCourse();
  resetCharacter();
  setStatus('コースを作り直しました。');
});
bounceEl.addEventListener('input', () => {
  groundContact.restitution = Number(bounceEl.value) / 100;
  document.getElementById('bounce-value').textContent = `${bounceEl.value}%`;
});

// ---- キャラクター ----

function defaultRobot() {
  const group = new THREE.Group();
  const material = (name) => new THREE.MeshStandardMaterial({ color: cssValue(name), roughness: 0.45, metalness: 0.2 });
  const part = (size, position, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(name));
    mesh.position.set(...position);
    group.add(mesh);
  };
  // 高さ 2、足元が y = -1、正面が +x（横から見て右を向く）
  part([0.5, 0.8, 0.8], [0, 0.15, 0], '--piece-j');
  part([0.45, 0.4, 0.45], [0, 0.8, 0], '--piece-i');
  part([0.05, 0.08, 0.36], [0.24, 0.82, 0], '--piece-o');
  part([0.3, 0.75, 0.25], [0, -0.62, -0.2], '--piece-t');
  part([0.3, 0.75, 0.25], [0, -0.62, 0.2], '--piece-t');
  part([0.25, 0.65, 0.2], [0, 0.12, -0.52], '--piece-j');
  part([0.25, 0.65, 0.2], [0, 0.12, 0.52], '--piece-j');
  return group;
}

// 高さ CHARACTER_HEIGHT、中心が原点、正面が +x になるようにそろえる
function fitCharacter(object, facing) {
  const box = new THREE.Box3().setFromObject(object);
  const scale = characterScale(box.getSize(new THREE.Vector3()).toArray());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center).multiplyScalar(scale);
  object.scale.multiplyScalar(scale);
  const wrapper = new THREE.Group();
  wrapper.add(object);
  // facing は正面を +z に向ける角度。さらに 90 度回して +x（進む向き）に向ける
  wrapper.rotation.y = facing + Math.PI / 2;
  return wrapper;
}

// キャラクターの見た目から、ラップで包んだような当たり判定の形を作る
function hullFromObject(object) {
  object.updateMatrixWorld(true);
  const meshes = [];
  object.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  const points = [];
  const vertex = new THREE.Vector3();
  for (const mesh of meshes) {
    const position = mesh.geometry.attributes.position;
    for (const i of strideIndices(position.count, Math.ceil((3000 * position.count) / total))) {
      points.push(vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).toArray());
    }
  }
  const chosen = farthestPointSample(points, MAX_HULL_POINTS);
  try {
    const hull = new ConvexHull().setFromPoints(chosen.map((p) => new THREE.Vector3(...p)));
    const loops = hull.faces.map((face) => {
      const loop = [];
      let edge = face.edge;
      do {
        loop.push(edge.head().point.toArray());
        edge = edge.next;
      } while (edge !== face.edge);
      return loop;
    });
    const { vertices, faces } = buildPolyhedron(loops);
    if (vertices.length >= 4 && faces.length >= 4) {
      // 物理エンジンは形の原点が形の内側にある前提なので、頂点の平均を原点にしてずらして付ける
      const offset = [0, 1, 2].map((k) => vertices.reduce((sum, v) => sum + v[k], 0) / vertices.length);
      const shape = new CANNON.ConvexPolyhedron({
        vertices: vertices.map((v) => new CANNON.Vec3(v[0] - offset[0], v[1] - offset[1], v[2] - offset[2])),
        faces,
      });
      return { shape, offset: new CANNON.Vec3(...offset) };
    }
  } catch (error) {
    console.warn(error);
  }
  // 作れなければ外枠の箱にする
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return { shape: new CANNON.Box(new CANNON.Vec3(Math.max(size.x, 0.1) / 2, size.y / 2, Math.max(size.z, 0.1) / 2)), offset: new CANNON.Vec3() };
}

function setCharacter(object, record) {
  if (character) avatar.remove(character.object);
  object.traverse((child) => {
    if (child.isMesh) child.castShadow = true;
  });
  character = { object, custom: Boolean(record), record };
  avatar.add(object);
  // 当たり判定の形を作り直す（見た目と同じ形・同じ向き）
  while (characterBody.shapes.length > 0) characterBody.removeShape(characterBody.shapes[0]);
  const { shape, offset } = hullFromObject(object);
  characterBody.addShape(shape, offset);
  characterBody.updateMassProperties();
  characterNameEl.textContent = record ? `いまのキャラクター：${record.name}` : 'いまのキャラクター：仮のロボ';
  if (state !== 'flying') resetCharacter();
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
  setStatus(`「${file.name}」をキャラクターにしました。`);
});
document.getElementById('turn').addEventListener('click', async () => {
  if (!character?.custom) return setStatus('仮のロボは向きを回せません。');
  character.record.facing += Math.PI / 2;
  await useRecord(character.record);
  await saveCharacter(character.record);
});
document.getElementById('default-character').addEventListener('click', async () => {
  setCharacter(defaultRobot(), null);
  await saveCharacter(null);
  setStatus('仮のロボに戻しました。');
});

// ---- 描画 ----

// カメラの置き場所。狙っている間は、放物線の出だしが見えるよう前のほうまで広く映す。
// 飛んでいる間は横から追いかけ、高く・速く飛ぶほど引いて広く見せる
function cameraGoal() {
  if (state === 'aim') {
    // 発射台が画面の左端に来るように、画面の横幅（縦長か横長か）から中心を決める
    const depth = 22;
    const halfWidth = depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    return { position: new THREE.Vector3(START_X - 2 + halfWidth, 6, depth), lookY: 4 };
  }
  const height = Math.max(0, characterBody.position.y);
  const distance = 16 + height * 0.6 + characterBody.velocity.length() * 0.15;
  return {
    position: new THREE.Vector3(characterBody.position.x + 4, Math.max(3, height * 0.7 + 3), distance),
    lookY: Math.max(1.5, height * 0.7),
  };
}

function updateView(frameSeconds, snap = false) {
  avatar.position.copy(characterBody.position);
  avatar.quaternion.copy(characterBody.quaternion);
  if (state === 'flying') updateHud();
  const goal = cameraGoal();
  camera.position.lerp(goal.position, snap ? 1 : Math.min(1, frameSeconds * 4));
  camera.lookAt(camera.position.x, goal.lookY, 0);
  sun.position.set(characterBody.position.x + 6, 20, 10);
  sun.target.position.set(characterBody.position.x, 0, 0);
}

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  groundMaterial.color.set(cssValue('--bg'));
  markerMaterial.color.set(cssValue('--muted'));
  padMaterial.color.set(cssValue('--border'));
  flagMaterial.color.set(cssValue('--piece-z'));
  featureMaterials.trampoline.color.set(cssValue('--piece-i'));
  featureMaterials.boost.color.set(cssValue('--piece-o'));
  featureMaterials.boost.emissive.set(cssValue('--piece-o'));
  featureMaterials.mud.color.set(cssValue('--piece-l'));
  aimLine.material.color.set(cssValue('--accent'));
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
buildCourse();
buildMarkers();
setCharacter(defaultRobot(), null);
placeFlag();
bounceEl.dispatchEvent(new Event('input'));
loadSavedCharacter();
const clock = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  clock.update(time);
  world.fixedStep(STEP, 10);
  updateView(Math.min(clock.getDelta(), 0.1));
  renderer.render(scene, camera);
});
