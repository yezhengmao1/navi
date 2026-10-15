import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { decodeResponse, forkWorkflow } from './workflow.mjs';
import { createSessionPicker } from './picker.ts';

export default function registerHerdrFork(pi: ExtensionAPI) {
  let busy = false;
  pi.registerCommand('split', {
    description: '复制当前项目的一个会话到新分屏（需要 herdr）',
    handler: async (args, ctx) => {
      if (busy) {
        ctx.ui.notify('正在创建 fork，请稍候。', 'warning');
        return;
      }
      busy = true;
      try {
        await forkWorkflow({
          ctx, args, env: process.env,
          list: () => SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()),
          select: (labels: string[]) => ctx.ui.custom<string | undefined>((tui, theme, _kb, done) =>
            createSessionPicker(tui, theme, done, labels)),
          run: async (argv: string[]) => decodeResponse(await pi.exec('herdr', argv, { timeout: 45000 })),
        });
      } finally {
        busy = false;
      }
    },
  });
}
