import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer/meshopt_simplifier.js';
import {
  TEXTURE_SIZES, compactIndices, detectFormat, fitDistance, formatBytes, formatCount, normalizeVectors, outputName, percentOf,
  ratioFromSlider, remapAttribute, sliderFromRatio, targetIndexCount, textureSizeLabel,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { parseModel } from '../shared/models.js';

// 減らすときに許す形のずれ（モデルの大きさに対する割合）。大きめにして、指定した割合まで確実に減らす
const TARGET_ERROR = 1;
const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const labelEl = document.getElementById('view-label');
const fileEl = document.getElementById('file');
const ratioEl = document.getElementById('ratio');
const textureSizeEl = document.getElementById('texture-size');
const wireframeEl = document.getElementById('wireframe');
const simplifyEl = document.getElementById('simplify');
const exportEl = document.getElementById('export');
const viewButtons = [...document.querySelectorAll('[data-view]')];
const cells = Object.fromEntries(
  ['triangles', 'vertices', 'textures', 'file'].flatMap((key) => [
    [`before-${key}`, document.getElementById(`before-${key}`)],
    [`after-${key}`, document.getElementById(`after-${key}`)],
  ]),
);

function setStatus(text) {
  statusEl.textContent = text;
}

// 重い処理の前に、メッセージを画面に出す時間を作る
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// ---- 3D 表示 ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
scene.add(hemisphere, sun);
let grid = null;

// original / lite は { object, name, bytes, stats }
let original = null;
let lite = null;
let shown = null;

function applyTheme() {
  scene.background = new THREE.Color(cssValue('--surface'));
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(1, 10, cssValue('--muted'), cssValue('--border'));
  scene.add(grid);
  if (original) fitView(original.object);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// モデル全体が見える位置にカメラを置き、床のグリッドをモデルの足元に合わせる
function fitView(object) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const distance = fitDistance(radius, camera.fov, camera.aspect);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.6, 1.4).normalize().multiplyScalar(distance));
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  sun.position.copy(center).add(new THREE.Vector3(2, 4, 3).multiplyScalar(radius));
  grid.scale.setScalar(radius * 4);
  grid.position.set(center.x, box.min.y, center.z);
}

function eachMaterial(object, callback) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) callback(material);
  });
}

function applyWireframe() {
  for (const model of [original, lite]) {
    if (model) eachMaterial(model.object, (material) => { material.wireframe = wireframeEl.checked; });
  }
}

function show(which) {
  const model = which === 'lite' ? lite : original;
  if (!model) return;
  for (const m of [original, lite]) if (m) scene.remove(m.object);
  scene.add(model.object);
  shown = which;
  labelEl.textContent = `${which === 'lite' ? '軽量化後' : '元'}：${formatCount(model.stats.triangles)} ポリゴン`;
  for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === which));
}

// ---- 統計 ----

function textureImages(object) {
  const images = new Set();
  eachMaterial(object, (material) => {
    for (const key of TEXTURE_KEYS) if (material[key]?.image) images.add(material[key].image);
  });
  return [...images];
}

function measure(object) {
  let triangles = 0;
  let vertices = 0;
  object.traverse((child) => {
    if (!child.isMesh) return;
    const { index, attributes } = child.geometry;
    vertices += attributes.position.count;
    triangles += (index ? index.count : attributes.position.count) / 3;
  });
  const images = textureImages(object);
  const largest = Math.max(0, ...images.map((image) => Math.max(image.width ?? 0, image.height ?? 0)));
  return { triangles: Math.round(triangles), vertices, textures: images.length, largest };
}

function describeTextures({ textures, largest }, limit = Infinity) {
  if (textures === 0) return 'なし';
  return `${textures} 枚（最大 ${Math.min(largest, limit)} px）`;
}

function renderStats() {
  const textureLimit = Number(textureSizeEl.value);
  if (original) {
    cells['before-triangles'].textContent = formatCount(original.stats.triangles);
    cells['before-vertices'].textContent = formatCount(original.stats.vertices);
    cells['before-textures'].textContent = describeTextures(original.stats);
    cells['before-file'].textContent = original.bytes === null ? '-' : formatBytes(original.bytes);
  }
  if (lite) {
    const { triangles, vertices } = lite.stats;
    cells['after-triangles'].textContent = `${formatCount(triangles)}（${percentOf(triangles, original.stats.triangles)}）`;
    cells['after-vertices'].textContent = `${formatCount(vertices)}（${percentOf(vertices, original.stats.vertices)}）`;
    cells['after-textures'].textContent = describeTextures(lite.stats, textureLimit);
    cells['after-file'].textContent = lite.bytes === null
      ? '書き出すと表示'
      : `${formatBytes(lite.bytes)}${original.bytes ? `（${percentOf(lite.bytes, original.bytes)}）` : ''}`;
  } else {
    for (const key of ['triangles', 'vertices', 'textures', 'file']) cells[`after-${key}`].textContent = '-';
  }
}

function updateRatioLabel() {
  const ratio = ratioFromSlider(Number(ratioEl.value));
  const percent = ratio < 0.1 ? (ratio * 100).toFixed(1) : Math.round(ratio * 100);
  const estimate = original ? `（約 ${formatCount(Math.round(original.stats.triangles * ratio))} ポリゴン）` : '';
  document.getElementById('ratio-value').textContent = `${percent}%${estimate}`;
}

// ---- 読み込み ----

function setOriginal(object, name, bytes) {
  for (const m of [original, lite]) if (m) scene.remove(m.object);
  original = { object, name, bytes, stats: measure(object) };
  lite = null;
  exportEl.disabled = true;
  viewButtons.find((b) => b.dataset.view === 'lite').disabled = true;
  applyWireframe();
  show('original');
  fitView(object);
  updateRatioLabel();
  renderStats();
}

async function openFile(file) {
  const format = detectFormat(file.name);
  if (!format) {
    setStatus(`「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`);
    return;
  }
  setStatus(`「${file.name}」を読み込み中…`);
  await nextFrame();
  try {
    setOriginal(await parseModel({ format, data: await file.arrayBuffer() }), file.name, file.size);
    setStatus(`「${file.name}」を読み込みました。割合を決めて「軽量化する」を押してね。`);
  } catch (error) {
    console.warn(error);
    const hint = format === 'gltf' ? '（.gltf は別ファイルの .bin や画像を読み込めないので、.glb がおすすめ）' : '';
    setStatus(`「${file.name}」を読み込めませんでした。${hint}`);
  }
}

// 試せるように、最初は細かいねじれた輪を表示しておく
function loadSample() {
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.3, 600, 64),
    new THREE.MeshStandardMaterial({ color: cssValue('--piece-o'), roughness: 0.4 }),
  );
  const group = new THREE.Group();
  group.add(mesh);
  setOriginal(group, 'sample-knot', null);
}

// ---- 軽量化 ----

// どんな形式の頂点データ（量子化・インターリーブなど）でも、ふつうの小数の配列に読み出す
function readAttribute(attribute) {
  const { count, itemSize } = attribute;
  const result = new Float32Array(count * itemSize);
  const getters = ['getX', 'getY', 'getZ', 'getW'];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < itemSize; k++) result[i * itemSize + k] = attribute[getters[k]](i);
  }
  return result;
}

// 1 つのメッシュの形を減らした、新しい形を返す
function simplifyGeometry(source, ratio) {
  let geometry = source;
  let recomputeNormals = false;
  if (!geometry.index) {
    // 三角形ごとに頂点がばらばらの形（STL など）は、同じ位置の頂点をまとめないと減らせない。
    // 面ごとの法線が付いていると頂点がまとまらないので、法線は外してから作り直す
    geometry = geometry.clone();
    if (geometry.attributes.normal) {
      geometry.deleteAttribute('normal');
      recomputeNormals = true;
    }
    geometry = mergeVertices(geometry);
  }
  const positions = readAttribute(geometry.attributes.position);
  const indices = Uint32Array.from(geometry.index.array);
  // 複数の素材を持つ形は、素材の区切り（group）ごとに減らす
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: indices.length, materialIndex: 0 }];
  const kept = [];
  const newGroups = [];
  let offset = 0;
  for (const group of groups) {
    const part = indices.subarray(group.start, group.start + group.count);
    const [result] = MeshoptSimplifier.simplify(part, positions, 3, targetIndexCount(part.length, ratio), TARGET_ERROR);
    kept.push(result);
    newGroups.push({ start: offset, count: result.length, materialIndex: group.materialIndex });
    offset += result.length;
  }
  const merged = new Uint32Array(offset);
  kept.reduce((at, part) => {
    merged.set(part, at);
    return at + part.length;
  }, 0);

  const compact = compactIndices(merged, geometry.attributes.position.count);
  const result = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const values = remapAttribute(readAttribute(attribute), attribute.itemSize, compact.remap, compact.vertexCount);
    // 圧縮されていた法線は、小数に戻すと長さがわずかに 1 からずれるので、長さ 1 にそろえ直す
    if (name === 'normal') normalizeVectors(values, attribute.itemSize);
    result.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  const IndexArray = compact.vertexCount <= 65535 ? Uint16Array : Uint32Array;
  result.setIndex(new THREE.BufferAttribute(IndexArray.from(compact.indices), 1));
  if (geometry.groups.length > 0) for (const g of newGroups) result.addGroup(g.start, g.count, g.materialIndex);
  if (recomputeNormals) result.computeVertexNormals();
  return result;
}

async function simplifyModel() {
  if (!original) return;
  const ratio = ratioFromSlider(Number(ratioEl.value));
  simplifyEl.disabled = true;
  setStatus('軽量化中…（細かいモデルは数秒かかります）');
  await nextFrame();
  try {
    await MeshoptSimplifier.ready;
    // 形（geometry）だけを作り直し、素材やテクスチャは元のものをそのまま使う
    const object = original.object.clone(true);
    let skipped = 0;
    object.traverse((child) => {
      if (!child.isMesh) return;
      // 骨やモーフで動くモデルは、頂点を減らすと動きが壊れるのでそのままにする
      if (child.isSkinnedMesh || Object.keys(child.geometry.morphAttributes).length > 0) {
        skipped++;
        return;
      }
      child.geometry = simplifyGeometry(child.geometry, ratio);
    });
    if (lite) scene.remove(lite.object);
    lite = { object, name: original.name, bytes: null, stats: measure(object) };
    applyWireframe();
    show('lite');
    viewButtons.find((b) => b.dataset.view === 'lite').disabled = false;
    exportEl.disabled = false;
    renderStats();
    const note = skipped > 0 ? `（骨やモーフで動く部分 ${skipped} 個はそのままにしました）` : '';
    setStatus(`${formatCount(original.stats.triangles)} → ${formatCount(lite.stats.triangles)} ポリゴンに減らしました。${note}「元」と見比べてみてね。`);
  } catch (error) {
    console.warn(error);
    setStatus('軽量化できませんでした。');
  } finally {
    simplifyEl.disabled = false;
  }
}

async function exportModel() {
  if (!lite) return;
  exportEl.disabled = true;
  setStatus('書き出し中…');
  await nextFrame();
  // 見比べ用のワイヤーフレーム表示は書き出さない
  const wireframe = wireframeEl.checked;
  wireframeEl.checked = false;
  applyWireframe();
  try {
    const data = await new GLTFExporter().parseAsync(lite.object, {
      binary: true,
      maxTextureSize: Number(textureSizeEl.value),
    });
    const blob = new Blob([data], { type: 'model/gltf-binary' });
    lite.bytes = blob.size;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = outputName(lite.name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    renderStats();
    setStatus(`${link.download}（${formatBytes(blob.size)}）を書き出しました。`);
  } catch (error) {
    console.warn(error);
    setStatus('書き出せませんでした。');
  } finally {
    wireframeEl.checked = wireframe;
    applyWireframe();
    exportEl.disabled = false;
  }
}

// ---- 入力 ----

for (const size of TEXTURE_SIZES) {
  const option = document.createElement('option');
  option.value = String(size);
  option.textContent = textureSizeLabel(size);
  textureSizeEl.append(option);
}
textureSizeEl.value = '2048';

fileEl.addEventListener('change', () => {
  const [file] = fileEl.files;
  if (file) openFile(file);
  fileEl.value = '';
});
viewerEl.addEventListener('dragover', (event) => event.preventDefault());
viewerEl.addEventListener('drop', (event) => {
  event.preventDefault();
  const [file] = event.dataTransfer.files;
  if (file) openFile(file);
});
ratioEl.addEventListener('input', updateRatioLabel);
document.getElementById('presets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-ratio]');
  if (!button) return;
  ratioEl.value = String(sliderFromRatio(Number(button.dataset.ratio)));
  updateRatioLabel();
});
textureSizeEl.addEventListener('change', renderStats);
wireframeEl.addEventListener('change', applyWireframe);
simplifyEl.addEventListener('click', simplifyModel);
exportEl.addEventListener('click', exportModel);
for (const button of viewButtons) button.addEventListener('click', () => show(button.dataset.view));

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

resize();
applyTheme();
loadSample();
setStatus('サンプルを表示しています。自分のモデルを読み込むか、このまま「軽量化する」を試してね。');
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
