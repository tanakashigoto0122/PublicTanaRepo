import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseModel } from '../shared/models.js';
import { listCharacters } from '../shared/storage.js';
import { cssValue } from '../shared/theme.js';
import { advanceRotation, modelScale } from './logic.js';

const $ = (id) => document.getElementById(id);
const status = (text) => { $('status').textContent = text; };
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
} catch {
  status('3D表示を開始できません。このブラウザで WebGL を有効にして、ページを開き直してください。');
}
if (renderer) start();

function start() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  $('viewer').append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 3;
  controls.maxDistance = 12;
  const light = new THREE.DirectionalLight(cssValue('--surface'), 3);
  light.position.set(3, 5, 4);
  scene.add(light, new THREE.HemisphereLight(cssValue('--surface'), cssValue('--muted'), 2));
  const material = new THREE.MeshStandardMaterial({ roughness: 0.65 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.8, 0.18, 64), material);
  base.position.y = -0.09;
  scene.add(base);
  const holder = new THREE.Group();
  scene.add(holder);
  let paused = false;
  let token = 0;
  let records = [];

  function theme() {
    scene.background = new THREE.Color(cssValue('--surface'));
    material.color.set(cssValue($('palette').value));
  }
  function reset() {
    camera.position.set(3.6, 2.8, 5);
    controls.target.set(0, 0.9, 0);
    controls.update();
  }
  function dispose(object) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    object.traverse((child) => {
      if (child.geometry) geometries.add(child.geometry);
      for (const m of [child.material].flat().filter(Boolean)) {
        materials.add(m);
        for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
      }
    });
    textures.forEach((t) => t.dispose());
    materials.forEach((m) => m.dispose());
    geometries.forEach((g) => g.dispose());
  }
  function sample() {
    const robot = new THREE.Group();
    const parts = [[0, 1.05, 0, 0.8, 0.8, 0.5], [0, 1.75, 0, 0.6, 0.5, 0.6], [-0.55, 1, 0, 0.25, 0.7, 0.3], [0.55, 1, 0, 0.25, 0.7, 0.3], [-0.23, 0.3, 0, 0.3, 0.6, 0.4], [0.23, 0.3, 0, 0.3, 0.6, 0.4]];
    for (const [x, y, z, w, h, d] of parts) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: cssValue('--piece-l') }));
      mesh.position.set(x, y, z);
      robot.add(mesh);
    }
    return robot;
  }
  async function show(record) {
    const request = ++token;
    $('capture').disabled = true;
    status('作品を準備中…');
    let object;
    try {
      object = record ? await parseModel(record, { stlNormals: true }) : sample();
      if (request !== token) { dispose(object); return; }
      const box = new THREE.Box3().setFromObject(object);
      const scale = modelScale(box.getSize(new THREE.Vector3()).toArray());
      const center = box.getCenter(new THREE.Vector3());
      object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z)).multiplyScalar(scale);
      object.scale.multiplyScalar(scale);
      const facing = new THREE.Group();
      facing.rotation.y = Number.isFinite(record?.facing) ? record.facing : 0;
      facing.add(object);
      for (const child of [...holder.children]) { holder.remove(child); dispose(child); }
      holder.add(facing);
      holder.rotation.y = 0;
      status(record ? `「${record.name}」を展示しています。` : 'お手本を展示しています。');
    } catch {
      if (object) dispose(object);
      if (request === token) status('読み込めませんでした。単体の glb / obj / stl、またはデータ内蔵の gltf を選んでください。前の展示はそのままです。');
    } finally {
      if (request === token) $('capture').disabled = holder.children.length === 0;
    }
  }
  async function refresh() {
    $('refresh').disabled = true;
    try {
      records = await listCharacters();
      const previous = $('character').value;
      $('character').replaceChildren(new Option('お手本の積み木ロボ', ''), ...records.map((r) => new Option(r.name, r.id)));
      if (records.some((r) => r.id === previous)) $('character').value = previous;
      status(`${records.length} 件の保存済み作品を読み込みました。作品を選んで展示できます。`);
    } catch { status('保存済み作品を読み込めませんでした。ファイルから開くか、お手本で遊べます。'); }
    finally { $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', refresh);
  $('character').addEventListener('change', () => show(records.find((r) => r.id === $('character').value)));
  $('file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const format = file.name.split('.').pop().toLowerCase();
    if (!['glb', 'gltf', 'obj', 'stl'].includes(format)) return status('glb / gltf / obj / stl を選んでください。');
    // ファイルの読み取りも選択順を守る。
    const request = ++token;
    try {
      const data = await file.arrayBuffer();
      if (request !== token) return;
      $('character').value = '';
      await show({ name: file.name, format, data });
    } catch { if (request === token) status('ファイルを読み取れませんでした。'); }
  });
  $('pause').addEventListener('click', () => {
    paused = !paused;
    $('pause').textContent = paused ? '回転を再開' : '回転を止める';
    $('pause').setAttribute('aria-pressed', String(paused));
  });
  $('speed').addEventListener('input', () => { $('speed-value').value = $('speed').value; });
  $('palette').addEventListener('change', theme);
  $('reset').addEventListener('click', reset);
  $('capture').addEventListener('click', () => {
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
      if (!blob) return status('写真を保存できませんでした。');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '3d-stage.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('展示の写真を保存しました。');
    }, 'image/png');
  });
  new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = $('viewer');
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe($('viewer'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', theme);
  let previous = performance.now();
  renderer.setAnimationLoop((now) => {
    if (!paused && !document.hidden) holder.rotation.y = advanceRotation(holder.rotation.y, (now - previous) / 1000, Number($('speed').value));
    previous = now;
    controls.update();
    renderer.render(scene, camera);
  });
  theme();
  reset();
  show();
  refresh();
}
