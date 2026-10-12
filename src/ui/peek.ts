/* Touch screens have no hover. Everything that explains itself only in its title (a stat chip, an
 * icon, a number) shows that title as a bubble when tapped, for a few seconds. Controls keep their
 * own taps, and the 3D view keeps its own. */
import { flashTooltip } from '../core/dom';

const CONTROLS = 'button, a[href], input, select, textarea, label, [role="button"], canvas, .tooltip';

export function startPeek() {
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    // A tap on a control (even one inside a titled card) is that control's own.
    const hit = e.target as Element | null;
    if (!hit?.closest || hit.closest(CONTROLS)) return;
    const el = hit.closest('[title]') as HTMLElement | null;
    const text = el?.getAttribute('title');
    if (text) flashTooltip(e.clientX, e.clientY, text);
  }, true);
}
