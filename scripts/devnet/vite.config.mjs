// The app's Vite config for the devnet: HMR off, so other work on src/ can't reload the page in the
// middle of a transaction under test (reload deliberately — cdp.mjs /reload — to pick up new code).
// The page calls the mock Guild API (mock-guild.mjs) directly, as it calls any guild.
import base from '../../vite.config.ts';

export default {
  ...base,
  server: { ...(base.server || {}), hmr: false },
};
