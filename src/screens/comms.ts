/* Comms: the full-screen chat console over the guilds' Matrix servers.
 * Route: #/comms[/<roomId or #alias>] (encoded). Opening a room rewrites the URL in place. */
import type { Engine } from '../core/engine';
import { h } from '../core/dom';
import { replaceRoute } from '../core/nav';
import { PanelScreen } from './panelScreen';
import { CommsPanel } from '../ui/comms/panel';
import { startCommsAlerts } from '../ui/comms/alerts';

export class CommsScreen extends PanelScreen {
  private panel: CommsPanel | null = null;

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'comms', 5.1); }

  protected mount(params: Record<string, string>) {
    startCommsAlerts();
    const frame = h('div', { class: 'comms-frame' });
    this.root.appendChild(frame);
    this.panel = new CommsPanel(frame, {
      mode: 'full', nav: this.navigate, key: 'screen',
      onRoom: (r) => replaceRoute(r ? '/comms/' + encodeURIComponent(r.alias || r.id) : '/comms'),
    });
    if (params.room) this.panel.openRoom(params.room);
  }

  protected unmount() {
    this.panel?.destroy();
    this.panel = null;
  }
}
