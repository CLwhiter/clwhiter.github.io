// Stub for the katex chunk (mermaid math labels). This site renders math
// with MathJax, not mermaid math, so katex (~505KB raw) is trimmed.
// Matches the `const { default: katex } = await import(...)` call site.
export default {
  renderToString() {
    throw new Error(
      'katex trimmed from ClWhiter mermaid bundle — edit the keep-list in tools/mermaid/build.mjs and rebuild if you need math labels'
    );
  },
};

export const render = () => {
  throw new Error('katex trimmed from ClWhiter mermaid bundle');
};

export const renderToString = () => {
  throw new Error('katex trimmed from ClWhiter mermaid bundle');
};
