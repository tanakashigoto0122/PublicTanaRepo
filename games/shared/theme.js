// ページの色（assets/style.css の CSS 変数）を読む
export function cssValue(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
