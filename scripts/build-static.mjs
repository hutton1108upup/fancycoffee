import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const dirs = ['about', 'blog', 'contact', 'cookie', 'fancy-cafe-pov-ideas', 'fancy-cafe-pov-meme-meaning', 'fancy-cafe-pov-trend-tiktok', 'first-time-in-a-fancy-cafe-ai-free', 'first-time-in-a-fancy-cafe-viral-video', 'fonts', 'how-to-make-first-time-in-a-fancy-cafe-ai-video', 'media', 'pricing', 'privacy', 'reference', 'refund', 'terms'];
const files = ['brand.svg', 'manifest.json', 'og.png', 'robots.txt', 'local-studio.js', 'index.html'];
const publicExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.webp', '.mp4', '.vtt', '.woff2', '.json']);
function copyTree(source, target) { mkdirSync(target, { recursive: true }); for (const entry of readdirSync(source)) { const from = join(source, entry); const to = join(target, entry); const info = lstatSync(from); if (info.isSymbolicLink()) throw new Error(`Refusing symlink in publish input: ${from}`); if (info.isDirectory()) copyTree(from, to); else if (publicExtensions.has(entry.slice(entry.lastIndexOf('.')).toLowerCase())) { if (entry.endsWith('.html')) { let html = readFileSync(from, 'utf8').replaceAll('Local preview:', 'Production preview:'); if (from === join(root, 'index.html')) html = html.replace('</body>', '<script src="/local-studio.js" defer></script></body>'); writeFileSync(to, html); } else copyFileSync(from, to); } } }
if (dist === root || !dist.startsWith(root + '\\')) throw new Error(`Unsafe dist path: ${dist}`);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const file of files) { const source = join(root, file); if (file === 'index.html') { let content = readFileSync(source, 'utf8').replaceAll('Local preview:', 'Production preview:').replace('</body>', '<script src="/local-studio.js" defer></script></body>'); writeFileSync(join(dist, file), content); } else copyFileSync(source, join(dist, file)); }
for (const dir of dirs) copyTree(join(root, dir), join(dist, dir));
let gitSha = 'unknown'; try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || 'unknown'; } catch {}
writeFileSync(join(dist, 'release.json'), JSON.stringify({ app: 'fancycoffee', build: 'static-preview', gitSha, generatedAt: new Date().toISOString(), externalProviders: 'unverified' }, null, 2) + '\n');
console.log(`Static publish build ready: ${dist}`); console.log(`gitSha: ${gitSha}`);
