import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { requestApproval, type ApprovalConfig, type Approval, type Decision } from './permission-broker.ts';

/** Extra relay on top of the lead's normal Pi profile. Safety-guard high requests
 * retain their explicit risk; ordinary extension confirm() calls use lead policy. */
export default function registerMemberPermissions(pi: ExtensionAPI) {
  pi.registerFlag('team-approval-config', { type: 'string', description: 'Private lead approval channel config for this member' });
  let lifetime = new AbortController();
  let toolsApplied = false;
  let restoreUI: (() => void) | undefined;
  const config = (): ApprovalConfig => {
    const path = pi.getFlag('team-approval-config');
    if (typeof path !== 'string' || !path) throw new Error('Missing lead approval configuration');
    const value: ApprovalConfig = JSON.parse(readFileSync(path, 'utf8'));
    if (!value.socket || !value.token || !value.member) throw new Error('Invalid lead approval configuration');
    return value;
  };
  async function relay(ctx: ExtensionContext, request: Omit<Approval, 'id' | 'member' | 'session'>, extraSignal?: AbortSignal): Promise<Decision> {
    const signal = AbortSignal.any([lifetime.signal, ...(ctx.signal ? [ctx.signal] : []), ...(extraSignal ? [extraSignal] : [])]);
    pi.events.emit('herdr:blocked', { active: true, label: `Lead approval: ${request.title}` });
    try {
      const session = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
      const decision = await requestApproval(config(), { ...request, session }, signal);
      return signal.aborted ? { allow: false, feedback: 'Approval cancelled' } : decision;
    } catch (error) { return { allow: false, feedback: String(error) }; }
    finally { pi.events.emit('herdr:blocked', { active: false }); }
  }
  function installUI(ctx: ExtensionContext) {
    restoreUI?.(); restoreUI = undefined;
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    const ui = ctx.ui, original = ui.confirm;
    const forwarded: typeof ui.confirm = async (title, body, options) => {
      const timeout = options?.timeout ? AbortSignal.timeout(options.timeout) : undefined;
      const signal = timeout && options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout ?? options?.signal;
      return (await relay(ctx, { source: 'extension-confirm', risk: 'medium', title, body,
        toolCallId: `confirm-${randomUUID()}`, toolName: 'extension-confirm', input: { title, body } }, signal)).allow;
    };
    ui.confirm = forwarded;
    restoreUI = () => { if (ui.confirm === forwarded) ui.confirm = original; };
  }
  function applyLeadTools(ctx: ExtensionContext) {
    if (toolsApplied) return;
    try {
      const wanted = config().activeTools;
      if (!wanted || !pi.getAllTools || !pi.setActiveTools) { toolsApplied = true; return; }
      const available = new Set(pi.getAllTools().map(tool => tool.name));
      const missing = wanted.filter(name => !available.has(name));
      pi.setActiveTools(wanted.filter(name => available.has(name)));
      toolsApplied = true;
      if (missing.length) ctx.ui.notify(`Lead tools not registered here: ${missing.join(', ')}. Check project/temporary extension and MCP configuration; approval cannot install a missing tool.`, 'warning');
    } catch (error) { ctx.ui.notify(`Lead tool profile unavailable: ${String(error)}`, 'warning'); }
  }
  pi.on('session_start', (_event, ctx) => { installUI(ctx); });
  pi.on('before_agent_start', (_event, ctx) => { installUI(ctx); applyLeadTools(ctx); });
  for (const event of ['session_switch', 'session_tree'] as const) pi.on(event, () => {
    lifetime.abort(); lifetime = new AbortController(); toolsApplied = false;
    restoreUI?.(); restoreUI = undefined;
  });
  const unsubscribe = pi.events.on('agent-team:approval', (value: unknown) => {
    const request = value as any;
    if (request?.handled || request?.source !== 'safety-guard' || typeof request.reply !== 'function') return;
    request.handled = true;
    void relay(request.ctx, { source: 'safety-guard', risk: request.risk, title: request.title, body: request.body,
      toolCallId: request.toolCallId, toolName: request.toolName, input: request.input }).then(request.reply);
  });
  pi.on('session_shutdown', () => { lifetime.abort(); restoreUI?.(); unsubscribe(); });
}
