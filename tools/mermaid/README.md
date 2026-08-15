# Mermaid 裁剪构建工具

本目录维护站点使用的裁剪版 mermaid bundle（`assets/mermaid/mermaid.min.js`）。

## 为什么要裁剪

完整版 `mermaid.min.js` gzip 后约 916KB，是 clwhiter.github.io 上体积最大的资源。
慢速网络下加载失败时，读者看到的不是图，而是 mermaid 源码。裁剪后 gzip 约 445KB（-51%），
失败概率大幅降低。

## 保留了什么

只保留站点实际使用的两种图（keep-list 见 `build.mjs`）：

- `flowDiagram` — flowchart / graph
- `sequenceDiagram` — 时序图

其余类型（classDiagram、gantt、pie、state、er、gitGraph、mindmap、kanban、timeline、
architecture、sankey、xychart、katex 数学标签等）全部替换为 stub：

- 被裁剪的图类型会以干净的解析错误失败，不会崩页面；
- katex stub 抛出的错误信息里写明了恢复方法（见下）。

**新增图类型**：在 `build.mjs` 的 `KEEP` 列表中加入对应 chunk 的 base 名（如 `classDiagram`
对应 `classDiagram-v3-XXXX.mjs` 的 base 名），重新构建即可。chunk 名可在
`node_modules/mermaid/dist/chunks/mermaid.esm/` 下查到。

## 一条命令重建

```bash
cd tools/mermaid && npm install && npm run build && npm run verify
```

- `npm run build` — 产出 `assets/mermaid/mermaid.min.js`，gzip 超过 550KB 直接失败（防止未来版本悄悄膨胀）；
- `npm run verify` — 在真实 Chromium（puppeteer）里用**已提交的** bundle 解析 `_posts/` 中全部 mermaid 代码块，
  并验证 Chirpy 需要的 API 面（`initialize` / `run` / `init` / `parse` / `render` / `mermaidAPI`）。

## 关于 CI

**预构建文件已提交到仓库**，CI（GitHub Actions）不需要 Node —— bundle 作为普通静态文件
由 Jekyll 原样拷贝发布。只有本地重建时才需要 Node 环境。

## 版本

`package.json` 精确锁版（无 `^` 范围）：`mermaid@11.15.0`（与部署线上的渲染引擎一致）、
`esbuild@0.28.2`、`puppeteer@25.7.0`。升级 mermaid 版本会改变图的渲染输出，请先跑
`npm run verify` 确认所有文章的图仍可解析。
