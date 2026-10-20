/** FIFO per resource, independent across members. Urgent operations cancel active/queued work
 * for only that resource, then run once its operation has unwound. No process is killed here. */
export class ControlQueue {
  private tails = new Map<string, Promise<unknown>>();
  private jobs = new Map<string, Set<AbortController>>();
  busy(key: string) { return (this.jobs.get(key)?.size ?? 0) > 0; }
  interrupt(key: string) { for (const job of this.jobs.get(key) ?? []) job.abort(); }
  clear() { for (const key of this.jobs.keys()) this.interrupt(key); }
  async run<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, urgent = false): Promise<T> {
    if (urgent) this.interrupt(key);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const jobs = this.jobs.get(key) ?? new Set<AbortController>();
    jobs.add(controller); this.jobs.set(key, jobs);
    const prior = this.tails.get(key) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => {
      if (combined.aborted) throw new Error('Team operation cancelled');
      return fn(combined);
    });
    this.tails.set(key, task);
    try { return await task; }
    finally {
      jobs.delete(controller);
      if (!jobs.size && this.jobs.get(key) === jobs) this.jobs.delete(key);
      if (this.tails.get(key) === task) this.tails.delete(key);
    }
  }
}
