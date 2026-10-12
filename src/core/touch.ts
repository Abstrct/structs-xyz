/* A touch screen (no hover, a finger for a pointer): the words for its gestures. The desktop's
 * words stay as they are; a phone reads the same help in its own verbs. */
export const touchScreen = () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Help text in a finger's verbs on a touch screen: tap for click, pinch for the wheel. */
export function touchWords(text: string): string {
  if (!touchScreen()) return text;
  return text
    .replace(/\b(scroll|wheel) to zoom\b/gi, (m) => (m[0] === m[0].toUpperCase() ? 'Pinch to zoom' : 'pinch to zoom'))
    .replace(/\bdouble-click\b/g, 'double-tap').replace(/\bDouble-click\b/g, 'Double-tap')
    .replace(/\bclicks?\b/g, (m) => (m.endsWith('s') ? 'taps' : 'tap')).replace(/\bClick\b/g, 'Tap')
    .replace(/\bhover(ing)? (over|on)\b/gi, 'tap');
}
