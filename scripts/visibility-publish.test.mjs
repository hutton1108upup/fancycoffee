import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { VIDEO_ASSETS } from '../deploy/video-assets.mjs';

const root = process.cwd();
const expectedExampleAssets = [
  'media/examples/person-input.png',
  'media/examples/person-output-poster.jpg',
  'media/examples/person-output.mp4',
  'media/examples/pet-input.jpg',
  'media/examples/pet-output-poster.jpg',
  'media/examples/pet-output.mp4',
];

function sourcePath(pathname) { return join(root, ...pathname.split('/').filter(Boolean)); }
function filesUnder(directory) { if (!existsSync(directory)) return []; return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { const path = join(directory, entry.name); return entry.isDirectory() ? filesUnder(path) : [path]; }); }

test('sitemap targets exist and are indexable', () => {
  const sitemap = readFileSync(sourcePath('sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]).pathname);
  assert.ok(locs.includes('/examples/'));
  for (const pathname of locs) {
    const htmlPath = pathname === '/' ? sourcePath('index.html') : sourcePath(`${pathname.replace(/^\//, '').replace(/\/$/, '')}/index.html`);
    assert.equal(existsSync(htmlPath), true, `missing sitemap target ${pathname}`);
    const html = readFileSync(htmlPath, 'utf8');
    assert.doesNotMatch(html, /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i, `noindex sitemap target ${pathname}`);
  }
});

test('example media and MP4 byte manifest are publishable', () => {
  for (const asset of expectedExampleAssets) assert.equal(existsSync(sourcePath(asset)), true, `missing example asset ${asset}`);
  for (const [pathname, expectedSize] of Object.entries(VIDEO_ASSETS)) {
    assert.equal(existsSync(sourcePath(pathname.slice(1))), true, `missing manifest asset ${pathname}`);
    assert.equal(statSync(sourcePath(pathname.slice(1))).size, expectedSize, `manifest size mismatch ${pathname}`);
  }
});

test('built output cannot contain private data directories', (t) => {
  const dist = sourcePath('dist');
  if (!existsSync(dist)) return t.skip('dist is absent; run the static build before the publish-output check');
  assert.equal(existsSync(join(dist, '.data')), false);
  assert.equal(existsSync(join(dist, '.secrets')), false);
  assert.equal(existsSync(join(dist, 'examples', 'index.html')), true);
  for (const asset of expectedExampleAssets) assert.equal(existsSync(join(dist, ...asset.split('/'))), true, `missing built example asset ${asset}`);
  const builtExamplesDir = join(dist, 'media', 'examples');
  const approvedExampleFiles = expectedExampleAssets.map((asset) => asset.split('/').pop()).sort();
  assert.deepEqual(readdirSync(builtExamplesDir).sort(), approvedExampleFiles, 'built media/examples contains an unapproved or missing asset');
  assert.deepEqual(readdirSync(join(dist, 'examples')).filter((name) => name.toLowerCase().endsWith('.json')), [], 'built examples route contains raw JSON');
  const builtFiles = filesUnder(dist);
  assert.equal(builtFiles.some((file) => file.includes(`${join('dist', '.data')}`) || file.includes(`${join('dist', '.secrets')}`)), false);
  const textExtensions = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.xml']);
  for (const file of builtFiles.filter((file) => textExtensions.has(file.slice(file.lastIndexOf('.')).toLowerCase()))) {
    const content = readFileSync(file).toString('utf8');
    assert.equal(content.includes('C:/Users/') || content.includes('\\.data\\') || content.includes('\\.secrets\\'), false, `private path leaked into ${file}`);
  }
});
