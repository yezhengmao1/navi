// Model Herdr's documented layout response without controlling real panes.
export function layoutFor(page) {
  if (!page) throw new Error('Unknown fake page');
  const n = page.panes.length;
  return { layout: { tab_id: page.tab, workspace_id: page.workspace, zoomed: false,
    panes: page.panes.map((pane_id, i) => ({ pane_id, rect: {
      x: i === 1 || i === 3 ? 100 : 0, y: i >= 2 ? 30 : 0,
      width: n === 1 ? 200 : 100,
      height: n === 1 || n === 2 || (n === 3 && i === 1) ? 60 : 30,
    } })),
  } };
}
