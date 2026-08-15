// Entry for the trimmed ClWhiter mermaid bundle.
//
// Deep import through the package `./*` export (proven on mermaid 11.15.0).
// The explicit globalThis assignment guarantees `window.mermaid` exists when
// the bundle is loaded as a classic <script> — Chirpy's post.min.js requires
// it (guards on `typeof mermaid === 'undefined'`). Parenthesized expression
// statement so minifiers keep the side effect.
import mermaid from 'mermaid/dist/mermaid.esm.mjs';

(globalThis.mermaid = mermaid);

export default mermaid;
