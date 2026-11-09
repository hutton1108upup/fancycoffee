import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO_ASSETS } from '../deploy/video-assets.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const dirs = ['about', 'blog', 'contact', 'cookie', 'examples', 'fancy-cafe-pov-ideas', 'fancy-cafe-pov-meme-meaning', 'fancy-cafe-pov-trend-tiktok', 'first-time-in-a-fancy-cafe-ai-free', 'first-time-in-a-fancy-cafe-viral-video', 'fonts', 'how-to-make-first-time-in-a-fancy-cafe-ai-video', 'media', 'pricing', 'privacy', 'reference', 'refund', 'terms'];
const files = ['brand.svg', 'manifest.json', 'og.png', 'robots.txt', 'sitemap.xml', 'local-studio.js', 'analytics.js', 'index.html'];
const publicExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.webp', '.mp4', '.vtt', '.woff2', '.json']);
function injectStudioScript(html) { return html.replace(/\s*<script\s+src=["']\/(?:local-studio|analytics)\.js["'][^>]*><\/script>/gi, '').replace('</body>', '<script src="/local-studio.js" defer></script><script src="/analytics.js" defer></script></body>'); }
function copyTree(source, target) { mkdirSync(target, { recursive: true }); for (const entry of readdirSync(source)) { const from = join(source, entry); const to = join(target, entry); const info = lstatSync(from); if (info.isSymbolicLink()) throw new Error(`Refusing symlink in publish input: ${from}`); if (info.isDirectory()) copyTree(from, to); else if (publicExtensions.has(entry.slice(entry.lastIndexOf('.')).toLowerCase()) && !(source.toLowerCase().includes('examples') && entry.toLowerCase().endsWith('.json'))) { if (entry.endsWith('.html')) { const html = injectStudioScript(readFileSync(from, 'utf8')); writeFileSync(to, html); } else copyFileSync(from, to); } } }
if (dist === root || !dist.startsWith(root + '\\')) throw new Error(`Unsafe dist path: ${dist}`);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const file of files) { const source = join(root, file); if (file === 'index.html') { let content = injectStudioScript(readFileSync(source, 'utf8')); writeFileSync(join(dist, file), content); } else copyFileSync(source, join(dist, file)); }
for (const dir of dirs) copyTree(join(root, dir), join(dist, dir));
const exampleOutput = join(dist, 'media', 'examples');
if (lstatSync(exampleOutput, { throwIfNoEntry: false })) for (const entry of readdirSync(exampleOutput)) if (entry.toLowerCase().endsWith('.json')) { try { unlinkSync(join(exampleOutput, entry)); } catch { rmSync(join(exampleOutput, entry), { force: true }); } }
for (const metadata of ['person-output.json', 'pet-output.json']) { const path = join(exampleOutput, metadata); if (lstatSync(path, { throwIfNoEntry: false })) { try { unlinkSync(path); } catch { rmSync(path, { force: true }); } } }
for (const [pathname, expectedSize] of Object.entries(VIDEO_ASSETS)) { const source = join(root, pathname.slice(1)); const built = join(dist, pathname.slice(1)); if (statSync(source).size !== expectedSize || statSync(built).size !== expectedSize) throw new Error(`Video manifest size mismatch: ${pathname}`); }
let gitSha = 'unknown'; try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || 'unknown'; } catch {}
writeFileSync(join(dist, 'release.json'), JSON.stringify({ app: 'fancycoffee', build: 'static-preview', gitSha, generatedAt: new Date().toISOString(), externalProviders: 'unverified' }, null, 2) + '\n');
console.log(`Static publish build ready: ${dist}`); console.log(`gitSha: ${gitSha}`);
