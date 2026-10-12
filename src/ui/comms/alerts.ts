/* Comms alerts, wherever you are in the client: a soft tick for traffic in the room on
 * screen, a ping and a toast when someone calls for you (mention or direct message) and
 * no panel shows that room, and a desktop notification when the tab is hidden and the
 * player opted in (Settings → alerts, shared with the raid alerts). */
import { toast } from '../../core/dom';
import { audio } from '../../core/audio';
import { commander } from '../../chain/commander';
import { comms } from '../../chat/matrix';
import { excerpt } from '../../chat/format';
import { roomLabel } from '../../chat/model';
import { CommsPanel } from './panel';
import { goTo } from '../../core/nav';

let opener: (roomId: string) => void = (id) => {
  if (CommsPanel.full) CommsPanel.full.openRoom(id); else goTo('/comms/' + encodeURIComponent(id));
};
let started = false;
let lastTick = 0;

/** Who opens a room from a toast (the dock registers itself; the default navigates to #/comms). */
export function setCommsOpener(fn: (roomId: string) => void) { opener = fn; }

export function startCommsAlerts() {
  if (started) return;
  started = true;
  comms.start();
  comms.onMessage((roomId, m, why) => {
    const r = comms.room(roomId);
    if (!r) return;
    const viewing = comms.isViewing(roomId);
    const now = Date.now();
    if (viewing) {
      if (now - lastTick > 1500) { lastTick = now; audio.play('tick', 0.6); }
      return;
    }
    const calls = why.mention || why.direct;
    if (comms.chat.muted.has(roomId) && !why.mention) return;
    if (!calls) {
      if (comms.anyPanelOpen && now - lastTick > 4000) { lastTick = now; audio.play('tick', 0.35); }
      return;
    }
    const who = comms.nameOf(m.sender, r);
    const where = r.isDirect ? '' : ' in ' + roomLabel(r, comms.me, (u) => comms.nameOf(u, r));
    const text = m.kind === 'image' ? 'sent an image' : excerpt(m.kind === 'emote' ? `* ${who} ${m.body}` : m.body, 110);
    audio.play('ping');
    toast(`${who}${where}: ${text}`, 'player', 6500, { label: 'Open ▸', run: () => opener(roomId) });
    if (document.hidden && commander.desktopAlerts && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${who}${where}`, { body: text, tag: 'structs-comms-' + roomId });
        n.onclick = () => { window.focus(); opener(roomId); n.close(); };
      } catch { /* some browsers only notify from a service worker */ }
    }
  });
}
