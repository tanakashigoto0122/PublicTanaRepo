import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  MAX_CHARACTERS, backupFileName, characterFileName, characterSummary, detectFormat, displayName, guessFacing, packBackup, turnFacing, unpackBackup,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { parseModel } from '../shared/models.js';
import {
  keepStorage, listCharacters, readCharacter, removeCharacter, saveCharacter, writeCharacter,
} from '../shared/storage.js';

const MODEL_HEIGHT = 2;
const THUMB_SIZE = 192;

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const nameEl = document.getElementById('name');
const previewNameEl = document.getElementById('preview-name');
const previewInUseEl = document.getElementById('preview-in-use');
const actionButtons = ['use', 'turn', 'download', 'remove', 'rename'].map((id) => document.getElementById(id));

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 2;
controls.maxDistance = 12;

function addLights(target) {
  target.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 5, 4);
  target.add(sun);
}
addLights(scene);

// 床と、正面（+z、手前）を指す矢印
const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 48), new THREE.MeshStandardMaterial({ roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const arrowMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6 });
const arrow = new THREE.Group();
const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.5), arrowMaterial);
shaft.position.z = 1.15;
const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 3), arrowMaterial);
head.rotation.x = Math.PI / 2;
head.position.z = 1.5;
arrow.add(shaft, head);
arrow.position.y = 0.01;
scene.add(arrow);

const holder = new THREE.Group();
scene.add(holder);

function resetCamera() {
  // 正面（手前）から少し見下ろす
  camera.position.set(0.9, 1.9, 5.2);
  controls.target.set(0, MODEL_HEIGHT / 2, 0);
  controls.update();
}

// 高さ MODEL_HEIGHT にそろえ、足元の中心を原点に置いて、向き facing を付ける
function fitModel(object, facing) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = MODEL_HEIGHT / Math.max(size.y, size.x * 0.6, size.z * 0.6, 1e-6);
  object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z)).multiplyScalar(scale);
  object.scale.multiplyScalar(scale);
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.rotation.y = facing;
  return wrapper;
}

// 小さな絵（一覧のカード用）は別の小さなレンダラーで描く
const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
const thumbScene = new THREE.Scene();
addLights(thumbScene);
const thumbCamera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
thumbCamera.position.set(1.8, 2.3, 6.4);
thumbCamera.lookAt(0, MODEL_HEIGHT / 2, 0);

function thumbnail(object, facing) {
  const fitted = fitModel(object.clone(), facing);
  thumbScene.add(fitted);
  thumbRenderer.render(thumbScene, thumbCamera);
  const url = thumbRenderer.domElement.toDataURL('image/png');
  thumbScene.remove(fitted);
  return url;
}

function resize() {
  const { clientWidth: w, clientHeight: h } = viewerEl;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  floor.material.color.set(cssValue('--bg'));
  arrowMaterial.color.set(cssValue('--accent'));
}

// ---- キャラクターの一覧 ----

// { record, object（読み込んだ形。まだなら null）, card }
let entries = [];
let selected = null;
let currentId = null;

async function objectOf(entry) {
  entry.object ??= await parseModel(entry.record, { stlNormals: true });
  return entry.object;
}

function updateCard(entry) {
  const { record, card } = entry;
  card.querySelector('.name').textContent = displayName(record.name);
  card.querySelector('.meta').textContent = characterSummary(record);
  card.querySelector('.badge').textContent = record.id === currentId ? '使用中' : '';
  card.classList.toggle('selected', entry === selected);
  card.setAttribute('aria-pressed', String(entry === selected));
}

async function updateThumbnail(entry) {
  try {
    entry.card.querySelector('img').src = thumbnail(await objectOf(entry), entry.record.facing ?? 0);
  } catch (error) {
    console.warn(error);
    entry.card.querySelector('.meta').textContent = '読み込めません';
  }
}

function makeCard(entry) {
  const card = document.createElement('button');
  card.className = 'card';
  const img = document.createElement('img');
  img.alt = '';
  img.width = THUMB_SIZE;
  img.height = THUMB_SIZE;
  const name = document.createElement('span');
  name.className = 'name';
  const meta = document.createElement('span');
  meta.className = 'meta';
  const badge = document.createElement('span');
  badge.className = 'badge';
  card.append(img, name, meta, badge);
  card.addEventListener('click', () => select(entry));
  entry.card = card;
  return card;
}

function renderList() {
  listEl.replaceChildren(...entries.map((entry) => entry.card ?? makeCard(entry)));
  entries.forEach(updateCard);
  emptyEl.hidden = entries.length > 0;
  countEl.textContent = entries.length > 0 ? `（${entries.length}）` : '';
}

function updateSelection() {
  entries.forEach(updateCard);
  const record = selected?.record;
  previewNameEl.textContent = record ? displayName(record.name) : 'キャラクターなし';
  previewInUseEl.hidden = !record || record.id !== currentId;
  nameEl.value = record ? displayName(record.name) : '';
  for (const button of actionButtons) button.disabled = !record;
  nameEl.disabled = !record;
}

let showToken = 0;
async function showPreview() {
  const token = ++showToken;
  holder.clear();
  if (!selected) return;
  try {
    const object = await objectOf(selected);
    if (token !== showToken) return;
    holder.add(fitModel(object.clone(), selected.record.facing ?? 0));
  } catch (error) {
    console.warn(error);
    if (token === showToken) setStatus(`「${selected.record.name}」を読み込めませんでした。`);
  }
}

function select(entry) {
  selected = entry;
  updateSelection();
  showPreview();
}

function disposeObject(object) {
  object?.traverse((child) => {
    if (child.isMesh) child.geometry.dispose();
  });
}

function storageFailed(error) {
  console.warn(error);
  setStatus('このブラウザには保存できませんでした。');
}

async function load() {
  try {
    let current = await readCharacter();
    // 一覧ができる前に保存したキャラクターは、ここで一覧に入れる
    if (current && !current.id) {
      await writeCharacter(current);
      current = await readCharacter();
    }
    currentId = current?.id ?? null;
    entries = (await listCharacters()).map((record) => ({ record, object: null, card: null }));
  } catch (error) {
    storageFailed(error);
    entries = [];
  }
  renderList();
  select(entries.find((entry) => entry.record.id === currentId) ?? entries[0] ?? null);
  setStatus(entries.length > 0 ? `${entries.length} 体のキャラクターがいます。` : '');
  // 絵は 1 体ずつ作る（大きなモデルで固まらないように）
  for (const entry of entries) await updateThumbnail(entry);
}

// ---- 操作 ----

document.getElementById('file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const format = detectFormat(file.name);
  if (!format) return setStatus(`「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`);
  if (entries.length >= MAX_CHARACTERS) return setStatus(`キャラクターは ${MAX_CHARACTERS} 体までです。いくつか消してから追加してね。`);
  setStatus(`「${file.name}」を読み込み中…`);
  const record = { name: file.name, format, data: await file.arrayBuffer() };
  const entry = { record, object: null, card: null };
  try {
    const object = await objectOf(entry);
    record.facing = guessFacing(new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray());
  } catch (error) {
    console.warn(error);
    return setStatus(`「${file.name}」を読み込めませんでした。`);
  }
  try {
    // 追加したキャラクターをそのまま使う
    await writeCharacter(record);
    currentId = record.id;
  } catch (error) {
    return storageFailed(error);
  }
  entries.push(entry);
  renderList();
  select(entry);
  await updateThumbnail(entry);
  setStatus(`「${displayName(file.name)}」を追加して、使うキャラクターにしました。正面が手前を向いていなければ「向きを回す」で合わせてね。`);
});

document.getElementById('use').addEventListener('click', async () => {
  if (!selected) return;
  try {
    await writeCharacter(selected.record);
  } catch (error) {
    return storageFailed(error);
  }
  currentId = selected.record.id;
  updateSelection();
  setStatus(`「${displayName(selected.record.name)}」を使います。ほかのゲームでもこのキャラクターになります。`);
});

document.getElementById('turn').addEventListener('click', async () => {
  if (!selected) return;
  const entry = selected;
  entry.record.facing = turnFacing(entry.record.facing ?? 0);
  holder.children[0]?.rotation.set(0, entry.record.facing, 0);
  try {
    await saveCharacter(entry.record);
  } catch (error) {
    return storageFailed(error);
  }
  await updateThumbnail(entry);
  setStatus('向きを 90 度回しました。');
});

document.getElementById('rename').addEventListener('click', async () => {
  if (!selected) return;
  const record = selected.record;
  const name = characterFileName(nameEl.value, record.format);
  if (name === record.name) return;
  const before = record.name;
  record.name = name;
  try {
    await saveCharacter(record);
  } catch (error) {
    record.name = before;
    return storageFailed(error);
  }
  updateSelection();
  setStatus(`名前を「${displayName(name)}」にしました。`);
});
nameEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('rename').click();
});

function downloadFile(data, name) {
  const url = URL.createObjectURL(new Blob([data]));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('download').addEventListener('click', () => {
  if (selected) downloadFile(selected.record.data, selected.record.name);
});

document.getElementById('remove').addEventListener('click', async () => {
  if (!selected) return;
  const entry = selected;
  const label = displayName(entry.record.name);
  if (!window.confirm(`「${label}」を消しますか？（元に戻せません）`)) return;
  try {
    await removeCharacter(entry.record.id);
  } catch (error) {
    return storageFailed(error);
  }
  if (entry.record.id === currentId) currentId = null;
  const index = entries.indexOf(entry);
  entries.splice(index, 1);
  disposeObject(entry.object);
  renderList();
  select(entries[Math.min(index, entries.length - 1)] ?? null);
  setStatus(`「${label}」を消しました。`);
});

document.getElementById('unset').addEventListener('click', async () => {
  try {
    await writeCharacter(null);
  } catch (error) {
    return storageFailed(error);
  }
  currentId = null;
  updateSelection();
  setStatus('キャラクターを外しました。ゲームでは仮のロボや粘土の玉になります。');
});

// ---- バックアップ ----

document.getElementById('backup').addEventListener('click', () => {
  if (entries.length === 0) return setStatus('バックアップするキャラクターがまだありません。');
  downloadFile(packBackup(entries.map((entry) => entry.record), currentId), backupFileName());
  setStatus(`${entries.length} 体をバックアップしました。ファイルは端末の「ダウンロード」などに保存されます。`);
});

document.getElementById('restore').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const backup = unpackBackup(await file.arrayBuffer());
  if (!backup) return setStatus(`「${file.name}」はキャラクターのバックアップではないようです。`);
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  try {
    for (const record of backup.records) {
      const existing = entries.find((entry) => entry.record.id === record.id);
      if (!existing && entries.length >= MAX_CHARACTERS) {
        skipped++;
        continue;
      }
      await saveCharacter(record);
      if (existing) {
        disposeObject(existing.object);
        Object.assign(existing, { record, object: null });
        replaced++;
      } else {
        entries.push({ record, object: null, card: null });
        added++;
      }
    }
    // 使っているキャラクターがなければ、バックアップしたときのものを使う
    const backupCurrent = entries.find((entry) => entry.record.id === backup.current);
    if (!currentId && backupCurrent) {
      await writeCharacter(backupCurrent.record);
      currentId = backupCurrent.record.id;
    }
  } catch (error) {
    storageFailed(error);
  }
  entries.sort((a, b) => (a.record.addedAt ?? 0) - (b.record.addedAt ?? 0));
  renderList();
  select(entries.find((entry) => entry.record.id === selected?.record.id) ?? entries[0] ?? null);
  const parts = [`${added} 体を追加`, replaced > 0 ? `${replaced} 体を上書き` : '', skipped > 0 ? `${skipped} 体は ${MAX_CHARACTERS} 体を超えるので入れませんでした` : ''];
  setStatus(`バックアップから戻しました（${parts.filter(Boolean).join('、')}）。`);
  // 新しく入ったものと上書きしたものの絵を作り直す
  for (const entry of entries) {
    if (entry.object === null) await updateThumbnail(entry);
  }
});

async function showPersistence() {
  const el = document.getElementById('persist');
  if (!navigator.storage?.persisted) return;
  const kept = (await navigator.storage.persisted()) || (entries.length > 0 && await keepStorage());
  el.textContent = kept
    ? 'このブラウザは、ここの保存を勝手に消さないようにしています。'
    : 'このブラウザは、容量が足りないときなどに保存を消すことがあります。バックアップしておくと安心。';
}

// ---- 描画 ----

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
resize();
resetCamera();
updateSelection();
requestAnimationFrame(animate);
load().then(showPersistence);
