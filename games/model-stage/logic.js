// 回転速度は 1 分間の回転数。長い中断後も急に回転しないようにする。
export function advanceRotation(angle, seconds, rpm) {
  if (![angle, seconds, rpm].every(Number.isFinite)) throw new TypeError('有限の数が必要です');
  const turn = Math.PI * 2;
  return ((angle + Math.max(0, Math.min(seconds, 0.1)) * Math.max(0, Math.min(rpm, 12)) * turn / 60) % turn + turn) % turn;
}

export function modelScale(size) {
  if (!Array.isArray(size) || size.length !== 3 || size.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new TypeError('モデルの大きさが不正です');
  }
  const longest = Math.max(...size);
  if (longest <= 0) throw new RangeError('空のモデルです');
  return 2 / longest;
}
