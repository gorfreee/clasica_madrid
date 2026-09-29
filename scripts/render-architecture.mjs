import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const dir = 'docs/architecture';
const specPath = `${dir}/architecture.json`;
const manifestPath = `${dir}/architecture.manifest.json`;
const toolchainPath = `${dir}/toolchain.json`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const toolchain = await json(toolchainPath);
const specBytes = await readFile(specPath);
const spec = JSON.parse(specBytes);
const inputs = [specPath, toolchainPath, 'scripts/render-architecture.mjs'];
const inputHashes = Object.fromEntries(await Promise.all(inputs.map(async p => [p, sha(await readFile(p))])));
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...options });

// This mode needs only Node: no Chromium, Archify, ffmpeg or network.
if (process.argv.includes('--check')) {
  const manifest = await json(manifestPath);
  for (const [p, hash] of Object.entries(inputHashes)) {
    if (manifest.inputs[p] !== hash) throw new Error(`${p} changed: run npm run architecture:render`);
  }
  for (const a of manifest.artifacts) {
    if (sha(await readFile(a.path)) !== a.sha256) throw new Error(`Stale or modified artifact: ${a.path}`);
  }
  for (const node of spec.components) for (const source of node.sources ?? []) {
    run('git', ['cat-file', '-e', `${spec.meta.repository.revision}:${source.path}`]);
    if (!existsSync(source.path)) throw new Error(`Implementation reference removed: ${source.path}`);
  }
  console.log('Architecture source, renderer, exports and implementation references are current.');
  process.exit(0);
}

const { chromium } = await import('playwright-core');
const cache = path.resolve('.local/architecture-tools/archify');
const archifyRoot = process.env.ARCHIFY_ROOT ? path.resolve(process.env.ARCHIFY_ROOT) : cache;
if (!existsSync(archifyRoot)) {
  await mkdir(path.dirname(cache), { recursive: true });
  run('git', ['clone', toolchain.archify.repository, cache], { stdio: 'inherit' });
  run('git', ['-C', cache, 'checkout', '--detach', toolchain.archify.revision], { stdio: 'inherit' });
}
if (run('git', ['-C', archifyRoot, 'rev-parse', 'HEAD']).trim() !== toolchain.archify.revision) {
  throw new Error('ARCHIFY_ROOT must match the pinned revision in toolchain.json');
}
const cli = path.join(archifyRoot, 'archify/bin/archify.mjs');
const browserPath = process.env.ARCHIFY_CHROME || chromium.executablePath();
if (!existsSync(browserPath)) throw new Error('Install Chromium (npx playwright install chromium) or set ARCHIFY_CHROME.');
run('ffmpeg', ['-version']);
const evidence = path.resolve('.local/architecture-review', specBytes.length + '-' + sha(specBytes).slice(0, 12));
const receipt = JSON.parse(run(process.execPath, [cli, 'finalize', 'architecture', specPath, `${dir}/architecture.html`, '--repo-root', root, '--quality', 'showcase', '--out-dir', evidence, '--json'], { env: { ...process.env, ARCHIFY_CHROME: browserPath } }));
if (!receipt.ok) throw new Error(JSON.stringify(receipt));

const frames = await mkdtemp(path.join(os.tmpdir(), 'clasica-architecture-'));
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  // Fonts are deliberately offline for identical exports and no third-party request.
  await page.route('https://fonts.googleapis.com/**', r => r.abort());
  await page.route('https://fonts.gstatic.com/**', r => r.abort());
  await page.goto(pathToFileURL(path.resolve(`${dir}/architecture.html`)).href + '?theme=dark');
  await page.waitForSelector('[data-node-id]');
  const download = page.waitForEvent('download');
  await page.locator('[data-format="svg-dark"]').evaluate(el => el.click());
  await (await download).saveAs(`${dir}/architecture.svg`);
  let svg = await readFile(`${dir}/architecture.svg`, 'utf8');
  // Derived export typography improves README-scale readability; geometry stays Archify-owned.
  const typography = toolchain.svgTypography;
  svg = svg.replace(/(<text[^>]*data-node-label=""[^>]*font-size=")\d+(")/g, `$1${typography.label}$2`)
    .replace(/(<text[^>]*data-detail="context"[^>]*font-size=")\d+(")/g, `$1${typography.context}$2`)
    .replace(/(<text[^>]*data-detail="fine"[^>]*font-size=")\d+(")/g, `$1${typography.fine}$2`);
  svg = svg.replace(/[ \t]+$/gm, '').trimEnd() + '\n';
  await writeFile(`${dir}/architecture.svg`, svg);
  const stages = [
    ['sources', 'Fuentes culturales · hechos verificables'],
    ['adapters', 'Registry y adapters · extraer e hidratar'],
    ['discovery', 'Discovery externo · import manual de observaciones'],
    ['pipeline', 'Pipeline común · determinismo primero'],
    ['ai', 'IA acotada · pool gratuito con fallback'],
    ['quality', 'Reconciliar, validar y escribir el lote'],
    ['catalog', 'Git · JSON versionado como fuente de verdad'],
    ['delivery', 'PR → CI → merge · controles antes de publicar'],
    ['app', 'Astro · del catálogo a páginas estáticas'],
    ['pages', 'Cloudflare Pages · servir artefactos estáticos'],
    ['users', 'Una agenda pública rápida y explorable'],
    ['contact', 'Contacto, analytics y rebuild · sistemas auxiliares'],
  ];
  for (const [id] of stages) if (!spec.components.some(n => n.id === id)) throw new Error(`Unknown animation node ${id}`);
  const vb = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const width = toolchain.gif.width;
  const height = Math.round(width * vb[3] / vb[2]) + 130;
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html lang="es"><style>html,body{margin:0;background:#020617;color:#e2e8f0;font-family:Arial,sans-serif}header{height:78px;box-sizing:border-box;padding:22px 28px 0}header strong{font-size:23px;letter-spacing:-.4px}header span{float:right;color:#94a3b8;font-size:13px;padding-top:8px}.figure svg{width:100%!important;height:auto!important;display:block}footer{height:52px;box-sizing:border-box;padding:16px 28px;color:#a7f3d0;font-size:16px;border-top:1px solid #1e293b}.figure [data-node-id],.figure [data-edge-from]{transition:none!important}.figure [data-detail]{opacity:1!important;visibility:visible!important}</style><header><strong>Clásica Madrid</strong><span>Fuentes → catálogo en Git → web estática</span></header><main class="figure">${svg}</main><footer id="caption">Arquitectura completa · del dato observado a la experiencia pública</footer></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${evidence}/readme-full.png` });
  const count = toolchain.gif.fps * toolchain.gif.seconds;
  for (let frame = 0; frame < count; frame++) {
    const progress = frame / count;
    const active = progress >= 0.1 && progress < 0.9;
    const position = active ? (progress - 0.1) / 0.8 * stages.length : -1;
    const index = Math.floor(position);
    const pulse = active ? Math.sin(Math.PI * (position - index)) ** 2 : 0;
    const stage = stages[index];
    await page.evaluate(({ active, stage, pulse }) => {
      const extras = stage?.[0] === 'contact' ? ['contact','analytics','rebuild','transport','actions'] : [stage?.[0]];
      for (const el of document.querySelectorAll('[data-node-id]')) {
        const match = extras.includes(el.getAttribute('data-node-id'));
        el.style.opacity = String(active ? match ? 0.83 + 0.17 * pulse : 0.83 : 0.83);
        el.style.filter = match ? `drop-shadow(0 0 ${3 + 5*pulse}px rgba(52,211,153,${0.2*pulse}))` : 'none';
        for (const rect of el.querySelectorAll('rect:not(.c-mask)')) rect.style.strokeWidth = match ? String(1.5 + 1.8*pulse) : '1.2';
      }
      for (const el of document.querySelectorAll('[data-edge-from]')) {
        const match = extras.includes(el.getAttribute('data-edge-to')) || extras.includes(el.getAttribute('data-edge-from'));
        el.style.opacity = String(active ? match ? 0.8 + 0.2*pulse : 0.55 : 0.9);
      }
      document.getElementById('caption').textContent = active ? stage[1] : 'Arquitectura completa · del dato observado a la experiencia pública';
    }, { active, stage, pulse });
    await page.screenshot({ path: path.join(frames, `${String(frame).padStart(4,'0')}.png`) });
  }
  run('ffmpeg', ['-hide_banner','-loglevel','error','-y','-framerate',String(toolchain.gif.fps),'-i',`${frames}/%04d.png`,'-filter_complex','[0:v]split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle','-loop','0',`${dir}/architecture.gif`]);
} finally {
  await browser.close();
  await rm(frames, { recursive: true, force: true });
}
const artifacts = [];
for (const name of ['architecture.html','architecture.svg','architecture.gif']) {
  const p = `${dir}/${name}`;
  const bytes = await readFile(p);
  artifacts.push({ path: p, sha256: sha(bytes), bytes: bytes.length });
}
const manifest = { schemaVersion: 1, diagramSchemaVersion: spec.schema_version, architectureRevision: spec.meta.repository.revision, generationBaseCommit: spec.meta.repository.revision, generatedAt: new Date().toISOString(), archify: toolchain.archify, inputs: inputHashes, artifacts, gif: toolchain.gif, validation: { showcase: 'passed', references: 'passed', browser: 'passed', perceptualReview: 'perform separately after regeneration' } };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ artifacts, manifest: manifestPath, evidence }, null, 2));
