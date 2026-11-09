// カメラの映像から手を見つける MediaPipe の準備。映像はブラウザの中だけで処理し、送信しない。
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const MEDIAPIPE = new URL('../../assets/vendor/mediapipe/', import.meta.url).href;

export async function createHandLandmarker({ numHands = 2 } = {}) {
  const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${MEDIAPIPE}models/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numHands,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (error) {
    // GPU が使えない端末では CPU で動かす
    console.warn(error);
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}
