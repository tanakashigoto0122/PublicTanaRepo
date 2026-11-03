import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';
import {
  FALL_LIMIT, MAX_BODIES, SHAPES, addGlue, breakForce, dropPosition, glueKey, gravityY, hasGlue, massOf,
  newGluePairs, removeGlue, removeGluesOf, restitution, stiffnessParams,
} from './logic.js';

const STEP = 1 / 60;
// タップと判定する指の移動量（ピクセル）。これより動いたらドラッグとみなす
const TAP_TOLERANCE = 6;
// つかんで引っぱる力の上限（ニュートン）。弱い接着なら引っぱると外れる
const GRAB_FORCE = 150;
const PALETTE = ['--piece-z', '--piece-l', '--piece-o', '--piece-s', '--piece-i', '--piece-j', '--piece-t'];
const HINTS = {
  place: '床や物体をタップすると、その上から落ちてくる。',
  glue: '触れ合っている 2 つを順にタップするとくっつく。2 つ目に床をタップすると床に固定できる。',
  unglue: 'タップした物体の接着をすべてはがす。',
  remove: 'タップした物体を消す。',
};

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
  stiffness: document.getElementById('stiffness'),
  strength: document.getElementById('strength'),
  bounce: document.getElementById('bounce'),
  gravity: document.getElementById('gravity'),
};

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
sun.position.set(6, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
scene.add(hemisphere, sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = null;

// 接着を表す線。物体に隠れても見えるように一番手前に描く
const glueLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ depthTest: false, transparent: true }),
);
glueLines.renderOrder = 10;
glueLines.frustumCulled = false;
scene.add(glueLines);

const geometries = {
  box: new THREE.BoxGeometry(...SHAPES.box.size),
  plank: new THREE.BoxGeometry(...SHAPES.plank.size),
  pillar: new THREE.BoxGeometry(...SHAPES.pillar.size),
  sphere: new THREE.SphereGeometry(SHAPES.sphere.radius, 32, 24),
  cylinder: new THREE.CylinderGeometry(SHAPES.cylinder.radius, SHAPES.cylinder.radius, SHAPES.cylinder.height, 32),
};

// ---- 物理 ----

const world = new CANNON.World();
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 20;
world.defaultContactMaterial.friction = 0.5;
const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

function physicsShape(kind) {
  const shape = SHAPES[kind];
  if (shape.type === 'box') return new CANNON.Box(new CANNON.Vec3(...shape.size.map((v) => v / 2)));
  if (shape.type === 'sphere') return new CANNON.Sphere(shape.radius);
  return new CANNON.Cylinder(shape.radius, shape.radius, shape.height, 16);
}

// body.id → { body, mesh, kind }
const objects = new Map();
let glues = [];
// glueKey → LockConstraint
const constraints = new Map();
// 「置いたら着地した相手とくっつく」で、まだ何にも触れていない物体
const waitingToLand = new Set();

let mode = 'place';
let colorChoice = 'random';
let paused = false;
let glueFirst = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function updateCounts() {
  countsEl.textContent = `物体 ${objects.size} 個 / 接着 ${glues.length} 本`;
}

function bodyById(id) {
  return id === floorBody.id ? floorBody : objects.get(id)?.body ?? null;
}

function pickColor() {
  const name = colorChoice === 'random' ? PALETTE[Math.floor(Math.random() * PALETTE.length)] : colorChoice;
  return cssValue(name);
}

function spawn(kind, position, { yaw = 0, color = pickColor() } = {}) {
  if (objects.size >= MAX_BODIES) {
    setStatus(`物体は ${MAX_BODIES} 個までです。いくつか消してから置いてね。`);
    return null;
  }
  const body = new CANNON.Body({ mass: massOf(kind), shape: physicsShape(kind), position: new CANNON.Vec3(...position) });
  body.quaternion.setFromEuler(0, yaw, 0);
  const mesh = new THREE.Mesh(geometries[kind], new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.bodyId = body.id;
  world.addBody(body);
  scene.add(mesh);
  objects.set(body.id, { body, mesh, kind });
  if (autoGlueEl.checked) waitingToLand.add(body.id);
  syncMesh(objects.get(body.id));
  updateCounts();
  return body;
}

function removeObject(id) {
  const object = objects.get(id);
  if (!object) return;
  ungluesOf(id);
  if (glueFirst === id) setGlueFirst(null);
  world.removeBody(object.body);
  scene.remove(object.mesh);
  object.mesh.material.dispose();
  objects.delete(id);
  waitingToLand.delete(id);
  updateCounts();
}

function applyJointStiffness(constraint) {
  const { jointStiffness, relaxation } = stiffnessParams(Number(sliders.stiffness.value));
  for (const equation of constraint.equations) equation.setSpookParams(jointStiffness, relaxation, STEP);
}

function glue(idA, idB) {
  if (idA === idB || hasGlue(glues, idA, idB)) return false;
  const constraint = new CANNON.LockConstraint(bodyById(idA), bodyById(idB));
  applyJointStiffness(constraint);
  world.addConstraint(constraint);
  constraints.set(glueKey(idA, idB), constraint);
  glues = addGlue(glues, idA, idB);
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
  const count = glues.length;
  for (const g of glues.filter((g) => g.a === id || g.b === id)) unglue(g.a, g.b);
  glues = removeGluesOf(glues, id);
  return count - glues.length;
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

function applySettings() {
  const stiffness = Number(sliders.stiffness.value);
  const params = stiffnessParams(stiffness);
  const contact = world.defaultContactMaterial;
  contact.contactEquationStiffness = params.contactStiffness;
  contact.contactEquationRelaxation = params.relaxation;
  contact.restitution = restitution(Number(sliders.bounce.value));
  world.gravity.set(0, gravityY(Number(sliders.gravity.value)), 0);
  for (const constraint of constraints.values()) applyJointStiffness(constraint);

  const strength = breakForce(Number(sliders.strength.value));
  document.getElementById('stiffness-value').textContent = stiffness <= 30 ? `${stiffness}（ぷるぷる）` : stiffness >= 70 ? `${stiffness}（カチカチ）` : String(stiffness);
  document.getElementById('strength-value').textContent = strength === Infinity ? '外れない' : `${Math.round(strength)} N で外れる`;
  document.getElementById('bounce-value').textContent = sliders.bounce.value;
  document.getElementById('gravity-value').textContent = `${sliders.gravity.value}%`;
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
  // 着地したらその相手とくっつける（床に着地したときはくっつけない）
  if (waitingToLand.size > 0) {
    for (const { a, b } of currentContacts()) {
      for (const [self, other] of [[a, b], [b, a]]) {
        if (!waitingToLand.has(self)) continue;
        waitingToLand.delete(self);
        if (other !== floorBody.id) glue(self, other);
      }
    }
  }
  for (const [id, object] of objects) {
    if (object.body.position.y < FALL_LIMIT) removeObject(id);
  }
});

// ---- 描画の更新 ----

function syncMesh({ body, mesh }) {
  mesh.position.copy(body.position);
  mesh.quaternion.copy(body.quaternion);
}

const linePositions = new Float32Array(MAX_BODIES * 8 * 6);
glueLines.geometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));

function updateGlueLines() {
  let i = 0;
  for (const g of glues) {
    if (i + 6 > linePositions.length) break;
    const a = bodyById(g.a);
    const b = bodyById(g.b);
    // 床との接着は、物体の真下の床に線を引く
    const from = a === floorBody ? [b.position.x, 0, b.position.z] : [a.position.x, a.position.y, a.position.z];
    const to = b === floorBody ? [a.position.x, 0, a.position.z] : [b.position.x, b.position.y, b.position.z];
    linePositions.set([...from, ...to], i);
    i += 6;
  }
  glueLines.geometry.setDrawRange(0, i / 3);
  glueLines.geometry.attributes.position.needsUpdate = true;
}

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  ground.material.color.set(cssValue('--bg'));
  glueLines.material.color.set(cssValue('--accent'));
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
  if (glueFirst !== null) objects.get(glueFirst)?.mesh.material.emissive.setRGB(0, 0, 0);
  glueFirst = id;
  if (id !== null) objects.get(id).mesh.material.emissive.set(cssValue('--accent')).multiplyScalar(0.45);
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
  const [hit] = raycaster.intersectObjects([...meshes, ground], false);
  if (!hit) return null;
  return { id: hit.object === ground ? floorBody.id : hit.object.userData.bodyId, point: hit.point };
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

function onTap(event) {
  const hit = pick(event);
  if (!hit) return;
  const onObject = hit.id !== floorBody.id;
  if (mode === 'place') {
    const kind = kindEl.value;
    // 板や柱が画面に対して横向きに見えるよう、カメラの向きに合わせて回して置く
    if (spawn(kind, dropPosition(hit.point.toArray(), kind), { yaw: orbit.getAzimuthalAngle() })) setStatus('');
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
    setStatus(onObject ? 'くっつけました。' : '床に固定しました。');
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

// 柱 2 本の上に板を渡して接着した門。柱は床にも固定する
function placeSample() {
  const yaw = orbit.getAzimuthalAngle();
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const base = orbit.target.clone().setY(0);
  const offset = (d) => base.clone().addScaledVector(right, d);
  const color = cssValue('--piece-z');
  const left = offset(-1.1);
  const rightPillar = offset(1.1);
  const pillarA = spawn('pillar', [left.x, 1, left.z], { yaw, color });
  const pillarB = spawn('pillar', [rightPillar.x, 1, rightPillar.z], { yaw, color });
  const plank = spawn('plank', [base.x, 2.125, base.z], { yaw, color: cssValue('--piece-o') });
  if (!pillarA || !pillarB || !plank) return;
  for (const id of [pillarA.id, pillarB.id, plank.id]) waitingToLand.delete(id);
  glue(pillarA.id, floorBody.id);
  glue(pillarB.id, floorBody.id);
  glue(pillarA.id, plank.id);
  glue(pillarB.id, plank.id);
  setStatus('お手本の門を置きました。つかんで揺らしたり、硬さを変えたりしてみてね。');
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
  // 床とはくっつけない（全体を持ち上げられるように）
  const pairs = newGluePairs(glues, currentContacts()).filter((g) => g.a !== floorBody.id && g.b !== floorBody.id);
  for (const { a, b } of pairs) glue(a, b);
  setStatus(pairs.length > 0 ? `${pairs.length} か所くっつけました。` : '新しくくっつけられる所はありません。');
});
document.getElementById('sample').addEventListener('click', placeSample);
document.getElementById('reset-view').addEventListener('click', resetView);
document.getElementById('clear').addEventListener('click', () => {
  for (const id of [...objects.keys()]) removeObject(id);
  setStatus('全部消しました。');
});
for (const slider of Object.values(sliders)) slider.addEventListener('input', applySettings);

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
renderer.setAnimationLoop(() => {
  if (!paused) world.fixedStep(STEP, 5);
  for (const object of objects.values()) syncMesh(object);
  updateGlueLines();
  orbit.update();
  renderer.render(scene, camera);
});
