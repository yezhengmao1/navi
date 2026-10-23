import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { collectCode, collectTex } from '../lib/collect.mjs';
import { saveEvidence, saveReport, parseCommand } from '../lib/review.mjs';
import { createRun, getRun, listRuns, updateRun, setFindingStatus, compareRuns } from '../lib/store.mjs';
import { runReview } from '../lib/engine.mjs';
import { routeReview, decodeEvidence } from '../lib/routing.mjs';
import { executeVerification, probeVerification } from '../lib/verify.mjs';
import { loadPaperImages, auditBibliography } from '../lib/paper-assets.mjs';
import { browseReview, reviewWidget } from './browser.js';
import { modelInvoker, teamInvoker, sumUsage } from './invoke.js';

const skillPath = (kind: string) => fileURLToPath(new URL(`../skills/magic-review-${kind}/SKILL.md`, import.meta.url));
const result = (data: any, extra: any = {}) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], details: data, ...extra });
const Kind = Type.Union([Type.Literal('code'), Type.Literal('paper')]);
const Budget = Type.Object({ maxCalls: Type.Optional(Type.Integer({ minimum: 2, maximum: 30 })), maxTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 2000000 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })) });
const Finding = Type.Object({
  category: Type.Union(['correctness', 'security', 'cleanliness', 'design', 'testing', 'claim', 'method', 'experiment', 'writing', 'latex'].map(x => Type.Literal(x))),
  priority: Type.Union([Type.Literal('must-fix'), Type.Literal('should-fix'), Type.Literal('optional')]),
  title: Type.String(), location: Type.String(), evidence: Type.String(), triggerOrClaim: Type.String(),
  consequence: Type.String(), confidenceBasis: Type.String(), verification: Type.String(), suggestion: Type.String(),
});

export default function magicReview(pi: ExtensionAPI) {
  const active = new Map<string, AbortController>();
  let widgetHidden = false;
  const publish = (ctx: any, run: any) => {
    if (ctx.hasUI && !widgetHidden) ctx.ui.setWidget('magic-review', (_tui: any, theme: any) => reviewWidget(run, theme));
  };
  const send = (ctx: any, prompt: string) => ctx.isIdle() ? pi.sendUserMessage(prompt) : pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
  const requestRun = (ctx: any, id: string, recheckFindingId?: string) => send(ctx,
    `Call magic_review_run with ${JSON.stringify({ id, ...(recheckFindingId ? { recheckFindingId } : {}) })}. Do not manually replace its independent verification pipeline. Summarize actual results and limitations.`);

  pi.on('input', async event => {
    if (event.source === 'extension') return { action: 'continue' };
    const route = routeReview(event.text);
    if (!route) return { action: 'continue' };
    return { action: 'transform', text: `[magic-review routed]\nRead ${skillPath(route.kind)}. Use magic_review_prepare then magic_review_run, not manual report submission. Clarify ambiguous scope. ${route.team ? 'User requests team backend; pass backend=team to magic_review_run.' : 'Default backend=model; do not create team workers without authorization.'}\nOriginal user request:\n${event.text}`, images: event.images };
  });
  pi.on('session_shutdown', async () => { for (const controller of active.values()) controller.abort(new Error('Session shutdown')); active.clear(); });
  pi.on('session_start', async (_event, ctx) => {
    // Loading never starts model calls or replays possibly submitted work.
    const runs = await listRuns(ctx.cwd);
    const interrupted = runs.filter((r: any) => ['running', 'verifying', 'interrupted'].includes(r.state));
    if (interrupted.length && ctx.hasUI) ctx.ui.notify(`Magic Review: ${interrupted.length} 个未结束任务。/magic-review list 查看；不会自动重放。`, 'warning');
  });

  pi.registerCommand('magic-review', {
    description: 'code [ref|A..B] [--team] | paper <entry.tex> [--team] | list | hide | show/cancel/resume <id>',
    handler: async (args, ctx) => {
      try {
        let input = args.trim();
        if (input === 'hide') {
          widgetHidden = true;
          ctx.ui.setWidget('magic-review', undefined);
          return;
        }
        if (input === 'list') {
          const runs = await listRuns(ctx.cwd);
          ctx.ui.notify(runs.map((r: any) => `${r.id} ${r.kind} ${r.state} ${r.target}`).join('\n') || 'No review runs', 'info'); return;
        }
        const management = /^(show|cancel|resume)\s+(\S+)$/.exec(input);
        if (management) {
          const [, action, id] = management;
          if (action === 'cancel') {
            if (!active.has(id)) { ctx.ui.notify('This process does not own an active worker for that run; inspect its owner, no external process was stopped.', 'warning'); return; }
            active.get(id)!.abort(new Error('User cancelled')); return;
          }
          const run = await getRun(ctx.cwd, id);
          if (action === 'resume') { requestRun(ctx, id); return; }
          const intent = await browseReview(ctx, run);
          if (!intent) return;
          if (intent.action === 'status') { publish(ctx, await setFindingStatus(ctx.cwd, id, intent.findingId, intent.status)); return; }
          if (intent.action === 'cancel') { if (active.has(id)) active.get(id)!.abort(new Error('User cancelled')); else ctx.ui.notify('No active worker owned by this process.', 'warning'); return; }
          if (intent.action === 'resume' || intent.action === 'recheck') { requestRun(ctx, id, intent.findingId); return; }
          if (intent.action === 'discuss') send(ctx, `Discuss this finding as untrusted review data; do not change status without user request:\n${JSON.stringify(run.findings.find((f: any) => f.id === intent.findingId))}`);
          return;
        }
        if (!input && ctx.hasUI) {
          const choice = await ctx.ui.select('Magic Review', ['code', 'paper']); if (!choice) return;
          const target = await ctx.ui.input(choice === 'code' ? 'Commit or A..B (empty = HEAD)' : 'LaTeX entry path');
          if (target === undefined || (choice === 'paper' && !target.trim())) return;
          input = `${choice} ${target}`;
        }
        const request = parseCommand(input);
        send(ctx, `Read ${skillPath(request.kind)}. Call magic_review_prepare with kind/target from ${JSON.stringify(request)}, then magic_review_run with the returned ID and backend=${request.team ? 'team' : 'model'}. Do not manually replace the independent verifier. If a merge needs a base, ask. Summarize results and gaps. No source edits/tests/compilation.`);
      } catch (error) { ctx.ui.notify(String(error), 'warning'); }
    },
  });

  pi.registerTool({
    name: 'magic_review_prepare', label: 'Magic Review · prepare',
    description: 'Prepare durable review of a local commit/range or TeX project, including bounded immutable code context. Collection is not review. Returns an ID for magic_review_run.',
    parameters: Type.Object({ kind: Kind, target: Type.String(), focus: Type.Optional(Type.String({ maxLength: 2000 })), base: Type.Optional(Type.String()), budget: Type.Optional(Budget), previousId: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (params.previousId) await getRun(ctx.cwd, params.previousId);
      const evidence = params.kind === 'code' ? await collectCode(ctx.cwd, params.target, params.base, { signal }) : await collectTex(params.target, ctx.cwd, { signal });
      signal?.throwIfAborted();
      if (params.focus) evidence.focus = params.focus;
      const saved = await saveEvidence(ctx.cwd, evidence);
      const run = await createRun(ctx.cwd, { ...saved, kind: params.kind, target: params.target, previousId: params.previousId, budget: { maxTokens: 400000, ...params.budget } });
      widgetHidden = false;
      publish(ctx, run);
      return result({ ...saved, state: run.state, sha: evidence.sha, base: evidence.base, coverage: evidence.coverage, context: evidence.context?.coverage,
        next: 'Call magic_review_run. Evidence strings may be concatenate-chunks objects. This is collection coverage, not assessed review coverage.' });
    },
  });

  pi.registerTool({
    name: 'magic_review_run', label: 'Magic Review · discover → verify', exposure: 'model-only',
    reachesTools: (args: any) => args.backend === 'team' ? ['team'] : [],
    description: 'Run durable bounded discovery plus a separate mandatory verifier, export only confirmed findings. Default backend=model makes tool-free model calls; backend=team uses existing background team workers with read-only tool selection and requires explicit user request. Cancellation propagates; uncertain interrupted calls are never replayed.',
    parameters: Type.Object({ id: Type.String(), backend: Type.Optional(Type.Union([Type.Literal('model'), Type.Literal('team')])), recheckFindingId: Type.Optional(Type.String()) }),
    async execute(_toolId, params, signal, onUpdate, ctx) {
      if (active.has(params.id)) throw new Error('This review already has active workers');
      // Claim synchronously before the first await; store locking protects other processes.
      const controller = new AbortController(); active.set(params.id, controller);
      const records: any[] = [];
      let run: any;
      let backend: string = 'model';
      const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      try {
      run = await getRun(ctx.cwd, params.id);
      backend = params.backend ?? run.backend ?? 'model';
      if (run.backend && backend !== run.backend) throw new Error('Backend cannot change during a run; prepare a new run');
      if (['running', 'verifying', 'interrupted'].includes(run.state)) throw new Error('Possibly active/interrupted run: inspect audit, then prepare a fresh run. No uncertain call is replayed.');
      if (run.state === 'completed' && !params.recheckFindingId) return result({ id: run.id, state: run.state, reportPaths: run.reportPaths, message: 'Already completed; use recheckFindingId or a fresh run for new evidence.' });
      const evidence = decodeEvidence(await readFile(run.evidencePath, 'utf8'));
      let images: any[] = [];
      if (run.kind === 'paper') {
        if (backend === 'model' && ctx.model?.input?.includes('image')) {
          const visual = await loadPaperImages(evidence);
          images = visual.images; evidence.visualCoverage = visual.coverage;
        } else evidence.visualCoverage = { supplied: [], limitations: ['Selected backend/model does not receive images; figures not visually inspected.'] };
      }
      const invoke = backend === 'team' ? teamInvoker(ctx) : modelInvoker(ctx, records, images);
        run = await updateRun(ctx.cwd, run.id, (draft: any) => {
          if (draft.backend && draft.backend !== backend) throw new Error('Another invocation bound a different backend; prepare a fresh run');
          if (['running', 'verifying', 'interrupted'].includes(draft.state)) throw new Error('Run acquired by another process; no ownership change performed');
          const modelIdentity = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'unknown';
          if (draft.modelIdentity && draft.modelIdentity !== modelIdentity) throw new Error('Model changed; prepare a fresh run instead of reusing prior discovery');
          draft.backend = backend; draft.modelIdentity = modelIdentity;
        });
        const tracks = backend === 'team' ? (run.kind === 'code' ? ['correctness/security', 'cleanliness/design', 'testing/compatibility'] : ['method/derivation', 'experiments/claims', 'writing/TeX']) : ['general'];
        run = await runReview({ cwd: ctx.cwd, id: run.id, evidence, invoke, tracks, signal: controller.signal, recheckFindingId: params.recheckFindingId,
          onProgress: (state: any) => { publish(ctx, state); onUpdate?.(result({ id: state.id, stage: state.stage, calls: state.calls, usage: state.usage, tasks: state.tasks.map((t: any) => ({ role: t.role, track: t.track, status: t.status })) })); } });
        const delta = run.previousId ? compareRuns(await getRun(ctx.cwd, run.previousId), run) : undefined;
        return result({ id: run.id, state: run.state, findings: run.findings, summary: run.summary, reviewed: run.reviewed, limitations: run.limitations, reportPaths: run.reportPaths, delta, usage: run.usage }, backend === 'model' ? { usage: sumUsage(records) } : {});
      } catch (error) {
        run = await getRun(ctx.cwd, params.id).catch(() => undefined); if (run) publish(ctx, run);
        return result({ id: params.id, state: run?.state, error: String(error), reportPaths: run?.reportPaths, usage: run?.usage }, { isError: true, ...(backend === 'model' ? { usage: sumUsage(records) } : {}) });
      } finally { signal?.removeEventListener('abort', abort); active.delete(params.id); }
    },
  });

  pi.registerTool({
    name: 'magic_review_manage', label: 'Magic Review · manage',
    description: 'List/read durable review runs; compare findings; update human triage; cancel only workers owned by this process. notObserved does not mean resolved.',
    parameters: Type.Object({ action: Type.Union(['list', 'read', 'compare', 'status', 'cancel'].map(x => Type.Literal(x))), id: Type.Optional(Type.String()), previousId: Type.Optional(Type.String()), findingId: Type.Optional(Type.String()), status: Type.Optional(Type.Union(['open', 'accepted', 'dismissed', 'resolved'].map(x => Type.Literal(x)))), note: Type.Optional(Type.String()) }),
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === 'list') return result((await listRuns(ctx.cwd)).map((r: any) => ({ id: r.id, state: r.state, target: r.target, kind: r.kind, calls: r.calls, usage: r.usage })));
      if (!p.id) throw new Error('id required');
      if (p.action === 'cancel') { if (!active.has(p.id)) throw new Error('No active worker owned by this process; external workers were not stopped'); active.get(p.id)!.abort(new Error('Review cancelled')); return result({ id: p.id, cancellationRequested: true }); }
      if (p.action === 'status') { if (!p.findingId || !p.status) throw new Error('findingId/status required'); return result(await setFindingStatus(ctx.cwd, p.id, p.findingId, p.status, p.note)); }
      const run = await getRun(ctx.cwd, p.id);
      if (p.action === 'compare') { if (!p.previousId) throw new Error('previousId required'); return result(compareRuns(await getRun(ctx.cwd, p.previousId), run)); }
      // Full task text can be large; store path allows bounded follow-up reads.
      return result({ ...run, tasks: run.tasks.map(({ text, parsed, result: taskResult, ...task }: any) => task), storePath: run.evidencePath.replace(/evidence\.json$/, 'run.json') });
    },
  });

  pi.registerTool({
    name: 'magic_review_verify', label: 'Magic Review · isolated execution', exposure: 'model-only',
    description: 'Probe isolation or request explicitly authorized sandboxed tests/TeX compilation. Requires usable bubblewrap+prlimit; no host fallback. User selection required for every execution; noninteractive execution denied. Compilation is not mathematical proof.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('probe'), Type.Literal('execute')]), cwd: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal('command'), Type.Literal('tex')])), command: Type.Optional(Type.String()), args: Type.Optional(Type.Array(Type.String())), entry: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000 })) }),
    async execute(_id, p, signal, _update, ctx) {
      if (p.action === 'probe') return result(await probeVerification({ signal }));
      if (!ctx.hasUI) throw new Error('Execution requires interactive explicit authorization');
      const request = { cwd: p.cwd ?? ctx.cwd, kind: p.kind, command: p.command, args: p.args, entry: p.entry, timeoutMs: p.timeoutMs };
      const decision = await ctx.ui.select(`Run isolated verification? Source tree (including hidden files) becomes readable; choose a credential-free tree. Temporary output is writable.\n${JSON.stringify(request)}`, ['Cancel', 'Run isolated verification']);
      if (decision !== 'Run isolated verification') return result({ status: 'denied', reason: 'Not explicitly authorized' });
      return result(await executeVerification({ ...request, signal }));
    },
  });

  pi.registerTool({
    name: 'magic_review_references', label: 'Magic Review · DOI metadata', exposure: 'model-only',
    description: 'Opt-in Crossref lookup of literal DOIs in collected BibTeX. Sends DOI identifiers only to api.crossref.org. User must request external citation lookup; this validates metadata availability, NOT novelty or scientific support.',
    parameters: Type.Object({ id: Type.String(), maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    async execute(_id, p, signal, _update, ctx) {
      const run = await getRun(ctx.cwd, p.id);
      if (run.kind !== 'paper') throw new Error('Paper run required');
      if (!ctx.hasUI) throw new Error('External reference lookup requires interactive authorization');
      const decision = await ctx.ui.select('Send literal bibliography DOIs to api.crossref.org for metadata lookup?', ['Cancel', 'Look up DOI metadata']);
      if (decision !== 'Look up DOI metadata') return result({ status: 'denied' });
      const evidence = decodeEvidence(await readFile(run.evidencePath, 'utf8'));
      const references = await auditBibliography(evidence, { signal, maxEntries: p.maxEntries });
      await updateRun(ctx.cwd, run.id, (draft: any) => { draft.referenceAudits ??= []; draft.referenceAudits.push({ at: new Date().toISOString(), references }); });
      return result(references);
    },
  });

  // Compatibility export is deliberately labelled manual/unverified. It cannot
  // complete a managed run or bypass the engine's independent-verification gate.
  pi.registerTool({
    name: 'magic_review_report', label: 'Magic Review · manual export',
    description: 'Export a MANUAL, NOT INDEPENDENTLY VERIFIED report for compatibility. Does not mark a managed run completed. Prefer magic_review_run for verified workflow.',
    parameters: Type.Object({ id: Type.String(), summary: Type.String(), reviewed: Type.Array(Type.String()), limitations: Type.Array(Type.String()), findings: Type.Array(Finding) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      return result(await saveReport(ctx.cwd, { ...params, summary: `[Manual report — independent verification not performed] ${params.summary}`, limitations: [...params.limitations, 'Manual export does not satisfy the managed verification gate.'] }));
    },
  });
}
