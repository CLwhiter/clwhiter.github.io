// Stub for trimmed diagram types (classDiagram, gantt, pie, state, er,
// gitGraph, mindmap, kanban, timeline, architecture, sankey, xychart, ...).
//
// Shape matches what the mermaid diagram registry consumes. `detector`
// returning false means a trimmed diagram type is treated as unknown and
// fails with a clean parse error instead of crashing the page.
export const diagram = {
  id: 'stub',
  startOnLoad: false,
  detector: () => false,
  db: {},
  renderer: {},
  styles: [],
  init: () => {},
};
