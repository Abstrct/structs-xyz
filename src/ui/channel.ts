/* Open an object's comms channel (#planet-2-N, #fleet-9-N on its owner's guild homeserver)
 * in the dock; explain plainly when comms aren't signed in. */
import { toast } from '../core/dom';
import { comms } from '../chat/matrix';
import { mountCommsDock } from './comms/dock';

export async function openChannel(objectId: string) {
  const dock = mountCommsDock();
  if (comms.state === 'signedOut' || comms.state === 'idle' || comms.state === 'expired') { dock.open(); toast('Sign in to comms to open the channel', 'warn'); return; }
  try { const room = await comms.openObjectRoom(objectId); dock.open(room); }
  catch (e) { toast('Channel unavailable: ' + (e as Error).message, 'warn', 5000); dock.open(); }
}
