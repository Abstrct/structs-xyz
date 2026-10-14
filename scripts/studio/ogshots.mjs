/* Share pictures (Open Graph, 1200×630) cut from the README's screenshots (docs/*.jpg, 1440×900):
 * scaled to 1200 wide, then the middle 630 rows. public/og.jpg is the site's picture (the title
 * screen); public/og/<name>.jpg is each screen's, named in src/data/seo.ts. Run docshots first.
 *   node scripts/studio/ogshots.mjs */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, 'public', 'og');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'structs-og-'));
const cut = (name, dest) => {
  const src = join(ROOT, 'docs', name + '.jpg');
  if (!existsSync(src)) { console.log('△ no docs/' + name + '.jpg'); return; }
  const mid = join(tmp, name + '.jpg');
  execFileSync('sips', ['-z', '750', '1200', src, '--out', mid], { stdio: 'ignore' });
  execFileSync('sips', ['-c', '630', '1200', mid, '-s', 'formatOptions', '82', '--out', dest], { stdio: 'ignore' });
  console.log('✓ ' + dest.slice(ROOT.length));
};
cut('title', join(ROOT, 'public', 'og.jpg'));
for (const name of ['lobby', 'academy', 'galaxy', 'combat', 'grid', 'battle', 'codex', 'deck', 'robots', 'forge', 'economy', 'intel']) cut(name, join(OUT, name + '.jpg'));
rmSync(tmp, { recursive: true, force: true });
