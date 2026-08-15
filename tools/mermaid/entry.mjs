// Entry for the trimmed ClWhiter mermaid bundle.
//
// Deep import through the package `./*` export (proven on mermaid 11.15.0).
// The explicit globalThis assignment guarantees `window.mermaid` is the real
// mermaid API object when the bundle is loaded as a classic <script> —
// Chirpy's post.min.js guards on `typeof mermaid === 'undefined'` and calls
// mermaid.initialize()/run(). Parenthesized expression statement so
// minifiers keep the side effect. Do NOT pair this with esbuild
// `globalName` (see build.mjs).
import mermaid from 'mermaid/dist/mermaid.esm.mjs';

(globalThis.mermaid = mermaid);
