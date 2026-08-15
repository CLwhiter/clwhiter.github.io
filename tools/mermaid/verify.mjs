// Verification gate: prove the COMMITTED bundle (assets/mermaid/mermaid.min.js)
// serves the real site content, in a real Chromium.
//
// jsdom is NOT acceptable here (no SVG getBBox) — must be puppeteer.
//
// Usage: npm run verify   (from tools/mermaid/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', '..', 'assets', 'mermaid', 'mermaid.min.js');
const POSTS_DIR = path.join(HERE, '..', '..', '_posts');

// --- 1. Extract every fenced ```mermaid block from all posts -------------
const blocks = [];
for (const file of fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'))) {
  const src = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
  const re = /```mermaid\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1].trim();
    blocks.push({
      file,
      firstLine: body.split('\n')[0].trim(),
      body,
    });
  }
}

console.log(`Extracted ${blocks.length} mermaid blocks from _posts/`);
for (const b of blocks) console.log(`  - [${b.file}] ${b.firstLine}`);

// Guard: the site currently has 7 blocks (6 flowchart + 1 sequenceDiagram
// across 2 posts). Assert >= 7 so a future post regressing to zero blocks
// (or a front-matter change that stops fences from being recognized) fails
// this gate rather than silently verifying nothing.
if (blocks.length < 7) {
  console.error(
    `FAIL: expected at least 7 mermaid blocks in _posts/, found ${blocks.length}`
  );
  process.exit(1);
}

// --- 2. Launch Chromium and load the committed bundle --------------------
const bundleSrc = fs.readFileSync(BUNDLE, 'utf8');
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.setContent('<!doctype html><html><head></head><body></body></html>');
await page.addScriptTag({ content: bundleSrc });

// --- 3. API surface + parse every real post block ------------------------
const results = await page.evaluate(async (blocks) => {
  const out = { api: {}, parse: [] };

  // Chirpy contract (theme _javascript/modules/components/mermaid.js):
  // guards on `typeof mermaid === 'undefined' || typeof mermaid.initialize
  // !== 'function'`, then initialize({theme}) and init(null, '.mermaid').
  for (const member of ['initialize', 'run', 'init', 'parse', 'render', 'mermaidAPI']) {
    out.api[member] = window.mermaid !== undefined && window.mermaid[member] !== undefined;
  }

  window.mermaid.initialize({ startOnLoad: false, theme: 'default' });

  for (const b of blocks) {
    let ok;
    let err = null;
    try {
      ok = await window.mermaid.parse(b.body);
    } catch (e) {
      ok = false;
      err = String(e && e.message ? e.message : e);
    }
    out.parse.push({ firstLine: b.firstLine, ok: !!ok, err });
  }
  return out;
}, blocks);

let failed = false;

for (const [member, present] of Object.entries(results.api)) {
  if (!present) {
    console.error(`FAIL: window.mermaid.${member} missing`);
    failed = true;
  }
}
console.log(
  `API surface: ${Object.entries(results.api).filter(([, v]) => v).length}/6 members present`
);

console.log('Block'.padEnd(60), 'Result');
for (const r of results.parse) {
  const label = r.firstLine.slice(0, 58);
  if (r.ok) {
    console.log(label.padEnd(60), 'PASS');
  } else {
    console.log(label.padEnd(60), `FAIL  ${r.err}`);
    failed = true;
  }
}

// --- 4. Chirpy integration path: run() converts pre.mermaid to SVG -------
// mermaid 11 replaces the source text with an <svg> plus an inline <style>;
// pre.textContent is then the injected CSS, not empty — so assert the diagram
// SOURCE text is gone instead of asserting empty text.
const chirpyRun = await page.evaluate(async () => {
  document.body.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'mermaid';
  pre.textContent = 'flowchart TD\n  A[Start] --> B{Guard}\n  B -->|ok| C[End]';
  document.body.appendChild(pre);
  await window.mermaid.run({ querySelector: '.mermaid' });
  const svg = pre.querySelector('svg');
  return {
    converted: !!svg,
    sourceGone: !pre.textContent.includes('[Start]'),
    processed: pre.getAttribute('data-processed') === 'true',
  };
});
if (!(chirpyRun.converted && chirpyRun.sourceGone && chirpyRun.processed)) {
  console.error('FAIL: Chirpy-style run() path did not convert pre.mermaid to SVG', chirpyRun);
  failed = true;
} else {
  console.log('Chirpy run() path: pre.mermaid converted to <svg>  PASS');
}

// --- render() one flowchart and one sequenceDiagram to SVG ---------------
const renders = await page.evaluate(async () => {
  const out = {};
  const fc = await window.mermaid.render('verify-fc', 'flowchart LR\n  X --> Y');
  out.flowchart = typeof fc === 'string' ? fc : fc.svg;
  const sq = await window.mermaid.render('verify-sq', 'sequenceDiagram\n  A->>B: hi\n  B-->>A: ok');
  out.sequence = typeof sq === 'string' ? sq : sq.svg;
  return out;
});
for (const [name, svg] of Object.entries(renders)) {
  if (typeof svg !== 'string' || !svg.startsWith('<svg')) {
    console.error(`FAIL: mermaid.render() ${name} did not produce an <svg> string`);
    failed = true;
  } else {
    console.log(`mermaid.render() ${name}: <svg> produced  PASS`);
  }
}

// --- 5. pageerror gate ----------------------------------------------------
if (pageErrors.length > 0) {
  console.error('FAIL: pageerror events fired:');
  for (const e of pageErrors) console.error('  ', e);
  failed = true;
} else {
  console.log('pageerror events: 0  PASS');
}

await browser.close();

if (failed) {
  console.error('VERIFY FAILED');
  process.exit(1);
}
console.log('VERIFY PASSED');
