import { randomUUID } from 'node:crypto';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();

export function sessionLabels(sessions, currentPath) {
  return sessions.map((s, i) => `${i + 1}. ${s.path === currentPath ? '[当前] ' : ''}${clean(s.name || s.firstMessage || '(空会话)').slice(0, 100)} · ${clean(s.cwd)} · ${s.id.slice(0, 8)}`);
}

export function splitDirection(layout, paneId) {
  const rect = layout?.panes?.find(p => p.pane_id === paneId)?.rect;
  // Terminal cells are approximately twice as tall as they are wide.
  return rect && rect.width >= 160 && rect.width >= rect.height * 2 ? 'right' : 'down';
}

export async function forkWorkflow({ ctx, args, env, list, run, select, confirm = (title, body) => ctx.ui.confirm(title, body), uuid = randomUUID }) {
  if (ctx.mode !== 'tui' || env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID) {
    ctx.ui.notify('/split 只能在 herdr 内的 Pi 交互终端使用。', 'error');
    return;
  }
  if (args.trim()) {
    ctx.ui.notify('用法：/split（方向键选择当前项目会话，Enter 复制到新分屏）', 'warning');
    return;
  }
  let paneId;
  try {
    const sessions = (await list()).sort((a, b) => +b.modified - +a.modified);
    if (!sessions.length) {
      ctx.ui.notify('当前项目没有已保存的会话。', 'info');
      return;
    }
    const labels = sessionLabels(sessions, ctx.sessionManager.getSessionFile());
    const choice = select ? await select(labels) : await ctx.ui.select('选择一个会话（Esc 取消）', labels);
    if (choice === undefined) return;
    const source = sessions[labels.indexOf(choice)];
    if (!source) return;
    const cwd = source.cwd || ctx.cwd;
    // Selecting a session from another project explicitly confirms its working directory.
    if (cwd !== ctx.cwd && !await confirm('在其他项目中创建分屏？', cwd)) return;
    const layout = await run(['pane', 'layout', '--pane', env.HERDR_PANE_ID]);
    const split = await run(['pane', 'split', '--pane', env.HERDR_PANE_ID,
      '--direction', splitDirection(layout.layout, env.HERDR_PANE_ID), '--cwd', cwd, '--no-focus']);
    paneId = split.pane?.pane_id;
    if (typeof paneId !== 'string' || !paneId) throw new Error('herdr 未返回新窗格 ID；请检查布局，不要盲目重试。');
    const name = `pi-fork-${uuid().replaceAll('-', '').slice(0, 12)}`;
    await run(['agent', 'start', name, '--kind', 'pi', '--pane', paneId,
      '--timeout', '30000', '--', '--fork', source.path]);
    ctx.ui.notify(`已在 ${paneId} 创建 ${name}；原会话和当前焦点不变。`, 'info');
  } catch (error) {
    // A startup timeout can mean the child is alive or waiting for approval.
    // Never retry or close the pane automatically.
    ctx.ui.notify(`Fork 未确认完成：${error.message ?? error}${paneId ? `\n已创建窗格 ${paneId}，请先检查该窗格；不会自动关闭或重试。` : ''}`, 'error');
  }
}

export function decodeResponse(result) {
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || 'herdr 执行失败').slice(0, 2000));
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw new Error('herdr 返回了无效 JSON；请检查窗格状态后再操作。'); }
  if (response.error) throw new Error(JSON.stringify(response.error));
  if (!response.result) throw new Error('herdr 响应缺少 result');
  return response.result;
}
