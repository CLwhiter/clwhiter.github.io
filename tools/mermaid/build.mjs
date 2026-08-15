// Build the trimmed mermaid bundle for clwhiter.github.io.
//
// Mechanism: mermaid's ESM entry lazy-imports each diagram via
// `await import("./chunks/mermaid.esm/<name>-<hash>.mjs")`. Because esbuild
// inlines dynamic imports into the single iife output, the only way to
// exclude a diagram (and its transitive deps — langium core 1.26MB,
// cytoscape 1MB, katex 505KB) is to alias the unwanted chunk file to a stub
// module at resolve time.
//
// All four stub patterns below MUST stay present; missing any one lets
// megabytes back into the bundle:
//   1. Diagram-*.mjs      — class/gantt/pie/state/er/git/... diagram chunks
//   2. -definition-*.mjs  — mindmap/kanban/timeline (langium-based)
//   3. ^diagram-*.mjs     — generic diagram chunks
//   4. ^katex-*.mjs       — mermaid math labels (site uses MathJax)
//
// Usage: npm install && npm run build
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHUNK_DIR = path.join(
  HERE,
  'node_modules',
  'mermaid',
  'dist',
  'chunks',
  'mermaid.esm'
);
const STUB_DIAGRAM = path.join(HERE, 'stubs', 'stub-diagram.mjs');
const STUB_KATEX = path.join(HERE, 'stubs', 'stub-katex.mjs');
const OUTFILE = path.join(HERE, '..', '..', 'assets', 'mermaid', 'mermaid.min.js');

// Diagram types kept in the bundle. Add a chunk base name here (and rebuild)
// to un-trim a diagram type. Base name = chunk filename minus the -HASH.mjs
// suffix, e.g. `flowDiagram-ABC123.mjs` -> `flowDiagram`.
const KEEP = new Set(['flowDiagram', 'sequenceDiagram']);

// Hard fail-closed gate: refuse to emit a bundle over 550KB gzip (baseline
// full bundle is 916KB gzip; trimmed target ~445KB). Guards against a future
// mermaid bump silently re-inflating the payload.
const GZIP_LIMIT = 550_000;

const STUB_PATTERNS = [
  /Diagram-[A-Z0-9]+\.mjs$/,
  /-definition-[A-Z0-9]+\.mjs$/,
  /^diagram-[A-Z0-9]+\.mjs$/,
];

function baseName(file) {
  return file.replace(/-[A-Z0-9]+\.mjs$/, '');
}

const files = fs.readdirSync(CHUNK_DIR).filter((f) => f.endsWith('.mjs'));

const alias = {};
for (const f of files) {
  const base = baseName(f);
  // Keep-list is matched against the base name BEFORE any stub pattern, so a
  // kept diagram is never stubbed even if its filename matches a pattern.
  if (KEEP.has(base)) continue;

  if (STUB_PATTERNS.some((re) => re.test(f))) {
    alias[path.join(CHUNK_DIR, f)] = STUB_DIAGRAM;
  } else if (/^katex-[A-Z0-9]+\.mjs$/.test(f)) {
    // katex chunk: matched by filename prefix, never hardcode the hash.
    alias[path.join(CHUNK_DIR, f)] = STUB_KATEX;
  }
}

const trimPlugin = {
  name: 'trim',
  setup(build) {
    build.onResolve({ filter: /\.mjs$/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      return alias[resolved] ? { path: alias[resolved] } : null;
    });
  },
};

console.log(
  `Trimming ${Object.keys(alias).length} of ${files.length} mermaid chunks; keep-list: ${[...KEEP].join(', ')}`
);

await esbuild.build({
  entryPoints: [path.join(HERE, 'entry.mjs')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'mermaid',
  legalComments: 'none',
  outfile: OUTFILE,
  plugins: [trimPlugin],
  logLevel: 'silent',
});

const buf = fs.readFileSync(OUTFILE);
const gzipLen = zlib.gzipSync(buf).length;
console.log(`raw:   ${buf.length} bytes`);
console.log(`gzip:  ${gzipLen} bytes (limit ${GZIP_LIMIT})`);

if (gzipLen > GZIP_LIMIT) {
  console.error(
    `FAIL: bundle gzips to ${gzipLen} bytes, over the ${GZIP_LIMIT} limit. A dependency change likely pulled trimmed chunks back in — check the stub patterns in build.mjs.`
  );
  process.exit(1);
}
