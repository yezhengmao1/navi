import { isAbsolute } from 'node:path';

export type Slot = 1 | 2 | 3 | 4;
/** Append-only allocation history. Never remove slots when members close.
 * Persist pending/uncertain pages verbatim; only explicit reconciliation may clear them.
 */
export interface Page {
  workspace: string;
  label: string;
  tab?: string;
  panes: string[];
  state: 'ready' | 'pending' | 'uncertain' | 'retired';
  intent?: { operation: 'create' | 'split'; slot: Slot; cwd: string; target?: string; direction?: 'right' | 'down' };
}
export interface AllocateTeamPaneOptions {
  pages: Page[];
  label: string;
  workspace: string;
  cwd: string;
  /** Return the unwrapped CLI result object. */
  run(args: string[]): Promise<any>;
  /** Durably persist the supplied snapshot before resolving. */
  save(pages: Page[]): void | Promise<void>;
  /** Cancellation/ownership guard; must throw if this caller is no longer valid. */
  check(): void;
}
const validID = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
function id(value: unknown, kind: string): string {
  if (!validID(value)) throw new Error(`Invalid or missing ${kind} ID; inspect Herdr before retrying`);
  return value;
}

function verifyLayout(page: Page, layout: any) {
  if (layout?.tab_id !== page.tab || layout?.workspace_id !== page.workspace || !Array.isArray(layout.panes) ||
      layout.panes.length !== page.panes.length || layout.zoomed)
    throw new Error('Team tab topology changed; inspect before splitting');
  const rects = page.panes.map(id => layout.panes.find((p: any) => p.pane_id === id)?.rect);
  if (new Set(layout.panes.map((p: any) => p.pane_id)).size !== page.panes.length || rects.some(r =>
      !r || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) || r.width <= 0 || r.height <= 0))
    throw new Error('Team pane membership/geometry changed; inspect before splitting');
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const [left, right, bottom] = rects;
  if (right && (!near(left.y, right.y) || !near(left.x + left.width, right.x) || !near(left.width, right.width) ||
      (rects.length === 2 && !near(left.height, right.height))))
    throw new Error('Team left/right layout changed; inspect before splitting');
  if (bottom && (!near(bottom.x, left.x) || !near(bottom.y, left.y + left.height) || !near(bottom.width, left.width) ||
      !near(bottom.height, left.height) || !near(right.height, left.height + bottom.height)))
    throw new Error('Team quadrant layout changed; inspect before splitting');
}

/** Caller must serialize topology operations, including persistence.
 * Slots are TL, TR, BL, BR (1-based). Only roots created here may be split.
 * A pending intent after reload is ambiguous, not a command to replay.
 */
export async function allocateTeamPane(options: AllocateTeamPaneOptions): Promise<{ pane: string; tab: string; slot: Slot }> {
  const { pages, label, workspace, cwd, run, save, check } = options;
  check();
  id(workspace, 'workspace');
  if (!isAbsolute(cwd) || cwd.includes('\0')) throw new Error('cwd must be an absolute path');
  if (!label.trim() || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Invalid team label');
  const scoped = pages.filter(page => page.workspace === workspace);
  if (scoped.some(page => page.state === 'pending' || page.state === 'uncertain'))
    throw new Error('Team layout pending or uncertain; inspect and reconcile before allocating again');
  // Validate persisted anchors before issuing any command. No fallback to the lead pane.
  for (const page of scoped) {
    id(page.tab, 'tab');
    if (page.intent || page.panes.length < 1 || page.panes.length > 4 || new Set(page.panes).size !== page.panes.length)
      throw new Error('Invalid persisted team page; inspect before allocating');
    page.panes.forEach(pane => id(pane, 'pane'));
  }
  let page = scoped.find(page => page.state === 'ready' && page.panes.length < 4);
  const slot = (page ? page.panes.length + 1 : 1) as Slot;
  let args: string[];
  if (!page) {
    page = { workspace, label: `${label}-${scoped.length + 1}`, panes: [], state: 'pending',
      intent: { operation: 'create', slot, cwd } };
    pages.push(page);
    args = ['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', page.label, '--no-focus'];
  } else {
    const target = id(page.panes[slot === 4 ? 1 : 0], 'anchor pane');
    const direction = slot === 2 ? 'right' : 'down';
    page.state = 'pending';
    page.intent = { operation: 'split', slot, cwd, target, direction };
    args = ['pane', 'split', '--pane', target, '--direction', direction, '--ratio', '0.5', '--cwd', cwd, '--no-focus'];
  }
  // Failure to persist means no CLI call. Keep the in-memory intent as a safety barrier.
  await save(structuredClone(pages));
  try {
    check();
    if (slot > 1) {
      const live = await run(['pane', 'layout', '--pane', page.intent!.target!]);
      check(); verifyLayout(page, live?.layout);
    }
    const result = await run(args);
    check();
    const pane = id(slot === 1 ? result?.root_pane?.pane_id : result?.pane?.pane_id, 'pane');
    const tab = slot === 1 ? id(result?.tab?.tab_id, 'tab') : id(page.tab, 'tab');
    if (pages.some(p => p.panes.includes(pane)) || (slot === 1 && pages.some(p => p !== page && p.tab === tab)))
      throw new Error('Herdr returned an already allocated ID; inspect before retrying');
    page.tab = tab;
    page.panes.push(pane);
    // Keep the intent until the successful allocation has been durably recorded.
    const intent = page.intent;
    page.state = 'ready';
    delete page.intent;
    try { await save(structuredClone(pages)); }
    catch (error) { page.intent = intent; throw error; }
    return { pane, tab, slot };
  } catch (error) {
    page.state = 'uncertain';
    try { await save(structuredClone(pages)); }
    catch { /* The previously persisted pending intent still prevents replay. */ }
    throw error;
  }
}
