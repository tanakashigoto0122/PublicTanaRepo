import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import {
  detectFormat, fitDistance, formatBytes, formatCount, formatDimensions, lightPosition,
} from './logic.js';

const viewerEl = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const fileEl = document.getElementById('file');
const sampleEl = document.getElementById('sample');
const inputs = {
  azimuth: document.getElementById('azimuth'),
  elevation: document.getElementById('elevation'),
  intensity: document.getElementById('intensity'),
  gloss: document.getElementById('gloss'),
  color: document.getElementById('color'),
  autoRotate: document.getElementById('auto-rotate'),
  wireframe: document.getElementById('wireframe'),
  grid: document.getElementById('grid'),
};
const stats = {
  name: document.getElementById('stat-name'),
  vertices: document.getElementById('stat-vertices'),
  triangles: document.getElementById('stat-triangles'),
  size: document.getElementById('stat-size'),
  file: document.getElementById('stat-file'),
  animations: document.getElementById('stat-animations'),
};

// 色は style.css の CSS 変数から読む（ダークモードの切り替えにも追従する）
function cssColor(name) {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}

// preserveDrawingBuffer は「画像を保存」で描画結果を読み出すために必要
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
scene.add(hemisphere, sun, sun.target);

let grid = null;
let model = null;
let mixer = null;
// 形式に色や質感の情報がないモデル（OBJ / STL / サンプル）は、色とツヤを画面から変えられる
let usesCustomMaterial = false;
let modelRadius = 1;
const timer = new THREE.Timer();

function applyTheme() {
  scene.background = cssColor('--surface');
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(1, 10, cssColor('--muted'), cssColor('--border'));
  grid.visible = inputs.grid.checked;
  scene.add(grid);
  fitGrid();
}

function fitGrid() {
  if (!grid) return;
  grid.scale.setScalar(modelRadius * 4);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewerEl;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function updateLight() {
  const p = lightPosition(Number(inputs.azimuth.value), Number(inputs.elevation.value), modelRadius * 4);
  sun.position.set(p.x, p.y, p.z);
  sun.intensity = (Number(inputs.intensity.value) / 100) * 2;
  hemisphere.intensity = sun.intensity * 0.5;
}

function eachMaterial(callback) {
  model?.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach(callback);
  });
}

function updateMaterials() {
  const gloss = Number(inputs.gloss.value) / 100;
  eachMaterial((material) => {
    material.wireframe = inputs.wireframe.checked;
    if (usesCustomMaterial) {
      material.color.set(inputs.color.value);
      material.roughness = 1 - gloss * 0.9;
      material.metalness = gloss * 0.3;
    }
  });
}

function newMaterial() {
  return new THREE.MeshStandardMaterial({ color: inputs.color.value, side: THREE.DoubleSide });
}

// モデルの底を床に付け、中心を原点に合わせてから、全体が見えるようにカメラを置く
function frameModel() {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  const size = box.getSize(new THREE.Vector3());
  modelRadius = Math.max(size.length() / 2, 0.001);
  resetView();
  fitGrid();
  updateLight();
  return size;
}

function resetView() {
  const height = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y;
  const target = new THREE.Vector3(0, height / 2, 0);
  const distance = fitDistance(modelRadius, camera.fov, camera.aspect);
  const direction = new THREE.Vector3(1, 0.6, 1.4).normalize();
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.update();
}

function disposeModel() {
  if (!model) return;
  scene.remove(model);
  model.traverse((child) => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material?.dispose());
  });
  model = null;
  mixer = null;
}

function showModel(object, { name, bytes = null, custom, animations = [] }) {
  disposeModel();
  model = object;
  usesCustomMaterial = custom;
  scene.add(model);
  updateMaterials();
  const size = frameModel();

  if (animations.length > 0) {
    mixer = new THREE.AnimationMixer(model);
    animations.forEach((clip) => mixer.clipAction(clip).play());
  }

  let vertices = 0;
  let triangles = 0;
  model.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    const count = geometry.attributes.position.count;
    vertices += count;
    triangles += (geometry.index ? geometry.index.count : count) / 3;
  });
  stats.name.textContent = name;
  stats.vertices.textContent = formatCount(vertices);
  stats.triangles.textContent = formatCount(Math.round(triangles));
  stats.size.textContent = formatDimensions(size);
  stats.file.textContent = bytes === null ? '-' : formatBytes(bytes);
  stats.animations.textContent = animations.length > 0 ? `${animations.length} 個（再生中）` : 'なし';
}

function makeSample(kind) {
  const group = new THREE.Group();
  const add = (geometry, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, newMaterial());
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  if (kind === 'knot') {
    add(new THREE.TorusKnotGeometry(1, 0.32, 200, 32), 0, 0, 0);
  } else if (kind === 'shapes') {
    add(new THREE.BoxGeometry(1, 1, 1), -1.4, 0.5, 0);
    add(new THREE.SphereGeometry(0.6, 48, 32), 0, 0.6, 0);
    add(new THREE.ConeGeometry(0.55, 1.2, 48), 1.4, 0.6, 0);
    add(new THREE.TorusGeometry(0.45, 0.18, 24, 64), 0, 0.45, 1.4).rotation.x = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.4, 0.4, 1, 48), 0, 0.5, -1.4);
  } else {
    for (let i = 0; i < 8; i++) {
      const block = add(new THREE.BoxGeometry(1.6 - i * 0.12, 0.4, 0.5), 0, 0.2 + i * 0.42, 0);
      block.rotation.y = i * 0.35;
    }
  }
  return group;
}

const SAMPLE_NAMES = { knot: 'ねじれた輪', shapes: 'いろいろな形', tower: '積み木の塔' };

function showSample(kind) {
  showModel(makeSample(kind), { name: `サンプル: ${SAMPLE_NAMES[kind]}`, custom: true });
  statusEl.textContent = '';
}

async function parseFile(file, format) {
  const buffer = await file.arrayBuffer();
  if (format === 'glb' || format === 'gltf') {
    const data = format === 'gltf' ? new TextDecoder().decode(buffer) : buffer;
    // gltfpack などで meshopt 圧縮した .glb も開けるようにする
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '');
    return { object: gltf.scene, custom: false, animations: gltf.animations };
  }
  if (format === 'obj') {
    const object = new OBJLoader().parse(new TextDecoder().decode(buffer));
    object.traverse((child) => {
      if (child.isMesh) child.material = newMaterial();
    });
    return { object, custom: true };
  }
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  // STL は Z 軸が上のことが多いので、Y 軸が上になるように起こす
  const mesh = new THREE.Mesh(geometry, newMaterial());
  mesh.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(mesh);
  return { object: group, custom: true };
}

async function openFile(file) {
  const format = detectFormat(file.name);
  if (!format) {
    statusEl.textContent = `「${file.name}」は開けない形式です。.glb / .gltf / .obj / .stl に対応しています。`;
    return;
  }
  statusEl.textContent = `「${file.name}」を読み込み中…`;
  try {
    const { object, custom, animations } = await parseFile(file, format);
    showModel(object, { name: file.name, bytes: file.size, custom, animations });
    sampleEl.value = '';
    statusEl.textContent = '';
  } catch (error) {
    console.warn(error);
    const hint = format === 'gltf' ? '（.gltf は別ファイルの .bin や画像を読み込めないので、.glb がおすすめ）' : '';
    statusEl.textContent = `「${file.name}」を読み込めませんでした。${hint}`;
  }
}

function saveScreenshot() {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'model.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
}

function animate(time) {
  timer.update(time);
  mixer?.update(timer.getDelta());
  controls.update();
  renderer.render(scene, camera);
}

fileEl.addEventListener('change', () => {
  const [file] = fileEl.files;
  if (file) openFile(file);
  fileEl.value = '';
});
sampleEl.addEventListener('change', () => {
  if (sampleEl.value) showSample(sampleEl.value);
});
document.getElementById('reset').addEventListener('click', () => model && resetView());
document.getElementById('screenshot').addEventListener('click', saveScreenshot);

for (const name of ['azimuth', 'elevation', 'intensity']) inputs[name].addEventListener('input', updateLight);
for (const name of ['gloss', 'color', 'wireframe']) inputs[name].addEventListener('input', updateMaterials);
inputs.autoRotate.addEventListener('change', () => { controls.autoRotate = inputs.autoRotate.checked; });
inputs.grid.addEventListener('change', () => { grid.visible = inputs.grid.checked; });

viewerEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  viewerEl.classList.add('dragging');
});
viewerEl.addEventListener('dragleave', () => viewerEl.classList.remove('dragging'));
viewerEl.addEventListener('drop', (event) => {
  event.preventDefault();
  viewerEl.classList.remove('dragging');
  const [file] = event.dataTransfer.files;
  if (file) openFile(file);
});

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

inputs.color.value = `#${cssColor('--accent').getHexString()}`;
resize();
applyTheme();
showSample('knot');
renderer.setAnimationLoop(animate);
