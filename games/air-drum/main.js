import {
  INDEX_TIP, PADS, addHit, beatsBetween, eventsBetween, loopLength, padAt, strikeGain, updateStrike, wrapTime,
} from './logic.js';
import { cssValue } from '../shared/theme.js';
import { createHandLandmarker } from '../shared/hands.js';

const KEYS = { KeyQ: 'crash', KeyA: 'hihat', KeyS: 'snare', KeyT: 'tom', KeyD: 'floor', KeyP: 'ride', Space: 'kick' };

const viewerEl = document.getElementById('viewer');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const overlayEl = document.getElementById('overlay');
const cameraEl = document.getElementById('camera');
const showVideoEl = document.getElementById('show-video');
const metronomeEl = document.getElementById('metronome');
const bpmEl = document.getElementById('bpm');
const recordEl = document.getElementById('record');
const loopInfoEl = document.getElementById('loop-info');

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- 音（Web Audio でその場で作る） ----

let audio = null;
let noise = null;
// メトロノームとくり返しを、どの時刻まで予約したか
let metronomeFrom = 0;
let loopFrom = 0;

function startAudio() {
  if (!audio) {
    audio = new AudioContext();
    metronomeFrom = audio.currentTime;
    loopFrom = audio.currentTime;
  }
  if (audio.state === 'suspended') audio.resume();
  if (!noise) {
    noise = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
}

function envelope(gain, peak, decay, when) {
  gain.gain.setValueAtTime(peak, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + decay);
}

function noiseHit({ type, frequency, decay, peak }, when) {
  const source = audio.createBufferSource();
  source.buffer = noise;
  const filter = audio.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const gain = audio.createGain();
  envelope(gain, peak, decay, when);
  source.connect(filter).connect(gain).connect(audio.destination);
  source.start(when);
  source.stop(when + decay + 0.05);
}

function toneHit({ wave = 'sine', from, to, sweep, decay, peak }, when) {
  const osc = audio.createOscillator();
  osc.type = wave;
  osc.frequency.setValueAtTime(from, when);
  osc.frequency.exponentialRampToValueAtTime(to, when + sweep);
  const gain = audio.createGain();
  envelope(gain, peak, decay, when);
  osc.connect(gain).connect(audio.destination);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

function playSound(id, volume = 0.8, when = audio.currentTime) {
  const v = volume;
  switch (id) {
    case 'kick':
      toneHit({ from: 150, to: 45, sweep: 0.12, decay: 0.45, peak: 1.0 * v }, when);
      break;
    case 'snare':
      noiseHit({ type: 'highpass', frequency: 1200, decay: 0.2, peak: 0.6 * v }, when);
      toneHit({ wave: 'triangle', from: 220, to: 160, sweep: 0.05, decay: 0.12, peak: 0.5 * v }, when);
      break;
    case 'hihat':
      noiseHit({ type: 'highpass', frequency: 7000, decay: 0.06, peak: 0.45 * v }, when);
      break;
    case 'tom':
      toneHit({ from: 260, to: 150, sweep: 0.2, decay: 0.35, peak: 0.8 * v }, when);
      break;
    case 'floor':
      toneHit({ from: 150, to: 85, sweep: 0.25, decay: 0.5, peak: 0.9 * v }, when);
      break;
    case 'crash':
      noiseHit({ type: 'highpass', frequency: 4500, decay: 1.3, peak: 0.45 * v }, when);
      break;
    case 'ride':
      noiseHit({ type: 'bandpass', frequency: 8000, decay: 0.7, peak: 0.5 * v }, when);
      toneHit({ wave: 'triangle', from: 950, to: 900, sweep: 0.3, decay: 0.4, peak: 0.08 * v }, when);
      break;
    case 'click':
      toneHit({ from: 1500, to: 1500, sweep: 0.01, decay: 0.05, peak: 0.3 }, when);
      break;
    case 'clickLow':
      toneHit({ from: 1000, to: 1000, sweep: 0.01, decay: 0.05, peak: 0.2 }, when);
      break;
    default:
  }
}

// ---- 叩く ----

// 光らせる時間（太鼓ごと）
const flashes = new Map();
let recording = null;
let loop = null;

function strike(padId, gain) {
  if (!audio) return;
  playSound(padId, gain);
  flashes.set(padId, 0.25);
  if (recording) recording.hits = addHit(recording.hits, padId, audio.currentTime - recording.start, gain);
}

canvas.addEventListener('pointerdown', (event) => {
  if (!audio) return;
  const rect = canvas.getBoundingClientRect();
  const pad = padAt([(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height], rect.width / rect.height);
  if (pad) strike(pad.id, 0.8);
});
window.addEventListener('keydown', (event) => {
  const id = KEYS[event.code];
  if (!id || event.repeat || event.target.closest?.('input, select')) return;
  event.preventDefault();
  startAudio();
  overlayEl.hidden = true;
  strike(id, 0.8);
});

// ---- カメラの手 ----

let landmarker = null;
let stream = null;
let lastVideoTime = -1;
// 手ごとの、人差し指の先の状態
const hands = new Map();

async function startCamera() {
  cameraEl.disabled = true;
  setStatus('カメラと手の検出を準備中…（初回は数秒かかります）');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();
    landmarker ??= await createHandLandmarker();
  } catch (error) {
    console.warn(error);
    stopCamera();
    setStatus(error?.name === 'NotAllowedError'
      ? 'カメラが許可されなかった。画面をタップしても叩けるよ。'
      : 'このブラウザでは手の検出を使えなかった。画面をタップしても叩けるよ。');
    return;
  }
  cameraEl.textContent = 'カメラを止める';
  cameraEl.disabled = false;
  setStatus('人差し指を立てて、太鼓の上で素早く下へ振ってみよう。');
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  hands.clear();
  cameraEl.textContent = 'カメラで叩く';
  cameraEl.disabled = false;
}

function trackHands(now) {
  if (!landmarker || !stream || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const result = landmarker.detectForVideo(video, now);
  const aspect = canvas.width / canvas.height;
  const seen = new Set();
  result.landmarks.forEach((landmarks, i) => {
    const key = result.handedness?.[i]?.[0]?.categoryName ?? String(i);
    if (seen.has(key)) return;
    seen.add(key);
    // 鏡に映した向きにする
    const tip = [1 - landmarks[INDEX_TIP].x, landmarks[INDEX_TIP].y];
    const pad = padAt(tip, aspect);
    const hand = hands.get(key) ?? { strike: null };
    const { state, hit } = updateStrike(hand.strike, { y: tip[1], time: now / 1000, pad });
    hand.strike = state;
    hand.tip = tip;
    hands.set(key, hand);
    if (hit) strike(hit.pad.id, strikeGain(hit.speed));
  });
  for (const key of [...hands.keys()]) if (!seen.has(key)) hands.delete(key);
}

// ---- メトロノームと録音 ----

function scheduleAudio() {
  if (!audio) return;
  const now = audio.currentTime;
  const ahead = now + 0.12;
  const bpm = Number(bpmEl.value);
  if (metronomeEl.checked) {
    for (const beat of beatsBetween(bpm, metronomeFrom, ahead)) playSound(beat % 4 === 0 ? 'click' : 'clickLow', 1, beat * (60 / bpm));
  }
  metronomeFrom = ahead;
  if (loop) {
    for (const event of eventsBetween(loop.hits, loop.length, loopFrom - loop.start, ahead - loop.start)) {
      const when = loop.start + event.at;
      playSound(event.pad, event.gain, when);
      setTimeout(() => flashes.set(event.pad, 0.25), Math.max(0, (when - now) * 1000));
    }
  }
  loopFrom = ahead;
}

recordEl.addEventListener('click', () => {
  startAudio();
  const bpm = Number(bpmEl.value);
  if (!recording) {
    recording = { start: audio.currentTime, hits: [] };
    recordEl.textContent = '■ 録音を止める';
    setStatus('録音中…叩いてね。');
    return;
  }
  const { hits, start } = recording;
  recording = null;
  recordEl.textContent = '● 録音';
  if (hits.length === 0) return setStatus('何も録音されなかった。');
  if (loop) {
    // 重ね録り：くり返しの長さに合わせて足す
    const shifted = hits.map((hit) => ({ ...hit, time: wrapTime(hit.time + (start - loop.start), loop.length) }));
    loop.hits = [...loop.hits, ...shifted];
  } else {
    // 小節に丸めた長さでくり返す。丸めて短くなったときにはみ出した音は、頭へ回す
    const length = loopLength(audio.currentTime - start, bpm);
    loop = { start, length, hits: hits.map((hit) => ({ ...hit, time: wrapTime(hit.time, length) })) };
    loopFrom = audio.currentTime;
  }
  document.getElementById('clear-loop').disabled = false;
  loopInfoEl.textContent = `くり返し ${loop.length.toFixed(1)} 秒・${loop.hits.length} 音`;
  setStatus('録音した音をくり返し鳴らしているよ。重ねて録音もできる。');
});
document.getElementById('clear-loop').addEventListener('click', () => {
  loop = null;
  loopInfoEl.textContent = '';
  document.getElementById('clear-loop').disabled = true;
});
bpmEl.addEventListener('input', () => {
  document.getElementById('bpm-value').textContent = bpmEl.value;
});

// ---- 描画 ----

let colors = {};

function applyTheme() {
  colors = Object.fromEntries([...new Set([...PADS.map((p) => p.color), '--surface', '--text', '--accent', '--bg'])].map((name) => [name, cssValue(name)]));
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.round(viewerEl.clientWidth * ratio);
  canvas.height = Math.round(viewerEl.clientHeight * ratio);
}

function draw(frame) {
  const { width, height } = canvas;
  const shortSide = Math.min(width, height);
  ctx.fillStyle = colors['--bg'];
  ctx.fillRect(0, 0, width, height);
  if (stream && showVideoEl.checked && video.readyState >= 2) {
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  }
  for (const pad of PADS) {
    const flash = flashes.get(pad.id) ?? 0;
    const r = pad.r * shortSide * (1 + flash * 0.3);
    ctx.beginPath();
    ctx.arc(pad.x * width, pad.y * height, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.35 + flash * 2;
    ctx.fillStyle = colors[pad.color];
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(2, shortSide * 0.008);
    ctx.strokeStyle = colors[pad.color];
    ctx.stroke();
    ctx.fillStyle = colors['--text'];
    ctx.font = `700 ${Math.round(shortSide * 0.045)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pad.label, pad.x * width, pad.y * height);
    if (flash > 0) flashes.set(pad.id, Math.max(0, flash - frame));
  }
  // 指先
  for (const hand of hands.values()) {
    if (!hand.tip) continue;
    ctx.beginPath();
    ctx.arc(hand.tip[0] * width, hand.tip[1] * height, shortSide * 0.025, 0, Math.PI * 2);
    ctx.fillStyle = hand.strike?.armed ? colors['--accent'] : colors['--text'];
    ctx.fill();
  }
  if (recording) {
    ctx.beginPath();
    ctx.arc(width - shortSide * 0.05, shortSide * 0.05, shortSide * 0.02, 0, Math.PI * 2);
    ctx.fillStyle = colors['--piece-z'];
    ctx.fill();
  }
}

document.getElementById('start-camera').addEventListener('click', () => {
  startAudio();
  overlayEl.hidden = true;
  startCamera();
});
document.getElementById('start-touch').addEventListener('click', () => {
  startAudio();
  overlayEl.hidden = true;
  cameraEl.disabled = false;
  cameraEl.textContent = 'カメラで叩く';
  setStatus('太鼓をタップして叩こう。');
});
cameraEl.addEventListener('click', () => (stream ? stopCamera() : startCamera()));

new ResizeObserver(resize).observe(viewerEl);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
resize();

let last = performance.now();
function loopFrame(now) {
  const frame = Math.min(0.1, (now - last) / 1000);
  last = now;
  trackHands(now);
  scheduleAudio();
  draw(frame);
  requestAnimationFrame(loopFrame);
}
requestAnimationFrame(loopFrame);
