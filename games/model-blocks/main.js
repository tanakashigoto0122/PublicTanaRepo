import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import * as CANNON from 'cannon-es';
import {
  FALL_LIMIT, HARDNESS_STEPS, MAX_BODIES, MAX_HULL_POINTS, MAX_SAMPLE_POINTS, PARTS, SHAPES, SOLVER_ITERATIONS,
  addGlue, boxSize, breakForce, buildPolyhedron, contactParams, detectFormat, dropPosition, farthestPointSample,
  glueKey, gravityY, hasGlue, isValidModelRecord, jointParams, massOf, modelMass, newGluePairs, normalizeScale,
  pairHardness, partLayout, placePieces, quantizeHardness, removeGlue, restitution, setAllStiffness,
  setStiffnessOf, strideIndices,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { parseModel, plainMaterial } from '../shared/models.js';
import { objectStore } from '../shared/storage.js';

const STEP = 1 / 60;
// タップと判定する指の移動量（ピクセル）。これより動いたらドラッグとみなす
const TAP_TOLERANCE = 6;
// つかんで引っぱる力の上限（ニュートン）。弱い接着なら引っぱると外れる
const GRAB_FORCE = 150;
// 曲がるパーツを床から浮かせて置く高さ
const PART_GAP = 0.8;
// 物理エンジンには転がり抵抗がないので、回転を少し減衰させて球や円柱がいつまでも転がらないようにする
const ANGULAR_DAMPING = 0.6;
const PALETTE = ['--piece-z', '--piece-l', '--piece-o', '--piece-s', '--piece-i', '--piece-j', '--piece-t'];
const HINTS = {
  place: '床や物体をタップすると、その上から落ちてくる。読み込んだ自分のモデルも選べる。「物体の硬さ」と「接着の硬さ」（曲がるパーツの継ぎ目）が使われる。',
  glue: '触れ合っている 2 つを順にタップすると、今の「接着の硬さ」でくっつく。2 つ目に床をタップすると床に固定できる。',
  paint: 'タップした物体（曲がるパーツならパーツ全体）を、今の「物体の硬さ」と「接着の硬さ」に塗り替える。',
  unglue: 'タップした物体の接着をすべてはがす。',
  remove: 'タップした物体を消す。曲がるパーツはピース 1 つずつ消える。',
};
// 持ち込んだモデルは当たり判定の計算が重いので、置ける数を別に制限する
const MAX_MODEL_OBJECTS = 30;
// 持ち込んだモデルを置くとき、床から浮かせる高さ
const MODEL_GAP = 0.5;
// これより細かいモデルは、たくさん置くとスマホでは重くなりやすいので、読み込んだときに知らせる
const HEAVY_TRIANGLES = 300000;

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const countsEl = document.getElementById('counts');
const kindEl = document.getElementById('kind');
const pauseEl = document.getElementById('pause');
const autoGlueEl = document.getElementById('auto-glue');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const swatches = [...document.querySelectorAll('.swatch')];
const sliders = {
  hardness: document.getElementById('hardness'),
  joint: document.getElementById('joint'),
  strength: document.getElementById('strength'),
  bounce: document.getElementById('bounce'),
  gravity: document.getElementById('gravity'),
};

// 色は style.css の CSS 変数から読む（ダークモードの切り替えにも追従する）
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
sun.position.set(6, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
// 持ち込んだモデルは両面描画の素材が多く、影が縞模様に映り込みやすいので少しずらす
sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
scene.add(hemisphere, sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = null;

// 接着を表す線。硬さで色を変え、物体に隠れても見えるように一番手前に描く
const glueLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
);
glueLines.renderOrder = 10;
glueLines.frustumCulled = false;
scene.add(glueLines);
const lineColors = { soft: new THREE.Color(), hard: new THREE.Color(), ball: new THREE.Color() };

const geometryCache = new Map();
function geometryFor(kind, size) {
  const key = size ? `box:${size.join(',')}` : kind;
  if (!geometryCache.has(key)) {
    const shape = SHAPES[kind];
    let geometry;
    if (size || shape.type === 'box') geometry = new THREE.BoxGeometry(...(size ?? shape.size));
    else if (shape.type === 'sphere') geometry = new THREE.SphereGeometry(shape.radius, 32, 24);
    else geometry = new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, 32);
    geometryCache.set(key, geometry);
  }
  return geometryCache.get(key);
}

// ---- 物理 ----

const world = new CANNON.World();
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = SOLVER_ITERATIONS;

// 硬さの段階ごとに素材を用意し、すべての組み合わせの接触を「柔らかいほう」に合わせて設定する
const materials = new Map(HARDNESS_STEPS.map((h) => [h, new CANNON.Material(`hardness-${h}`)]));
const contactMaterials = [];
for (const a of HARDNESS_STEPS) {
  for (const b of HARDNESS_STEPS) {
    if (b < a) continue;
    const { stiffness, relaxation } = contactParams(pairHardness(a, b));
    const contact = new CANNON.ContactMaterial(materials.get(a), materials.get(b), {
      friction: 0.5,
      contactEquationStiffness: stiffness,
      contactEquationRelaxation: relaxation,
    });
    world.addContactMaterial(contact);
    contactMaterials.push(contact);
  }
}

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: materials.get(100) });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

function physicsShape(kind, size) {
  if (size) return new CANNON.Box(new CANNON.Vec3(...size.map((v) => v / 2)));
  const shape = SHAPES[kind];
  if (shape.type === 'box') return new CANNON.Box(new CANNON.Vec3(...shape.size.map((v) => v / 2)));
  if (shape.type === 'sphere') return new CANNON.Sphere(shape.radius);
  return new CANNON.Cylinder(shape.radius, shape.radius, shape.height, 16);
}

// body.id → { body, mesh, hardness, partId }。partId は曲がるパーツのピースだけが持つ
const objects = new Map();
let glues = [];
// glueKey → 物理エンジンの継ぎ手
const constraints = new Map();
// 「置いたら着地した相手とくっつく」で、まだ何にも触れていない物体
const waitingToLand = new Set();
let nextPartId = 1;

let mode = 'place';
let colorChoice = 'random';
let paused = false;
let glueFirst = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function updateCounts() {
  const models = [...objects.values()].filter((o) => o.modelId).length;
  countsEl.textContent = `物体 ${objects.size} 個（うち自分のモデル ${models} 個） / 接着 ${glues.length} 本`;
}

function bodyById(id) {
  return id === floorBody.id ? floorBody : objects.get(id)?.body ?? null;
}

function pickColor() {
  const name = colorChoice === 'random' ? PALETTE[Math.floor(Math.random() * PALETTE.length)] : colorChoice;
  return cssValue(name);
}

function currentHardness() {
  return quantizeHardness(Number(sliders.hardness.value));
}

function currentJointStiffness() {
  return Number(sliders.joint.value);
}

function eachMaterial(object3d, callback) {
  object3d.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) callback(material);
  });
}

// 柔らかい物体ほどツヤを出して、ぷにっとした見た目にする。持ち込んだモデルは元の質感のままにする
function applyHardnessLook(object) {
  if (object.modelId) return;
  object.mesh.material.roughness = 0.2 + 0.45 * (object.hardness / 100);
}

function setHardness(object, hardness) {
  object.hardness = hardness;
  object.body.material = materials.get(hardness);
  applyHardnessLook(object);
}

function spawnBody(kind, position, { yaw = 0, color, hardness, size = null, partId = null }) {
  const mass = size ? size[0] * size[1] * size[2] : massOf(kind);
  const body = new CANNON.Body({
    mass,
    shape: physicsShape(kind, size),
    position: new CANNON.Vec3(...position),
    angularDamping: ANGULAR_DAMPING,
  });
  body.quaternion.setFromEuler(0, yaw, 0);
  const mesh = new THREE.Mesh(geometryFor(kind, size), new THREE.MeshStandardMaterial({ color }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.bodyId = body.id;
  world.addBody(body);
  scene.add(mesh);
  const object = { body, mesh, hardness, partId };
  setHardness(object, hardness);
  objects.set(body.id, object);
  syncMesh(object);
  return body;
}

function hasRoomFor(count) {
  if (objects.size + count <= MAX_BODIES) return true;
  setStatus(`物体は ${MAX_BODIES} 個までです。いくつか消してから置いてね。`);
  return false;
}

function spawn(kind, position, { yaw = 0, color = pickColor(), hardness = currentHardness() } = {}) {
  if (!hasRoomFor(1)) return null;
  const body = spawnBody(kind, position, { yaw, color, hardness });
  if (autoGlueEl.checked) waitingToLand.add(body.id);
  updateCounts();
  return body;
}

// 曲がるパーツは小さな箱をつないで作る。origin はパーツの底の中心
function spawnPart(kind, origin, { yaw = 0, color = pickColor(), hardness = currentHardness(), stiffness = currentJointStiffness() } = {}) {
  const pieces = placePieces(kind, origin, yaw);
  if (!hasRoomFor(pieces.length)) return null;
  const partId = nextPartId++;
  const bodies = pieces.map(({ size, position }) => spawnBody(kind, position, { yaw, color, hardness, size, partId }));
  for (const joint of partLayout(kind).joints) {
    glue(bodies[joint.i].id, bodies[joint.j].id, {
      type: joint.type,
      stiffness,
      internal: joint.internal,
      pivots: joint.type === 'ball' ? [joint.pivotI, joint.pivotJ] : null,
    });
  }
  if (autoGlueEl.checked) for (const body of bodies) waitingToLand.add(body.id);
  updateCounts();
  return bodies;
}

function removeObject(id) {
  const object = objects.get(id);
  if (!object) return;
  ungluesOf(id);
  if (glueFirst === id) setGlueFirst(null);
  world.removeBody(object.body);
  scene.remove(object.mesh);
  // 持ち込んだモデルの形（geometry）はほかの複製と共有しているので消さない。素材は置くたびに複製している
  eachMaterial(object.mesh, (material) => material.dispose());
  objects.delete(id);
  waitingToLand.delete(id);
  updateCounts();
}

function applyJointParams(constraint, stiffness) {
  const params = jointParams(stiffness);
  for (const equation of constraint.equations) equation.setSpookParams(params.stiffness, params.relaxation, STEP);
}

// internal は曲がるパーツの継ぎ目。つながったピースどうしはぶつからないようにして、めり込みながら曲がれるようにする
function glue(idA, idB, { type = 'lock', stiffness = currentJointStiffness(), internal = false, pivots = null } = {}) {
  if (idA === idB || hasGlue(glues, idA, idB)) return false;
  const bodyA = bodyById(idA);
  const bodyB = bodyById(idB);
  const constraint = type === 'ball'
    ? new CANNON.PointToPointConstraint(bodyA, new CANNON.Vec3(...pivots[0]), bodyB, new CANNON.Vec3(...pivots[1]))
    : new CANNON.LockConstraint(bodyA, bodyB);
  constraint.collideConnected = !internal;
  if (type === 'lock') applyJointParams(constraint, stiffness);
  world.addConstraint(constraint);
  constraints.set(glueKey(idA, idB), constraint);
  glues = addGlue(glues, idA, idB, { type, stiffness });
  updateCounts();
  return true;
}

function unglue(idA, idB) {
  const key = glueKey(idA, idB);
  const constraint = constraints.get(key);
  if (constraint) world.removeConstraint(constraint);
  constraints.delete(key);
  glues = removeGlue(glues, idA, idB);
  updateCounts();
}

function ungluesOf(id) {
  const targets = glues.filter((g) => g.a === id || g.b === id);
  for (const g of targets) unglue(g.a, g.b);
  return targets.length;
}

// 物理エンジンの継ぎ手の硬さを、glues に記録した硬さに合わせる
function refreshJointParams() {
  for (const g of glues) {
    if (g.type === 'lock') applyJointParams(constraints.get(glueKey(g.a, g.b)), g.stiffness);
  }
}

// 直前の計算で触れ合っていた組。床もふくむ
function currentContacts() {
  return world.contacts
    .filter((c) => c.bi === floorBody || objects.has(c.bi.id))
    .filter((c) => c.bj === floorBody || objects.has(c.bj.id))
    .map((c) => ({ a: c.bi.id, b: c.bj.id }));
}

function touching(idA, idB) {
  return currentContacts().some((c) => (c.a === idA && c.b === idB) || (c.a === idB && c.b === idA));
}

function describeLevel(level) {
  return level <= 30 ? `${level}（ぷるぷる）` : level >= 70 ? `${level}（カチカチ）` : String(level);
}

function applySettings() {
  const bounce = restitution(Number(sliders.bounce.value));
  for (const contact of contactMaterials) contact.restitution = bounce;
  world.gravity.set(0, gravityY(Number(sliders.gravity.value)), 0);

  const strength = breakForce(Number(sliders.strength.value));
  document.getElementById('hardness-value').textContent = describeLevel(currentHardness());
  document.getElementById('joint-value').textContent = describeLevel(currentJointStiffness());
  document.getElementById('strength-value').textContent = strength === Infinity ? '外れない' : `${Math.round(strength)} N で外れる`;
  document.getElementById('bounce-value').textContent = sliders.bounce.value;
  document.getElementById('gravity-value').textContent = `${sliders.gravity.value}%`;
  document.getElementById('model-size-value').textContent = `${Number(modelSizeEl.value).toFixed(1)} m`;
}

world.addEventListener('postStep', () => {
  // 接着にかかる力が強さを超えたら外す
  const limit = breakForce(Number(sliders.strength.value));
  if (limit !== Infinity) {
    for (const g of [...glues]) {
      const constraint = constraints.get(glueKey(g.a, g.b));
      const load = Math.max(...constraint.equations.map((e) => Math.abs(e.multiplier)));
      if (load > limit) unglue(g.a, g.b);
    }
  }
  // 着地したらその相手とくっつける（床と、同じパーツのピースどうしはくっつけない）
  if (waitingToLand.size > 0) {
    for (const { a, b } of currentContacts()) {
      for (const [self, other] of [[a, b], [b, a]]) {
        if (!waitingToLand.has(self)) continue;
        if (other !== floorBody.id && samePart(self, other)) continue;
        waitingToLand.delete(self);
        if (other !== floorBody.id) glue(self, other);
      }
    }
  }
  for (const [id, object] of objects) {
    if (object.body.position.y < FALL_LIMIT) removeObject(id);
  }
});

function samePart(idA, idB) {
  const a = objects.get(idA)?.partId ?? null;
  return a !== null && a === (objects.get(idB)?.partId ?? null);
}

// ---- 持ち込んだ 3D モデル ----

const fileEl = document.getElementById('model-file');
const libraryEl = document.getElementById('library');
const modelOptionsEl = document.getElementById('model-options');
const modelSizeEl = document.getElementById('model-size');
const collisionEl = document.getElementById('collision');
// id → { record, template, points, size, tintable }。template は一番長い辺が 1、中心が原点になるようにそろえたもの
const modelLibrary = new Map();
const shapeCache = new Map();
let storageAvailable = true;

// モデルを、一番長い辺が 1・外枠の中心が原点になるようにそろえ、当たり判定に使う点を選んでおく
function prepareModel(record, object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('形がないモデル');
  const size = box.getSize(new THREE.Vector3()).toArray();
  object.position.sub(box.getCenter(new THREE.Vector3()));
  const unit = new THREE.Group();
  unit.add(object);
  unit.scale.setScalar(normalizeScale(size, 1));
  const template = new THREE.Group();
  template.add(unit);
  template.updateMatrixWorld(true);

  const meshes = [];
  template.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    meshes.push(child);
  });
  const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  const points = [];
  const vertex = new THREE.Vector3();
  for (const mesh of meshes) {
    const position = mesh.geometry.attributes.position;
    const share = Math.ceil((MAX_SAMPLE_POINTS * position.count) / total);
    for (const i of strideIndices(position.count, share)) {
      points.push(vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).toArray());
    }
  }
  return {
    record,
    template,
    points: farthestPointSample(points, MAX_HULL_POINTS),
    size: size.map((v) => v * normalizeScale(size, 1)),
    // 色や質感を持たない形式は、置くときに選んだ色で塗る
    tintable: record.format === 'obj' || record.format === 'stl',
    triangles: meshes.reduce((sum, mesh) => {
      const { index, attributes } = mesh.geometry;
      return sum + (index ? index.count : attributes.position.count) / 3;
    }, 0),
  };
}

// 選んだ点を包む凸包を物理エンジンの形にする。点が平面に並んでいるなどで作れなければ null。
// 物理エンジンは形の原点が形の内側にあるものとして計算するので、凸包の頂点の平均を原点にずらし、
// そのずれ（offset）は物体に形を付けるときに戻す。
function hullShape(points, scale) {
  try {
    const hull = new ConvexHull().setFromPoints(points.map((p) => new THREE.Vector3(...p).multiplyScalar(scale)));
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
    if (vertices.length < 4 || faces.length < 4) return null;
    const offset = [0, 1, 2].map((k) => vertices.reduce((sum, v) => sum + v[k], 0) / vertices.length);
    const shape = new CANNON.ConvexPolyhedron({
      vertices: vertices.map((v) => new CANNON.Vec3(v[0] - offset[0], v[1] - offset[1], v[2] - offset[2])),
      faces,
    });
    return { shape, offset: new CANNON.Vec3(...offset) };
  } catch {
    return null;
  }
}

function modelShape(model, scale, mode) {
  const key = `${model.record.id}:${scale}:${mode}`;
  if (!shapeCache.has(key)) {
    const hull = mode === 'hull' ? hullShape(model.points, scale) : null;
    const half = boxSize(model.size.map((v) => v * scale)).map((v) => v / 2);
    shapeCache.set(key, hull ?? { shape: new CANNON.Box(new CANNON.Vec3(...half)), offset: new CANNON.Vec3() });
  }
  return shapeCache.get(key);
}

function spawnModel(modelId, point, yaw) {
  const model = modelLibrary.get(modelId);
  if (!model) return null;
  const placed = [...objects.values()].filter((o) => o.modelId).length;
  if (placed >= MAX_MODEL_OBJECTS) {
    setStatus(`自分のモデルは ${MAX_MODEL_OBJECTS} 個まで置けます。いくつか消してから置いてね。`);
    return null;
  }
  if (!hasRoomFor(1)) return null;
  const scale = Number(modelSizeEl.value);
  const size = model.size.map((v) => v * scale);
  const body = new CANNON.Body({
    mass: modelMass(size),
    position: new CANNON.Vec3(point.x, Math.max(point.y, 0) + size[1] / 2 + MODEL_GAP, point.z),
    angularDamping: ANGULAR_DAMPING,
  });
  const { shape, offset } = modelShape(model, scale, collisionEl.value);
  body.addShape(shape, offset);
  body.quaternion.setFromEuler(0, yaw, 0);
  // 素材は置くたびに複製する（くっつける相手を光らせたり、色を塗ったりしても、ほかの複製に移らないように）
  const mesh = model.template.clone(true);
  const color = model.tintable ? pickColor() : null;
  mesh.traverse((child) => {
    if (!child.isMesh) return;
    child.material = Array.isArray(child.material) ? child.material.map((m) => m.clone()) : child.material.clone();
  });
  if (color) eachMaterial(mesh, (material) => material.color?.set(color));
  mesh.scale.setScalar(scale);
  mesh.userData.bodyId = body.id;
  world.addBody(body);
  scene.add(mesh);
  const object = { body, mesh, hardness: currentHardness(), partId: null, modelId };
  setHardness(object, object.hardness);
  objects.set(body.id, object);
  syncMesh(object);
  if (autoGlueEl.checked) waitingToLand.add(body.id);
  updateCounts();
  return body;
}

// ---- 持ち込んだモデルの保存（このブラウザの IndexedDB だけに保存し、どこにも送らない） ----

const withStore = objectStore('mini-games-model-blocks', 'models', { keyPath: 'id' });

async function storeRecord(action, value) {
  if (!storageAvailable) return;
  try {
    await withStore('readwrite', (store) => store[action](value));
  } catch (error) {
    console.warn(error);
    storageAvailable = false;
    setStatus('このブラウザには保存できないので、読み込んだモデルはページを閉じると消えます。');
  }
}

function newModelId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderLibrary() {
  modelOptionsEl.replaceChildren();
  libraryEl.replaceChildren();
  for (const [id, model] of modelLibrary) {
    const option = document.createElement('option');
    option.value = `model:${id}`;
    option.textContent = model.record.name;
    modelOptionsEl.append(option);

    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = model.record.name;
    const choose = document.createElement('button');
    choose.textContent = '置く';
    choose.addEventListener('click', () => {
      kindEl.value = `model:${id}`;
      setMode('place');
      setStatus(`「${model.record.name}」を選びました。床をタップすると置けます。`);
    });
    const remove = document.createElement('button');
    remove.textContent = '一覧から消す';
    remove.addEventListener('click', async () => {
      modelLibrary.delete(id);
      if (kindEl.value === `model:${id}`) kindEl.value = 'box';
      renderLibrary();
      await storeRecord('delete', id);
      setStatus(`「${model.record.name}」を一覧から消しました（置いてあるものは残ります）。`);
    });
    item.append(name, choose, remove);
    libraryEl.append(item);
  }
  libraryEl.hidden = modelLibrary.size === 0;
  modelOptionsEl.hidden = modelLibrary.size === 0;
}

async function addToLibrary(record) {
  const model = prepareModel(record, await parseModel(record, { material: () => plainMaterial({ side: THREE.DoubleSide }), stlNormals: true }));
  modelLibrary.set(record.id, model);
  renderLibrary();
  return model;
}

async function importFile(file) {
  const format = detectFormat(file.name);
  if (!format) {
    setStatus(`「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`);
    return;
  }
  setStatus(`「${file.name}」を読み込み中…`);
  const record = { id: newModelId(), name: file.name, format, data: await file.arrayBuffer(), addedAt: Date.now() };
  let model;
  try {
    model = await addToLibrary(record);
  } catch (error) {
    console.warn(error);
    const hint = format === 'gltf' ? '（.gltf は別ファイルの .bin や画像を読み込めないので、.glb がおすすめ）' : '';
    setStatus(`「${file.name}」を読み込めませんでした。${hint}`);
    return;
  }
  kindEl.value = `model:${record.id}`;
  setMode('place');
  const heavy = model.triangles > HEAVY_TRIANGLES
    ? `とても細かいモデル（約 ${Math.round(model.triangles / 10000)} 万ポリゴン）なので、たくさん置くと重くなるかも。`
    : '';
  setStatus(`「${file.name}」を読み込みました。床をタップすると置けます。${heavy}`);
  await storeRecord('put', record);
}

async function loadSavedModels() {
  let records = [];
  try {
    records = await withStore('readonly', (store) => store.getAll());
  } catch (error) {
    console.warn(error);
    storageAvailable = false;
    return;
  }
  // 読み込んだ順に並べる
  records.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
  for (const record of records.filter(isValidModelRecord)) {
    try {
      await addToLibrary(record);
    } catch (error) {
      console.warn(error);
    }
  }
}

fileEl.addEventListener('change', async () => {
  for (const file of fileEl.files) await importFile(file);
  fileEl.value = '';
});
viewerEl.addEventListener('dragover', (event) => event.preventDefault());
viewerEl.addEventListener('drop', async (event) => {
  event.preventDefault();
  for (const file of event.dataTransfer.files) await importFile(file);
});

// ---- 描画の更新 ----

function syncMesh({ body, mesh }) {
  mesh.position.copy(body.position);
  mesh.quaternion.copy(body.quaternion);
}

const MAX_LINES = MAX_BODIES * 4;
const linePositions = new Float32Array(MAX_LINES * 6);
const lineColorValues = new Float32Array(MAX_LINES * 6);
glueLines.geometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
glueLines.geometry.setAttribute('color', new THREE.BufferAttribute(lineColorValues, 3));
const lineColor = new THREE.Color();

function updateGlueLines() {
  let i = 0;
  for (const g of glues) {
    if (i + 6 > linePositions.length) break;
    // 曲がるパーツの中の継ぎ目は線を引かない（パーツの中が線だらけになるので）
    if (samePart(g.a, g.b)) continue;
    const a = bodyById(g.a);
    const b = bodyById(g.b);
    // 床との接着は、物体の真下の床に線を引く
    const from = a === floorBody ? [b.position.x, 0, b.position.z] : [a.position.x, a.position.y, a.position.z];
    const to = b === floorBody ? [a.position.x, 0, a.position.z] : [b.position.x, b.position.y, b.position.z];
    linePositions.set([...from, ...to], i);
    if (g.type === 'ball') lineColor.copy(lineColors.ball);
    else lineColor.lerpColors(lineColors.soft, lineColors.hard, g.stiffness / 100);
    lineColorValues.set([lineColor.r, lineColor.g, lineColor.b, lineColor.r, lineColor.g, lineColor.b], i);
    i += 6;
  }
  glueLines.geometry.setDrawRange(0, i / 3);
  glueLines.geometry.attributes.position.needsUpdate = true;
  glueLines.geometry.attributes.color.needsUpdate = true;
}

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  ground.material.color.set(cssValue('--bg'));
  lineColors.soft.set(cssValue('--piece-l'));
  lineColors.hard.set(cssValue('--piece-j'));
  lineColors.ball.set(cssValue('--piece-s'));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(60, 60, cssValue('--muted'), cssValue('--border'));
  grid.position.y = 0.002;
  scene.add(grid);
  if (glueFirst !== null) setGlueFirst(glueFirst);
}

function setGlueFirst(id) {
  const previous = glueFirst === null ? null : objects.get(glueFirst);
  if (previous) eachMaterial(previous.mesh, (material) => material.emissive?.setRGB(0, 0, 0));
  glueFirst = id;
  if (id === null) return;
  const highlight = new THREE.Color(cssValue('--accent')).multiplyScalar(0.45);
  eachMaterial(objects.get(id).mesh, (material) => material.emissive?.copy(highlight));
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// ---- 入力 ----

const raycaster = new THREE.Raycaster();

function castRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
}

// 物体か床に当たった点を返す。{ id, point } で、床なら id は床の id
function pick(event) {
  castRay(event);
  const meshes = [...objects.values()].map((o) => o.mesh);
  // 持ち込んだモデルは中に複数のメッシュを持つので、当たったメッシュから物体の id を持つ親までたどる
  const [hit] = raycaster.intersectObjects([...meshes, ground], true);
  if (!hit) return null;
  if (hit.object === ground) return { id: floorBody.id, point: hit.point };
  let node = hit.object;
  while (node && node.userData.bodyId === undefined) node = node.parent;
  return node ? { id: node.userData.bodyId, point: hit.point } : null;
}

let gesture = null;
let grab = null;
const activePointers = new Set();

function startGrab(id, point) {
  const { body } = objects.get(id);
  const handle = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, position: new CANNON.Vec3(point.x, point.y, point.z) });
  handle.collisionResponse = false;
  handle.collisionFilterGroup = 0;
  handle.collisionFilterMask = 0;
  const pivot = body.pointToLocalFrame(new CANNON.Vec3(point.x, point.y, point.z));
  const constraint = new CANNON.PointToPointConstraint(body, pivot, handle, new CANNON.Vec3(0, 0, 0), GRAB_FORCE);
  world.addBody(handle);
  world.addConstraint(constraint);
  // つかんでいる間はくるくる回りすぎないようにする
  const damping = { linear: body.linearDamping, angular: body.angularDamping };
  body.linearDamping = 0.4;
  body.angularDamping = 0.9;
  // カメラの方を向いた縦の面の上で動かす（左右と上下に動かせる）
  const facing = new THREE.Vector3();
  camera.getWorldDirection(facing);
  facing.y = 0;
  if (facing.lengthSq() < 1e-6) facing.set(0, 0, -1);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing.normalize(), point);
  grab = { body, handle, constraint, damping, plane };
}

function moveGrab(event) {
  castRay(event);
  const target = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(grab.plane, target)) return;
  grab.handle.position.set(target.x, Math.max(target.y, 0.05), target.z);
}

function endGrab() {
  if (!grab) return;
  world.removeConstraint(grab.constraint);
  world.removeBody(grab.handle);
  grab.body.linearDamping = grab.damping.linear;
  grab.body.angularDamping = grab.damping.angular;
  grab = null;
}

// 曲がるパーツのピースならパーツ全体、そうでなければその物体だけ
function partMembers(id) {
  const partId = objects.get(id).partId;
  if (partId === null) return [id];
  return [...objects].filter(([, o]) => o.partId === partId).map(([memberId]) => memberId);
}

function paint(id) {
  const hardness = currentHardness();
  const stiffness = currentJointStiffness();
  const members = partMembers(id);
  for (const memberId of members) {
    setHardness(objects.get(memberId), hardness);
    glues = setStiffnessOf(glues, memberId, stiffness);
  }
  refreshJointParams();
  const what = members.length > 1 ? 'パーツ全体' : 'この物体';
  setStatus(`${what}を、物体の硬さ ${hardness}・接着の硬さ ${stiffness} にしました。`);
}

function onTap(event) {
  const hit = pick(event);
  if (!hit) return;
  const onObject = hit.id !== floorBody.id;
  if (mode === 'place') {
    const kind = kindEl.value;
    // 板や柱が画面に対して横向きに見えるよう、カメラの向きに合わせて回して置く
    const yaw = orbit.getAzimuthalAngle();
    if (kind.startsWith('model:')) {
      if (spawnModel(kind.slice('model:'.length), hit.point, yaw)) setStatus('');
      return;
    }
    const placed = PARTS[kind]
      ? spawnPart(kind, [hit.point.x, Math.max(hit.point.y, 0) + PART_GAP, hit.point.z], { yaw })
      : spawn(kind, dropPosition(hit.point.toArray(), kind), { yaw });
    if (placed) setStatus('');
  } else if (mode === 'glue') {
    if (glueFirst === null) {
      if (!onObject) return setStatus('まず物体をタップしてね。');
      setGlueFirst(hit.id);
      return setStatus('くっつける相手（物体か床）をタップしてね。');
    }
    const first = glueFirst;
    setGlueFirst(null);
    if (first === hit.id) return setStatus('選ぶのをやめました。');
    if (hasGlue(glues, first, hit.id)) return setStatus('もうくっついています。');
    if (!touching(first, hit.id)) return setStatus('触れていないのでくっつけられません。近づけてからもう一度。');
    glue(first, hit.id);
    setStatus(`${onObject ? 'くっつけました' : '床に固定しました'}（接着の硬さ ${currentJointStiffness()}）。`);
  } else if (mode === 'paint') {
    if (onObject) paint(hit.id);
  } else if (mode === 'unglue') {
    if (!onObject) return;
    const count = ungluesOf(hit.id);
    setStatus(count > 0 ? `${count} 本はがしました。` : 'この物体は何ともくっついていません。');
  } else if (mode === 'remove') {
    if (onObject) removeObject(hit.id);
  }
}

// OrbitControls より先に登録して、物体をつかんだときは視点が回らないようにする
renderer.domElement.addEventListener('pointerdown', (event) => {
  activePointers.add(event.pointerId);
  if (activePointers.size > 1) {
    // 2 本指は拡大・移動に使うので、つかむのをやめる
    endGrab();
    gesture = null;
    orbit.enabled = true;
    return;
  }
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const hit = pick(event);
  const onObject = hit && hit.id !== floorBody.id;
  gesture = { x: event.clientX, y: event.clientY, hit: onObject ? hit : null, moved: false };
  orbit.enabled = !onObject;
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!gesture) return;
  if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > TAP_TOLERANCE) {
    gesture.moved = true;
    if (gesture.hit && objects.has(gesture.hit.id)) {
      renderer.domElement.setPointerCapture(event.pointerId);
      startGrab(gesture.hit.id, gesture.hit.point);
    }
  }
  if (grab) moveGrab(event);
});
function onPointerEnd(event) {
  activePointers.delete(event.pointerId);
  if (gesture && !gesture.moved && event.type === 'pointerup') onTap(event);
  endGrab();
  gesture = null;
  if (activePointers.size === 0) orbit.enabled = true;
}
renderer.domElement.addEventListener('pointerup', onPointerEnd);
renderer.domElement.addEventListener('pointercancel', onPointerEnd);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI / 2 - 0.05;

function resetView() {
  camera.position.set(7, 6, 9);
  orbit.target.set(0, 1, 0);
  orbit.update();
}

function setMode(next) {
  mode = next;
  setGlueFirst(null);
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === next));
  hintEl.textContent = HINTS[next];
  setStatus('');
}

// 床に固定した柱から、しなる板を突き出した飛び込み台。先の上に柔らかい球を落とし、横にゼリーを置く
function placeSample() {
  if (!hasRoomFor(1 + 6 + 8 + 1)) return;
  const pillar = spawn('pillar', [-2, 1, 0], { color: cssValue('--piece-z'), hardness: 100 });
  waitingToLand.delete(pillar.id);
  glue(pillar.id, floorBody.id, { stiffness: 100 });
  // しなる板の左端のピースが柱の真上に来るように置く（左端のピースの中心は底の中心から 1.25 左）
  const plank = spawnPart('bendy', [-2 + 1.25, 2, 0], { color: cssValue('--piece-o'), hardness: 100, stiffness: 45 });
  glue(pillar.id, plank[0].id, { stiffness: 100 });
  for (const body of plank) waitingToLand.delete(body.id);
  const ball = spawn('sphere', [0.25, 4, 0], { color: cssValue('--piece-s'), hardness: 0 });
  waitingToLand.delete(ball.id);
  const jelly = spawnPart('jelly', [2.2, 0.4, 2], { color: cssValue('--piece-t'), hardness: 50, stiffness: 25 });
  for (const body of jelly) waitingToLand.delete(body.id);
  setStatus('お手本を置きました。しなる板やゼリーをつかんで揺らしてみてね。');
}

for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
document.getElementById('colors').addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (!swatch) return;
  colorChoice = swatch.dataset.color;
  for (const s of swatches) s.setAttribute('aria-pressed', String(s === swatch));
});
pauseEl.addEventListener('click', () => {
  paused = !paused;
  pauseEl.textContent = paused ? '再開' : '一時停止';
});
document.getElementById('glue-all').addEventListener('click', () => {
  // 床とはくっつけない（全体を持ち上げられるように）。同じパーツのピースどうしも、継ぎ目以外はくっつけない
  const pairs = newGluePairs(glues, currentContacts())
    .filter((g) => g.a !== floorBody.id && g.b !== floorBody.id && !samePart(g.a, g.b));
  for (const { a, b } of pairs) glue(a, b);
  setStatus(pairs.length > 0 ? `${pairs.length} か所くっつけました。` : '新しくくっつけられる所はありません。');
});
document.getElementById('set-all').addEventListener('click', () => {
  glues = setAllStiffness(glues, currentJointStiffness());
  refreshJointParams();
  setStatus(`全部の接着を硬さ ${currentJointStiffness()} にしました（ロープの首振りはそのまま）。`);
});
document.getElementById('sample').addEventListener('click', placeSample);
document.getElementById('reset-view').addEventListener('click', resetView);
document.getElementById('clear').addEventListener('click', () => {
  for (const id of [...objects.keys()]) removeObject(id);
  setStatus('全部消しました。');
});
for (const slider of Object.values(sliders)) slider.addEventListener('input', applySettings);
modelSizeEl.addEventListener('input', applySettings);

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

resize();
applyTheme();
applySettings();
resetView();
setMode('place');
updateCounts();
placeSample();
setStatus('');
renderLibrary();
loadSavedModels();
renderer.setAnimationLoop(() => {
  if (!paused) world.fixedStep(STEP, 5);
  for (const object of objects.values()) syncMesh(object);
  updateGlueLines();
  orbit.update();
  renderer.render(scene, camera);
});
