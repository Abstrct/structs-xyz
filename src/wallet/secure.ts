/* The vault seals the recovery phrase with the browser's WebCrypto, which a browser only gives a
 * page it trusts: https://, or this computer's own localhost. Anywhere else (http:// at a network
 * address) the page could be changed on its way in, and a recovery phrase must never be typed there,
 * so the vault says so in plain words instead of failing on a missing `crypto.subtle`. */
export const INSECURE_PAGE = 'This page isn’t secure (it starts with http://), so the vault won’t open here. Use the https:// address, or localhost on this computer. Never type a recovery phrase on a page like this.';

/** Why the vault can't work on this page, or null when it can. */
export function insecurePage(): string | null {
  const g = globalThis as { isSecureContext?: boolean; crypto?: Crypto };
  return g.isSecureContext === false || !g.crypto?.subtle ? INSECURE_PAGE : null;
}
