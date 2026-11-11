import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  BACKGROUNDS, CHARACTER_HEIGHT, FILTERS, MAX_CHARACTERS, MAX_STAMPS, STAGE_HALF, STAMPS, clamp01, clampToStage,
  createStamp, displayName, guessFacing, lightPosition, photoFileName, resizeStamp, slotPosition, stampPixels,
  starPositions,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { clayBall, loadModel } from '../shared/models.js';
import { listCharacters, readCharacter } from '../shared/storage.js';

const ROBOT = 'robot';
const CLAY = 'clay';

const viewerEl = document.getElementById('viewer');
const stampsEl = document.getElementById('stamps');
const statusEl = document.getElementById('status');
const characterEl = document.getElementById('character');
const chipsEl = document.getElementById('chips');
const filterEl = document.getElementById('filter');
const clipEl = document.getElementById('clip');
const poseTimeEl = document.getElementById('pose-time');
const sliders = {
  rotation: document.getElementById('rotation'),
  scale: document.getElementById('scale'),
  tilt: document.getElementById('tilt'),
  azimuth: document.getElementById('light-azimuth'),
  elevation: document.getElementById('light-elevation'),
  brightness: document.getElementById('brightness'),
};

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x666666, 1.1);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 30 });
scene.add(hemisphere, sun, sun.target);
const floor = new THREE.Mesh(new THREE.CircleGeometry(STAGE_HALF + 3, 64), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const stars = new THREE.Group();
scene.add(stars);

// 部屋のどこを向いても背景になる、大きな球（内側にグラデーション）
const backdropCanvas = document.createElement('canvas');
backdropCanvas.width = 4;
backdropCanvas.height = 256;
const backdropTexture = new THREE.CanvasTexture(backdropCanvas);
backdropTexture.colorSpace = THREE.SRGBColorSpace;
const backdrop = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), new THREE.MeshBasicMaterial({ map: backdropTexture, side: THREE.BackSide }));
scene.add(backdrop);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 2;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.49;

function resetCamera() {
  // 縦長の画面でも、横に 3 体並べた幅が入る距離から撮る
  const halfWidth = 2.6;
  const distance = Math.max(5.5, halfWidth / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  camera.position.set(0, 1.2 + distance * 0.08, distance);
  controls.target.set(0, 0.85, 0);
  controls.update();
}

let backgroundKey = 'studio';

function applyBackground() {
  const preset = BACKGROUNDS[backgroundKey];
  const ctx = backdropCanvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, backdropCanvas.height);
  gradient.addColorStop(0, cssValue(preset.top));
  gradient.addColorStop(0.55, cssValue(preset.bottom));
  gradient.addColorStop(1, cssValue(preset.bottom));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, backdropCanvas.width, backdropCanvas.height);
  backdropTexture.needsUpdate = true;
  floor.material.color.set(cssValue(preset.floor));
  stars.clear();
  if (preset.stars) {
    const material = new THREE.MeshBasicMaterial({ color: cssValue('--piece-o') });
    for (const [u, v, size] of starPositions(80)) {
      const star = new THREE.Mesh(new THREE.SphereGeometry(0.06 * size, 6, 4), material);
      const theta = u * Math.PI * 2;
      const phi = 0.15 + v * 1.1;
      star.position.setFromSphericalCoords(38, phi, theta);
      stars.add(star);
    }
  }
  renderBackgroundButtons();
}

function applyLight() {
  const { x, y, z } = lightPosition(Number(sliders.azimuth.value), Number(sliders.elevation.value), 12);
  sun.position.set(x, y, z);
  const brightness = Number(sliders.brightness.value) / 100;
  sun.intensity = 2.2 * brightness;
  hemisphere.intensity = 1.1 * brightness;
}

// ---- キャラクター ----

// { label, root（床の上の位置と向き）, holder（傾き・大きさ）, mixer, clips, clipIndex, poseTime }
let characters = [];
let selected = null;
let library = [];

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

async function loadChoice(choice) {
  if (choice === ROBOT) return { object: defaultRobot(), facing: 0, animations: [], label: '仮のロボ' };
  if (choice === CLAY) return { object: clayBall({ segments: [64, 48], roughness: 0.4 }), facing: 0, animations: [], label: '粘土の玉' };
  const record = library.find((r) => r.id === choice);
  const { object, animations } = await loadModel(record, { stlNormals: true });
  const facing = record.facing ?? guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
  return { object, facing, animations, label: displayName(record.name) };
}

// 高さ CHARACTER_HEIGHT・足元が原点・正面が +z にそろえる
function fit(object, facing) {
  const turn = new THREE.Group();
  turn.add(object);
  turn.rotation.y = facing;
  turn.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(turn);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? CHARACTER_HEIGHT / size.y : 1;
  const fitted = new THREE.Group();
  turn.position.set(-center.x, -box.min.y, -center.z);
  fitted.add(turn);
  fitted.scale.setScalar(scale);
  fitted.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    // 写真なので、アニメーションで動いても消えないようにする
    child.frustumCulled = false;
  });
  return fitted;
}

async function addCharacter() {
  if (characters.length >= MAX_CHARACTERS) return setStatus(`キャラクターは ${MAX_CHARACTERS} 体まで並べられる。`);
  setStatus('読み込み中…');
  let loaded;
  try {
    loaded = await loadChoice(characterEl.value);
  } catch (error) {
    console.warn(error);
    return setStatus('キャラクターを読み込めなかった。');
  }
  const holder = fit(loaded.object, loaded.facing);
  const root = new THREE.Group();
  root.add(holder);
  const [x, z] = slotPosition(characters.length);
  root.position.set(x, 0, z);
  scene.add(root);
  const character = {
    label: loaded.label, root, holder, object: loaded.object, clips: loaded.animations, clipIndex: -1, poseTime: 0,
    mixer: loaded.animations.length > 0 ? new THREE.AnimationMixer(loaded.object) : null,
    rotation: 0, scale: 1, tilt: 0, baseScale: holder.scale.x,
  };
  characters.push(character);
  select(character);
  setStatus(`${loaded.label}を並べた。${loaded.animations.length > 0 ? 'アニメーション付きなので、ポーズを選べる。' : ''}`);
}

function removeCharacter(character) {
  scene.remove(character.root);
  character.root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.dispose();
    for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose();
  });
  characters = characters.filter((c) => c !== character);
  select(characters.at(-1) ?? null);
}

function select(character) {
  selected = character;
  renderChips();
  document.getElementById('character-controls').hidden = !character;
  document.getElementById('remove-row').hidden = !character;
  document.getElementById('pose-row').hidden = !character?.mixer;
  if (!character) return;
  sliders.rotation.value = String(Math.round(THREE.MathUtils.radToDeg(character.rotation)));
  sliders.scale.value = String(Math.round(character.scale * 100));
  sliders.tilt.value = String(Math.round(THREE.MathUtils.radToDeg(character.tilt)));
  if (character.mixer) {
    clipEl.replaceChildren(new Option('止まったまま', '-1'), ...character.clips.map((clip, i) => new Option(clip.name || `アニメ ${i + 1}`, String(i))));
    clipEl.value = String(character.clipIndex);
    poseTimeEl.value = String(Math.round(character.poseTime * 1000));
    poseTimeEl.disabled = character.clipIndex < 0;
  }
}

function renderChips() {
  chipsEl.replaceChildren(...characters.map((character, i) => {
    const button = document.createElement('button');
    button.textContent = `${i + 1}. ${character.label}`;
    button.classList.toggle('selected', character === selected);
    button.addEventListener('click', () => select(character));
    return button;
  }));
}

function applyTransform(character) {
  character.root.rotation.y = character.rotation;
  character.root.rotation.z = character.tilt;
  character.holder.scale.setScalar(character.baseScale * character.scale);
}

// ポーズ：選んだアニメーションの、決めた時刻で止める
function applyPose(character) {
  if (!character.mixer) return;
  character.mixer.stopAllAction();
  if (character.clipIndex < 0) {
    character.mixer.setTime(0);
    return;
  }
  const clip = character.clips[character.clipIndex];
  const action = character.mixer.clipAction(clip);
  action.play();
  action.paused = true;
  action.time = character.poseTime * clip.duration;
  character.mixer.update(0);
}

for (const key of ['rotation', 'scale', 'tilt']) {
  sliders[key].addEventListener('input', () => {
    if (!selected) return;
    if (key === 'scale') selected.scale = Number(sliders.scale.value) / 100;
    else selected[key] = THREE.MathUtils.degToRad(Number(sliders[key].value));
    applyTransform(selected);
  });
}
clipEl.addEventListener('change', () => {
  if (!selected) return;
  selected.clipIndex = Number(clipEl.value);
  poseTimeEl.disabled = selected.clipIndex < 0;
  applyPose(selected);
});
poseTimeEl.addEventListener('input', () => {
  if (!selected) return;
  selected.poseTime = Number(poseTimeEl.value) / 1000;
  applyPose(selected);
});
document.getElementById('add').addEventListener('click', addCharacter);
document.getElementById('remove-character').addEventListener('click', () => selected && removeCharacter(selected));

// キャラクターをつかんで床の上で動かす（つかめなければカメラを回す）
const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragging = null;

function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointerRay(event);
  const hits = raycaster.intersectObjects(characters.map((c) => c.root), true);
  if (hits.length === 0) return;
  const character = characters.find((c) => {
    let found = false;
    c.root.traverse((child) => {
      if (child === hits[0].object) found = true;
    });
    return found;
  });
  if (!character) return;
  select(character);
  const point = new THREE.Vector3();
  raycaster.ray.intersectPlane(floorPlane, point);
  dragging = { id: event.pointerId, character, offset: character.root.position.clone().sub(point) };
  // OrbitControls より先に受け取っているので、ここで止めればカメラは回らない
  controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
}, { capture: true });
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!dragging || event.pointerId !== dragging.id) return;
  pointerRay(event);
  const point = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(floorPlane, point)) return;
  const [x, z] = clampToStage([point.x + dragging.offset.x, point.z + dragging.offset.z]);
  dragging.character.root.position.set(x, 0, z);
});
function endDrag(event) {
  if (!dragging || event.pointerId !== dragging.id) return;
  dragging = null;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

// ---- スタンプと文字 ----

let stamps = [];
let selectedStamp = null;

function stampElement(stamp) {
  const el = document.createElement('span');
  el.className = `stamp${stamp.isText ? ' text' : ''}`;
  el.textContent = stamp.text;
  el.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    selectStamp(stamp);
    const rect = stampsEl.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, sx: stamp.x, sy: stamp.y };
    el.setPointerCapture(event.pointerId);
    const move = (e) => {
      stamp.x = clamp01(start.sx + (e.clientX - start.x) / rect.width);
      stamp.y = clamp01(start.sy + (e.clientY - start.y) / rect.height);
      layoutStamp(stamp);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  return el;
}

function layoutStamp(stamp) {
  const { width, height } = stampsEl.getBoundingClientRect();
  const { x, y, size, rotation } = stampPixels(stamp, width, height);
  Object.assign(stamp.el.style, {
    left: `${x}px`,
    top: `${y}px`,
    fontSize: `${size}px`,
    transform: `translate(-50%, -50%) rotate(${rotation}rad)`,
  });
  stamp.el.classList.toggle('selected', stamp === selectedStamp);
}

function addStamp(text, isText = false) {
  if (stamps.length >= MAX_STAMPS) return setStatus(`スタンプと文字は合わせて ${MAX_STAMPS} 個まで。`);
  const stamp = createStamp(text, { x: isText ? 0.5 : 0.3 + Math.random() * 0.4, y: isText ? 0.85 : 0.2 + Math.random() * 0.3, size: isText ? 0.09 : 0.14 });
  stamp.isText = isText;
  stamp.el = stampElement(stamp);
  stampsEl.append(stamp.el);
  stamps.push(stamp);
  selectStamp(stamp);
}

function selectStamp(stamp) {
  selectedStamp = stamp;
  stamps.forEach(layoutStamp);
  document.getElementById('stamp-controls').hidden = !stamp;
}

function updateSelectedStamp(change) {
  if (!selectedStamp) return;
  Object.assign(selectedStamp, change(selectedStamp));
  layoutStamp(selectedStamp);
}

document.getElementById('stamp-buttons').replaceChildren(...STAMPS.map((text) => {
  const button = document.createElement('button');
  button.textContent = text;
  button.addEventListener('click', () => addStamp(text));
  return button;
}));
document.getElementById('add-text').addEventListener('click', () => {
  const text = document.getElementById('text').value.trim();
  if (!text) return setStatus('入れる文字を書いてね。');
  addStamp(text, true);
});
document.getElementById('stamp-bigger').addEventListener('click', () => updateSelectedStamp((s) => resizeStamp(s, 1.2)));
document.getElementById('stamp-smaller').addEventListener('click', () => updateSelectedStamp((s) => resizeStamp(s, 1 / 1.2)));
document.getElementById('stamp-rotate').addEventListener('click', () => updateSelectedStamp((s) => ({ rotation: s.rotation + Math.PI / 12 })));
document.getElementById('stamp-remove').addEventListener('click', () => {
  if (!selectedStamp) return;
  selectedStamp.el.remove();
  stamps = stamps.filter((s) => s !== selectedStamp);
  selectStamp(null);
});
// 何もない所をさわったら、スタンプの選択をやめる
viewerEl.addEventListener('pointerdown', () => selectedStamp && selectStamp(null));

// ---- 撮影 ----

let photoBlob = null;
let photoUrl = null;

async function shoot() {
  selectStamp(null);
  const flash = document.getElementById('flash');
  flash.classList.add('on');
  requestAnimationFrame(() => flash.classList.remove('on'));
  renderer.render(scene, camera);
  const width = renderer.domElement.width;
  const height = renderer.domElement.height;
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const ctx = layer.getContext('2d');
  ctx.drawImage(renderer.domElement, 0, 0);
  for (const stamp of stamps) {
    const { x, y, size, rotation } = stampPixels(stamp, width, height);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (stamp.isText) {
      ctx.lineWidth = size * 0.12;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = cssValue('--text');
      ctx.strokeText(stamp.text, 0, 0);
      ctx.fillStyle = cssValue('--surface');
    }
    ctx.fillText(stamp.text, 0, 0);
    ctx.restore();
  }
  // フィルターは最後に全体へかける（画面の見た目と同じ）
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d');
  outCtx.filter = FILTERS[filterEl.value].css;
  outCtx.drawImage(layer, 0, 0);
  photoBlob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(photoBlob);
  document.getElementById('photo').src = photoUrl;
  document.getElementById('result').hidden = false;
  document.getElementById('share').hidden = !canShare();
  setStatus('撮れた！「保存する」で画像をダウンロードできる。');
}

function photoFile() {
  return new File([photoBlob], photoFileName(), { type: 'image/png' });
}

function canShare() {
  try {
    return Boolean(photoBlob && navigator.canShare?.({ files: [photoFile()] }));
  } catch {
    return false;
  }
}

document.getElementById('shoot').addEventListener('click', shoot);
document.getElementById('save').addEventListener('click', () => {
  if (!photoBlob) return;
  const link = document.createElement('a');
  link.href = photoUrl;
  link.download = photoFileName();
  link.click();
});
document.getElementById('share').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [photoFile()] });
  } catch (error) {
    if (error?.name !== 'AbortError') setStatus('共有できなかった。「保存する」を使ってね。');
  }
});
document.getElementById('reset-camera').addEventListener('click', resetCamera);

// ---- 背景・光・フィルターの操作 ----

function renderBackgroundButtons() {
  document.getElementById('backgrounds').replaceChildren(...Object.entries(BACKGROUNDS).map(([key, preset]) => {
    const button = document.createElement('button');
    button.textContent = preset.label;
    button.classList.toggle('selected', key === backgroundKey);
    button.addEventListener('click', () => {
      backgroundKey = key;
      applyBackground();
    });
    return button;
  }));
}

filterEl.replaceChildren(...Object.entries(FILTERS).map(([key, f]) => new Option(f.label, key)));
filterEl.addEventListener('change', () => {
  // 見た目にも同じフィルターをかける（スタンプにもかかる）
  viewerEl.style.filter = FILTERS[filterEl.value].css === 'none' ? '' : FILTERS[filterEl.value].css;
});
for (const key of ['azimuth', 'elevation', 'brightness']) sliders[key].addEventListener('input', applyLight);

// ---- 始める ----

async function loadLibrary() {
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
  characterEl.replaceChildren(
    ...library.map((r) => new Option(displayName(r.name), r.id)),
    new Option('仮のロボ', ROBOT),
    new Option('粘土の玉', CLAY),
  );
  characterEl.value = library.some((r) => r.id === currentId) ? currentId : (library[0]?.id ?? ROBOT);
  await addCharacter();
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  stamps.forEach(layoutStamp);
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyBackground);
resize();
resetCamera();
applyBackground();
applyLight();
loadLibrary();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

