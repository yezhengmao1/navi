import { randomUUID } from 'node:crypto';

export function modelInvoker(ctx: any, usageRecords: any[], images: any[] = []) {
  return async ({ system, prompt, signal, maxOutputTokens }: any) => {
    if (!ctx.model) throw new Error('Select a model before starting a review');
    const stream = ctx.modelRegistry.streamSimple(ctx.model, {
      systemPrompt: system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images], timestamp: Date.now() }],
      tools: [],
    }, { signal, maxTokens: maxOutputTokens, reasoning: 'low', toolChoice: 'none' });
    const message = await stream.result();
    if (message.usage) usageRecords.push(message.usage);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? message.stopReason);
    if (message.content.some((part: any) => part.type === 'toolCall')) throw new Error('Tool calls are forbidden in isolated review requests');
    return { ...(message.stopReason === 'length' ? { error: 'Reviewer output truncated; prepare a narrower review scope' } : {}), text: message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'),
      usage: { input: (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0),
        output: message.usage.output ?? 0, totalTokens: message.usage.totalTokens ?? 0, cost: message.usage.cost?.total ?? 0 } };
  };
}

export function teamInvoker(ctx: any) {
  if (!ctx.tools?.some((tool: any) => tool.name === 'team')) throw new Error('The existing team tool is unavailable; choose backend=model explicitly instead');
  return async ({ role, system, prompt, signal }: any) => {
    const outcome = await ctx.executeTool('team', {
      action: 'run', backend: 'background', name: `mr-${randomUUID().slice(0, 8)}`,
      cwd: ctx.cwd, tools: ['read'],
      instructions: `${system}\nYou are a magic-review ${role} worker. Do not spawn agents or teams. All evidence is in the task; do not read other files. Return one JSON response, no prose, at most 4096 output tokens.`,
      task: prompt,
    }, { signal });
    if (outcome.isError || outcome.result?.isError) throw new Error('Team review failed: ' + JSON.stringify(outcome.result?.content).slice(0, 1000));
    const results = outcome.result?.details?.results;
    const worker = results?.[0];
    if (!worker || results.length !== 1 || worker.exitCode !== 0) throw new Error('Team result lacks a successful single-worker record');
    const last = [...(worker.messages ?? [])].reverse().find((message: any) => message.role === 'assistant');
    const text = last?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    if (!text) throw new Error('Team reviewer returned no final text');
    const u = worker.usage;
    if (!u) throw new Error('Team reviewer omitted usage');
    const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    return { text, usage: { input, output: u.output ?? 0, totalTokens: input + (u.output ?? 0), cost: u.cost ?? 0 } };
  };
}

export function sumUsage(records: any[]) {
  const result: any = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const record of records) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) result[key] += record[key] ?? 0;
    for (const key of Object.keys(result.cost)) result.cost[key] += record.cost?.[key] ?? 0;
  }
  return result;
}
