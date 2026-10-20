export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
type Row = { agent: string; status: TaskStatus };
const labels: Record<TaskStatus, string> = {
	queued: "[ ] 等待中", running: "[>] 运行中", completed: "[+] 已完成",
	failed: "[!] 失败", cancelled: "[x] 已取消", skipped: "[-] 已跳过",
};
const active = (row: Row) => row.status === "queued" || row.status === "running";

/** Separate from tool output; batch identity also guards late updates after session reset. */
export class SubagentStatus {
	private batches = new Map<string, Row[]>();
	private hideTimer?: ReturnType<typeof setTimeout>;

	constructor(private readonly dismissMs = 3000) {}

	reset() {
		clearTimeout(this.hideTimer);
		this.hideTimer = undefined;
		this.batches.clear();
	}

	start(id: string, agents: string[], publish: (lines: string[] | undefined) => void) {
		clearTimeout(this.hideTimer);
		if (![...this.batches.values()].some(rows => rows.some(active))) this.reset();
		const rows: Row[] = agents.map(agent => ({ agent, status: "queued" }));
		this.batches.set(id, rows);
		const render = () => {
			if (this.batches.get(id) !== rows) return;
			const all = [...this.batches.values()].flat();
			const pending = all.some(active);
			publish([
				`🤖 子任务  ${all.filter(row => !active(row)).length}/${all.length}${pending ? "" : " · 即将收起"}`,
				...all.map(row => `${labels[row.status]}  ${row.agent.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`),
			]);
			clearTimeout(this.hideTimer);
			if (!pending) {
				this.hideTimer = setTimeout(() => {
					if (this.batches.get(id) !== rows) return;
					this.reset();
					publish(undefined);
				}, this.dismissMs);
				this.hideTimer.unref?.();
			}
		};
		render();
		return {
			set(index: number, status: TaskStatus) { rows[index].status = status; render(); },
			finish(cancelled: boolean) {
				for (const row of rows) if (row.status === "queued") row.status = cancelled ? "cancelled" : "skipped";
				render();
			},
		};
	}
}
