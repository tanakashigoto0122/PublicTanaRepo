// 3D モデル（glb / gltf / obj / stl）を読み込む部品。いくつかのゲームで共通に使う。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { cssValue } from './theme.js';

// 色を持たない obj / stl に使う材質
export function plainMaterial(options = {}) {
  return new THREE.MeshStandardMaterial({ color: cssValue('--piece-j'), ...options });
}

// { object, animations } を返す。material は obj / stl に付ける材質を作る関数。
// stlNormals: STL の法線を作り直す（ファイルの法線が当てにならないことがある）
export async function loadModel({ format, data }, { material = () => plainMaterial({ roughness: 0.5 }), stlNormals = false } = {}) {
  if (format === 'glb' || format === 'gltf') {
    // gltfpack などで meshopt 圧縮した .glb も開けるようにする
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(format === 'gltf' ? new TextDecoder().decode(data) : data, '');
    return { object: gltf.scene, animations: gltf.animations };
  }
  if (format === 'obj') {
    const object = new OBJLoader().parse(new TextDecoder().decode(data));
    object.traverse((child) => {
      if (child.isMesh) child.material = material();
    });
    return { object, animations: [] };
  }
  const geometry = new STLLoader().parse(data);
  if (stlNormals) geometry.computeVertexNormals();
  // STL は Z 軸が上のことが多いので、Y 軸が上になるように起こす
  const mesh = new THREE.Mesh(geometry, material());
  mesh.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(mesh);
  return { object: group, animations: [] };
}

// 形だけ欲しいとき
export async function parseModel(record, options) {
  return (await loadModel(record, options)).object;
}

// キャラクターがないときの粘土の玉（半径 1）。segments は細かさ [横, 縦]
export function clayBall({ segments = [96, 64], roughness = 0.4 } = {}) {
  const geometry = new THREE.SphereGeometry(1, segments[0], segments[1]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: cssValue('--piece-l'), roughness }));
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}
