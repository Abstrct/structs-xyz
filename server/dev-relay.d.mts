/* Types for dev-relay.mjs (the dev server's chat sign-in relay), for the tests in scripts/. */
export const RELAY_PATH: string;
export const REDIRECT_URI: string;
export class Jar {
  cookies: { name: string; value: string; domain: string; hostOnly: boolean; path: string }[];
  take(url: string, res: Response): void;
  header(url: string): string;
}
export function follow(f: typeof fetch, jar: Jar | null, start: string): Promise<{ callback?: string; page?: { url: string; body: string } }>;
export function parseForm(body: string, base: string): { action: string; fields: [string, string][] } | null;
export function oidcRequestId(url: string, body: string): string | null;
export interface RelayInput {
  homeserver: string; guildApi: string; deviceId?: string;
  login: { address: string; signature: string; pubkey: string; guild_id: string; unix_timestamp: number | string };
}
export interface RelayTokens { access_token: string; refresh_token: string | null; expires_in: number | null; client_id: string; token_endpoint: string; device_id: string }
export function relaySignIn(input: RelayInput, deps?: { f?: typeof fetch; clients?: Record<string, string>; save?: (c: Record<string, string>) => void }): Promise<RelayTokens>;
export function devRelayPlugin(): import('vite').Plugin;
