import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";

export interface ScheduleSpec {
 agent: string; task: string; intervalSeconds: number; maxRuns: number; timeoutSeconds: number;
 report?: "always" | "on_change";
}
type Job = ScheduleSpec & {
 id: string; runs: number; state: string; nextRunAt?: number; lastResult?: string;
 timer?: ReturnType<typeof setTimeout>; controller?: AbortController; reportedHash?: string;
};

/** Session-local, completion-based scheduling: no overlapping runs or catch-up bursts. */
export class Scheduler {
 private jobs = new Map<string, Job>();
 private queue: Job[] = [];
 private active = 0;
 constructor(private run: (job: ScheduleSpec & {id: string}, signal: AbortSignal) => Promise<string>,
  private report: (id: string, text: string) => void,
  private concurrency = 2,
  private release: (id: string) => void = () => {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
 }
 list() { return [...this.jobs.values()].map(({timer, controller, reportedHash, ...job}) => ({...job})); }
 add(spec: ScheduleSpec) {
  for (const key of ["intervalSeconds", "maxRuns", "timeoutSeconds"] as const)
   if (!Number.isInteger(spec[key]) || spec[key] < 1 || spec[key] > (key === "maxRuns" ? 1000 : 86400))
    throw new Error(`Invalid ${key}`);
  if (spec.report !== undefined && spec.report !== "always" && spec.report !== "on_change") throw new Error("Invalid report policy");
  if (this.jobs.size >= 20) throw new Error("Schedule limit reached (20); cancel old jobs first.");
  const job: Job = {...spec, id: randomUUID(), runs: 0, state: "waiting"};
  this.jobs.set(job.id, job);
  this.arm(job);
  return job.id;
 }
 private arm(job: Job) {
  job.state = "waiting";
  job.nextRunAt = Date.now() + job.intervalSeconds * 1000;
  job.timer = setTimeout(() => {
   job.timer = undefined; job.nextRunAt = undefined;
   if (!this.jobs.has(job.id)) return;
   job.state = "queued";
   this.queue.push(job);
   this.drain();
  }, job.intervalSeconds * 1000);
 }
 private drain() {
  while (this.active < this.concurrency && this.queue.length) {
   const job = this.queue.shift()!;
   if (!this.jobs.has(job.id)) continue;
   this.active++;
   void this.tick(job).finally(() => { this.active--; this.drain(); });
  }
 }
 private async tick(job: Job) {
  job.state = "running"; job.runs++;
  const controller = job.controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), job.timeoutSeconds * 1000);
  let text: string;
  try {
   text = await this.run(job, controller.signal);
   if (controller.signal.aborted) text = "Failed: execution timed out.";
  } catch (error) { text = controller.signal.aborted ? "Failed: execution timed out." : `Failed: ${String(error)}`; }
  finally { clearTimeout(timeout); job.controller = undefined; }
  // Cancel/reload/session switch invalidates both scheduling and late delivery.
  if (!this.jobs.has(job.id)) return;
  job.lastResult = text.length > 12000 ? text.slice(0, 12000) + "\n[Output truncated]" : text;
  const hash = createHash("sha256").update(text).digest("hex");
  if (job.report !== "on_change" || hash !== job.reportedHash) {
   try { this.report(job.id, job.lastResult); job.reportedHash = hash; } catch { /* retry delivery next run */ }
  }
  if (!this.jobs.has(job.id)) return;
  if (job.runs >= job.maxRuns) { job.state = "completed"; this.release(job.id); }
  else this.arm(job);
 }
 cancel(id: string) {
  const job = this.jobs.get(id);
  if (!job) return false;
  this.jobs.delete(id);
  clearTimeout(job.timer);
  this.queue = this.queue.filter(queued => queued !== job);
  job.controller?.abort();
  this.release(id);
  return true;
 }
 clear() { for (const id of this.jobs.keys()) this.cancel(id); }
}

export type DispatchContext = Pick<ExtensionContext, "cwd" | "model" | "thinkingLevel">;

export function registerScheduler(pi: ExtensionAPI,
 run: (agent: AgentConfig, task: string, ctx: DispatchContext, signal: AbortSignal) => Promise<string>) {
 const bindings = new Map<string, { agent: AgentConfig; ctx: DispatchContext }>();
 const scheduler = new Scheduler(async (job, signal) => {
  const binding = bindings.get(job.id);
  if (!binding) throw new Error("Schedule context unavailable");
  return run(binding.agent, job.task, binding.ctx, signal);
 }, (id, text) => {
  pi.sendMessage({customType: "subagent-schedule", content: `Scheduled subagent ${id}\n\n${text}`, display: true},
   {triggerTurn: false});
 }, 2, id => { bindings.delete(id); });
 let generation = 0;
 const clear = () => { generation++; scheduler.clear(); bindings.clear(); };
 pi.on("session_start", clear);
 pi.on("session_switch", clear);
 pi.on("session_shutdown", clear);
 const cancel = (id: string) => { bindings.delete(id); return scheduler.cancel(id); };
 pi.registerTool({
  name: "subagent_schedule", label: "Subagent schedule",
  description: "Create/list/cancel recurring isolated subagent tasks when the user requests periodic checks. Session-local: stops on exit/reload/session switch. First run after interval; subsequent runs wait interval after completion. No overlap; at most two scheduled runs execute concurrently, others queue FIFO. Results displayed without waking the parent model. Pass full context in task. Defaults: 20 runs, 120s per-run timeout. Each run costs model tokens. Creation only in interactive TUI; not a durable cron service.",
  parameters: Type.Object({
   action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")]),
   id: Type.Optional(Type.String({description: "Schedule ID, or all to cancel all"})),
   agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()),
   agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
   intervalSeconds: Type.Optional(Type.Integer({minimum: 1, maximum: 86400})),
   maxRuns: Type.Optional(Type.Integer({minimum: 1, maximum: 1000})),
   timeoutSeconds: Type.Optional(Type.Integer({minimum: 1, maximum: 86400})),
   report: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("on_change")], {
    description: "Default always. on_change suppresses identical returned text (not semantic anomaly detection); each run still costs tokens.",
   })),
  }),
  async execute(_id, params, signal, _update, ctx) {
   const result = (text: string) => ({content: [{type: "text" as const, text}], details: undefined});
   if (params.action === "list") return result(JSON.stringify(scheduler.list(), null, 2));
   if (params.action === "cancel") {
    if (params.id === "all") { clear(); return result("All schedules cancelled."); }
    return result(cancel(params.id ?? "") ? "Schedule cancelled." : "Schedule not found.");
   }
   if (ctx.mode !== "tui") throw new Error("Schedules require a live interactive Pi session.");
   if (!params.agent || !params.task?.trim() || !params.intervalSeconds) throw new Error("agent, task and intervalSeconds required.");
   const createdIn = generation;
   const agents = discoverAgents(ctx.cwd, params.agentScope ?? "user").agents;
   const agent = agents.find(a => a.name === params.agent);
   if (!agent) throw new Error(`Unknown agent. Available: ${agents.map(a => a.name).join(", ")}`);
   if (agent.source === "project" && !ctx.isProjectTrusted()) {
    if (!ctx.hasUI || !await ctx.ui.confirm("Schedule project-local agent?", `${agent.name}: runs with your machine permissions. Trust this agent for repeated execution?`))
     throw new Error("Project agent not approved.");
   }
   if (signal?.aborted || createdIn !== generation) throw new Error("Cancelled or session changed");
   const id = scheduler.add({agent: agent.name, task: params.task, intervalSeconds: params.intervalSeconds,
    maxRuns: params.maxRuns ?? 20, timeoutSeconds: params.timeoutSeconds ?? 120, report: params.report ?? "always"});
   bindings.set(id, {agent: {...agent}, ctx: {cwd: ctx.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel}});
   return result(JSON.stringify(scheduler.list().find(j => j.id === id)));
  },
 });
 pi.registerCommand("schedules", {
  description: "List scheduled subagents; /schedules stop <id|all>",
  handler: async (args, ctx) => {
   const [action, id] = args.trim().split(/\s+/);
   if (action === "stop" && id === "all") clear();
   else if (action === "stop" && id) cancel(id);
   else if (action) { ctx.ui.notify("Usage: /schedules [stop <id|all>]", "warning"); return; }
   ctx.ui.notify(JSON.stringify(scheduler.list(), null, 2), "info");
  },
 });
}
