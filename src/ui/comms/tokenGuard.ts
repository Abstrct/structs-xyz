/* The access-token box's guard. A token goes out as a Bearer header to whatever homeserver is in
 * the box, so a recovery phrase pasted there would be handed to a third party: refuse anything
 * that looks like one, and anything with spaces in it (a real token is one unbroken word). */
import { looksLikePhrase } from '../../wallet/keys';

/** Why this text must not be sent as an access token (null: it may be). */
export function tokenProblem(token: string): string | null {
  const t = token.trim();
  if (looksLikePhrase(t)) return 'That is a recovery phrase. Never paste it anywhere: chat needs an access token from another Matrix app.';
  if (/\s/.test(t)) return 'An access token is one word with no spaces. Never paste your recovery phrase here.';
  return null;
}
