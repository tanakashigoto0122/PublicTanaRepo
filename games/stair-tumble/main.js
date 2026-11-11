import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  DOLL_HEIGHT, FLOOR_LENGTH, LANDING, PART_NAMES, STAIR_WIDTH, assignParts, displayName, guessFacing, impactScore,
  layoutRagdoll, pushPower, stairBoxes, toFloatArray, updateSettle,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { parseModel } from '../shared/models.js';
import { listCharacters, readCharacter } from '../shared/storage.js';

const STEP = 1 / 120;
const DOLL = 'doll';
const BEST_KEY = 'mini-games:stair-tumble:best';
// 押す強さが 1 のとき、体全体に与える速さ（m/s）
const PUSH_SPEED = 5;
const MAX_FALL_TIME = 15;
const GROUP_STAGE = 1;
const GROUP_DOLL = 2;

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const overlayEl = document.getElementById('overlay');
const hitEl = document.getElementById('hit');
const characterEl = document.getElementById('character');

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555555, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-3, 9, 6);
scene.add(hemisphere, sun);

// ---- 物理の世界と階段 ----

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.defaultContactMaterial.friction = 0.5;
world.defaultContactMaterial.restitution = 0.15;
world.solver.iterations = 20;
const stair = stairBoxes();
const stageMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });
const edgeMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });

function addStaticBox(center, half, material) {
  const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(...half)), collisionFilterGroup: GROUP_STAGE });
  body.position.set(...center);
  world.addBody(body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2), material);
  mesh.position.set(...center);
  scene.add(mesh);
  return body;
}

for (const { center, half } of stair.boxes) addStaticBox(center, half, stageMaterial);
// 段の縁に細い線を引いて、段を見やすくする
for (let i = 0; i < stair.boxes.length; i++) {
  const { center, half } = stair.boxes[i];
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, STAIR_WIDTH), edgeMaterial);
  edge.position.set(center[0] + half[0] - 0.02, center[1] + half[1] + 0.005, 0);
  scene.add(edge);
}
// 床（階段の下）
const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), collisionFilterGroup: GROUP_STAGE });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);
const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_LENGTH + stair.bottomX + LANDING + 10, STAIR_WIDTH * 4), new THREE.MeshStandardMaterial({ roughness: 1 }));
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.position.x = (stair.bottomX + FLOOR_LENGTH) / 2;
scene.add(floorMesh);
// 床の先の壁と、奥と手前の見えない壁（横へ落ちていかないように）
addStaticBox([stair.bottomX + FLOOR_LENGTH, 1, 0], [0.2, 1, STAIR_WIDTH * 2], stageMaterial);
for (const z of [-1, 1]) {
  const wall = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(30, 10, 0.1)), collisionFilterGroup: GROUP_STAGE });
  wall.position.set(5, 5, z * (STAIR_WIDTH / 2 + 0.1));
  world.addBody(wall);
}

// 階段の下に置く、ぶつかって崩れる箱
const props = [];
const propMaterials = [];
function addProps() {
  for (const prop of props) {
    world.removeBody(prop.body);
    scene.remove(prop.mesh);
  }
  props.length = 0;
  const size = 0.45;
  const baseX = stair.bottomX + 2.2;
  const layout = [[0, 0, -0.5], [0, 0, 0], [0, 0, 0.5], [0, 1, -0.25], [0, 1, 0.25], [0, 2, 0]];
  layout.forEach(([dx, row, z], i) => {
    const body = new CANNON.Body({ mass: 0.6, shape: new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2)), collisionFilterGroup: GROUP_STAGE });
    body.position.set(baseX + dx, size / 2 + row * size, z);
    world.addBody(body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), propMaterials[i % propMaterials.length]);
    scene.add(mesh);
    props.push({ body, mesh });
  });
}

// ---- 人形 ----

let doll = null;
let library = [];

// 立たせる位置（踊り場の端の近く。足元）
function startPosition() {
  return [-0.7, stair.top + 0.01, 0];
}

function makeBodies(layout, offset) {
  const bodies = layout.parts.map((part) => {
    const shape = part.shape === 'sphere'
      ? new CANNON.Sphere(part.radius)
      : new CANNON.Box(new CANNON.Vec3(...part.half));
    const volume = part.shape === 'sphere' ? (4 / 3) * Math.PI * part.radius ** 3 : 8 * part.half[0] * part.half[1] * part.half[2];
    const body = new CANNON.Body({
      mass: Math.max(0.2, volume * 300),
      shape,
      collisionFilterGroup: GROUP_DOLL,
      collisionFilterMask: GROUP_STAGE,
      linearDamping: 0.05,
      angularDamping: 0.2,
    });
    body.position.set(...part.center.map((v, k) => v + offset[k]));
    body.partName = part.name;
    return body;
  });
  const byName = new Map(layout.parts.map((part, i) => [part.name, bodies[i]]));
  const constraints = layout.joints.map((joint) => {
    const a = byName.get(joint.a);
    const b = byName.get(joint.b);
    const pivot = new CANNON.Vec3(...joint.pivot.map((v, k) => v + offset[k]));
    // 関節の軸は、親から子の真ん中へ向かう向き
    const axis = b.position.vsub(pivot);
    if (axis.length() < 1e-6) axis.set(0, -1, 0);
    axis.normalize();
    return new CANNON.ConeTwistConstraint(a, b, {
      pivotA: pivot.vsub(a.position),
      pivotB: pivot.vsub(b.position),
      axisA: axis,
      axisB: axis,
      angle: joint.angle,
      twistAngle: joint.twist,
      collideConnected: false,
    });
  });
  return { bodies, constraints };
}

// 自分のキャラクターを、高さ DOLL_HEIGHT・正面 +z にそろえた頂点にする
function bakeCharacter(object, facing) {
  const holder = new THREE.Group();
  holder.add(object);
  holder.rotation.y = facing;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? DOLL_HEIGHT / size.y : 1;
  const normalize = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  const meshes = [];
  holder.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry.clone();
    for (const name of Object.keys(geometry.attributes)) {
      if (name.startsWith('skin')) geometry.deleteAttribute(name);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(toFloatArray(geometry.attributes.position), 3));
    geometry.deleteAttribute('normal');
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(normalize, child.matrixWorld));
    geometry.computeVertexNormals();
    const material = Array.isArray(child.material) ? child.material.map((m) => m.clone()) : child.material.clone();
    meshes.push({ geometry, material });
  });
  if (meshes.length === 0) throw new Error('メッシュがないモデル');
  return { meshes, size: size.multiplyScalar(scale) };
}

// 仮の人形：部位の形をそのまま見せる
function dollMeshes(layout) {
  const colors = { head: '--piece-o', chest: '--piece-j', pelvis: '--piece-t' };
  return layout.parts.map((part) => {
    const geometry = part.shape === 'sphere'
      ? new THREE.SphereGeometry(part.radius, 24, 16)
      : new THREE.BoxGeometry(part.half[0] * 2, part.half[1] * 2, part.half[2] * 2);
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: cssValue(colors[part.name] ?? '--piece-i'), roughness: 0.6 }));
  });
}

function disposeDoll() {
  if (!doll) return;
  for (const body of doll.bodies) world.removeBody(body);
  for (const constraint of doll.constraints) world.removeConstraint(constraint);
  scene.remove(doll.rig);
  doll.rig.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.dispose();
    for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose();
  });
  doll = null;
}

async function buildDoll() {
  const choice = characterEl.value;
  const record = library.find((r) => r.id === choice);
  let baked = null;
  if (record) {
    try {
      const object = await parseModel(record, { stlNormals: true });
      const facing = record.facing ?? guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
      baked = bakeCharacter(object, facing);
    } catch (error) {
      console.warn(error);
      setStatus('キャラクターを読み込めなかったので、仮の人形にしました。');
    }
  }
  if (characterEl.value !== choice) return;
  disposeDoll();
  const size = baked ? { height: baked.size.y, width: baked.size.x, depth: baked.size.z } : { height: DOLL_HEIGHT, width: 0.5, depth: 0.3 };
  const layout = layoutRagdoll(size);
  const offset = startPosition();
  const { bodies, constraints } = makeBodies(layout, offset);
  const rig = new THREE.Group();
  // 部位ごとの骨。物理の体と同じ位置・向きで動かす
  const bones = layout.parts.map((part, i) => {
    const bone = new THREE.Bone();
    bone.position.copy(bodies[i].position);
    rig.add(bone);
    return bone;
  });
  // 押す場所を選ぶための、見えない部位の形
  const pickers = layout.parts.map((part, i) => {
    const geometry = part.shape === 'sphere'
      ? new THREE.SphereGeometry(part.radius * 1.3, 12, 8)
      : new THREE.BoxGeometry(part.half[0] * 2.6, part.half[1] * 2.2, part.half[2] * 2.6);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
    mesh.partIndex = i;
    bones[i].add(mesh);
    return mesh;
  });
  scene.add(rig);
  rig.updateMatrixWorld(true);
  if (baked) {
    const skeleton = new THREE.Skeleton(bones);
    for (const { geometry, material } of baked.meshes) {
      geometry.translate(...offset);
      const shifted = layout.parts.map((part) => ({ ...part, center: part.center.map((v, k) => v + offset[k]) }));
      const { indices, weights } = assignParts(geometry.attributes.position.array, shifted, DOLL_HEIGHT * 0.06);
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      const mesh = new THREE.SkinnedMesh(geometry, material);
      mesh.frustumCulled = false;
      rig.add(mesh);
      mesh.bind(skeleton, new THREE.Matrix4());
    }
  } else {
    dollMeshes(layout).forEach((mesh, i) => bones[i].add(mesh));
  }
  for (const body of bodies) {
    world.addBody(body);
    body.addEventListener('collide', onCollide);
  }
  for (const constraint of constraints) world.addConstraint(constraint);
  doll = { bodies, constraints, bones, pickers, rig, layout, name: record ? displayName(record.name) : '仮の人形' };
  syncDoll();
}

function syncDoll() {
  doll.bodies.forEach((body, i) => {
    doll.bones[i].position.copy(body.position);
    doll.bones[i].quaternion.copy(body.quaternion);
  });
}

function fillCharacterSelect(currentId) {
  characterEl.replaceChildren(new Option('仮の人形', DOLL), ...library.map((r) => new Option(displayName(r.name), r.id)));
  characterEl.value = library.some((r) => r.id === currentId) ? currentId : DOLL;
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
  fillCharacterSelect(currentId);
  await buildDoll();
}

// ---- 点数 ----

let state = 'ready';
let score = 0;
let best = loadBest();
let fallTime = 0;
let settle = { time: 0, settled: false };
let hitTimer = 0;
const lastHit = new Map();

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
  document.getElementById('score').textContent = `${score.toLocaleString()} 点`;
  document.getElementById('best').textContent = `ベスト ${best.toLocaleString()}`;
}

function onCollide(event) {
  if (state !== 'falling') return;
  const part = event.target.partName;
  // 同じ部位が続けてぶつかったときは、少し間をあける
  const now = fallTime;
  if (now - (lastHit.get(part) ?? -1) < 0.15) return;
  const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
  const points = impactScore(speed, part);
  if (points <= 0) return;
  lastHit.set(part, now);
  score += points;
  hitEl.textContent = `${PART_NAMES[part] ?? ''} +${points}`;
  hitTimer = 0.8;
  updateHud();
}

function resetRun() {
  state = 'ready';
  score = 0;
  fallTime = 0;
  settle = { time: 0, settled: false };
  lastHit.clear();
  hitEl.textContent = '';
  overlayEl.hidden = true;
  addProps();
  updateHud();
}

async function restart() {
  resetRun();
  await buildDoll();
  cameraTarget.set(...startPosition()).add(new THREE.Vector3(1.5, 0.6, 0));
}

function finishRun() {
  state = 'over';
  const isBest = score > best;
  if (isBest) {
    best = score;
    saveBest();
  }
  updateHud();
  document.getElementById('overlay-title').textContent = `${score.toLocaleString()} 点`;
  document.getElementById('overlay-text').textContent = isBest ? 'ベスト更新！' : `ベストは ${best.toLocaleString()} 点`;
  overlayEl.hidden = false;
}

// ---- 押す ----

const raycaster = new THREE.Raycaster();
let drag = null;
const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffffff, 0.25, 0.15);
arrow.visible = false;
scene.add(arrow);

function pointerNdc(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (state !== 'ready' || !doll || drag) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  raycaster.setFromCamera(pointerNdc(event), camera);
  const [hit] = raycaster.intersectObjects(doll.pickers, false);
  if (!hit) return;
  drag = { id: event.pointerId, part: hit.object.partIndex, point: hit.point.clone(), x: event.clientX, y: event.clientY, power: 0, dir: new THREE.Vector3() };
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  // 引っぱった向きに押す。カメラは手前（+z）から見ているので、画面の右が +x、上が +y
  const dx = event.clientX - drag.x;
  const dy = drag.y - event.clientY;
  drag.power = pushPower(Math.hypot(dx, dy), viewerEl.clientHeight);
  drag.dir.set(dx, dy, 0).normalize();
  arrow.visible = drag.power > 0.05;
  arrow.position.copy(drag.point);
  arrow.setDirection(drag.dir.lengthSq() > 0 ? drag.dir : new THREE.Vector3(1, 0, 0));
  arrow.setLength(0.3 + drag.power * 1.5, 0.25, 0.15);
});
function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  const { part, point, power, dir } = drag;
  drag = null;
  arrow.visible = false;
  if (event.type === 'pointercancel' || power < 0.05) return;
  push(part, point, dir, power);
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

function push(partIndex, point, dir, power) {
  // 1 か所だけに全部の力をかけると、関節が引きちぎれて体が暴れる。
  // 体全体に半分の速さを与え、押した部位には押した所へ残りの力をかけて、倒れ方（回り方）を変える
  const speed = PUSH_SPEED * power;
  const velocity = new CANNON.Vec3(dir.x, dir.y, 0).scale(speed * 0.5);
  for (const body of doll.bodies) {
    body.velocity.vadd(velocity, body.velocity);
    body.wakeUp();
  }
  const body = doll.bodies[partIndex];
  body.applyImpulse(new CANNON.Vec3(dir.x, dir.y, 0).scale(body.mass * speed), new CANNON.Vec3(point.x, point.y, point.z));
  state = 'falling';
  setStatus(`${PART_NAMES[doll.layout.parts[partIndex].name]}を強さ ${Math.round(power * 100)}% で押した！`);
}

// ---- 進行と描画 ----

document.getElementById('again').addEventListener('click', restart);
document.getElementById('reset').addEventListener('click', restart);
characterEl.addEventListener('change', restart);

const propColorNames = ['--piece-s', '--piece-o', '--piece-z'];
for (let i = 0; i < propColorNames.length; i++) propMaterials.push(new THREE.MeshStandardMaterial({ roughness: 0.7 }));

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  stageMaterial.color.set(cssValue('--bg'));
  edgeMaterial.color.set(cssValue('--muted'));
  floorMesh.material.color.set(cssValue('--bg'));
  arrow.setColor(cssValue('--piece-z'));
  propMaterials.forEach((m, i) => m.color.set(cssValue(propColorNames[i])));
}

// カメラは横（手前）から、人形の腰を追いかける
const cameraTarget = new THREE.Vector3();
const VISIBLE_HALF_WIDTH = 3.2;

function updateCamera(dt, snap = false) {
  if (doll) {
    const pelvis = doll.bodies[doll.layout.parts.findIndex((p) => p.name === 'pelvis')].position;
    const goal = new THREE.Vector3(pelvis.x + (state === 'ready' ? 1.5 : 0.8), Math.max(1.2, pelvis.y + 0.2), 0);
    if (snap) cameraTarget.copy(goal);
    else cameraTarget.lerp(goal, Math.min(1, dt * 3));
  }
  const distance = Math.max(6, VISIBLE_HALF_WIDTH / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  camera.position.set(cameraTarget.x - 0.6, cameraTarget.y + distance * 0.25, distance);
  camera.lookAt(cameraTarget);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  updateCamera(0, true);
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
resize();
resetRun();
loadCharacters().then(() => {
  updateCamera(0, true);
  setStatus(`${doll.name}を、押したい所から指で引っぱって離すと突き飛ばす。`);
});

const clock = new THREE.Timer();
let leftover = 0;
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const frame = Math.min(clock.getDelta(), 0.1);
  if (state === 'falling' || state === 'over') {
    leftover = Math.min(leftover + frame, STEP * 5);
    while (leftover >= STEP) {
      world.step(STEP);
      if (state === 'falling') fallTime += STEP;
      leftover -= STEP;
    }
    for (const prop of props) {
      prop.mesh.position.copy(prop.body.position);
      prop.mesh.quaternion.copy(prop.body.quaternion);
    }
    if (doll) syncDoll();
    if (state === 'falling') {
      settle = updateSettle(settle, doll.bodies.map((b) => b.velocity.length()), frame);
      if (settle.settled || fallTime > MAX_FALL_TIME) finishRun();
    }
  }
  hitTimer = Math.max(0, hitTimer - frame);
  hitEl.style.opacity = String(Math.min(1, hitTimer * 2));
  updateCamera(frame);
  renderer.render(scene, camera);
});
