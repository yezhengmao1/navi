export type UsageRecord = { key: string; count: number };

type Contribution = {
	order: number;
	count: number;
	references: number;
	previous?: Contribution;
	next?: Contribution;
};
type FileUsage = { order: number; keys: Map<string, Contribution> };

/** Incremental equivalent of iterating files in insertion order and taking the
 * first occurrence of each key. Duplicated branches count once, even if their
 * counts disagree. Per-key linked lists preserve file precedence on replacement.
 * Only suffix records may be removed incrementally; arbitrary rewrites replace
 * the whole file. Counts must already be normalized to finite nonnegative values.
 */
export class UsageLedger {
	private files = new Map<string, FileUsage>();
	private heads = new Map<string, Contribution>();
	private nextOrder = 0;
	private amount = 0;
	get total() { return this.amount; }

	private ensureFile(path: string): FileUsage {
		let file = this.files.get(path);
		if (!file) {
			file = { order: this.nextOrder++, keys: new Map() };
			this.files.set(path, file);
		}
		return file;
	}
	private remove(key: string, contribution: Contribution) {
		if (contribution.previous) contribution.previous.next = contribution.next;
		else {
			this.amount -= contribution.count;
			if (contribution.next) {
				this.heads.set(key, contribution.next);
				this.amount += contribution.next.count;
			} else this.heads.delete(key);
		}
		if (contribution.next) contribution.next.previous = contribution.previous;
	}
	private add(file: FileUsage, { key, count }: UsageRecord) {
		const existing = file.keys.get(key);
		if (existing) { existing.references++; return; }
		const contribution: Contribution = { order: file.order, count, references: 1 };
		file.keys.set(key, contribution);
		const head = this.heads.get(key);
		if (!head || file.order < head.order) {
			contribution.next = head;
			if (head) head.previous = contribution;
			this.heads.set(key, contribution);
			this.amount += count - (head?.count ?? 0);
			return;
		}
		let previous = head;
		while (previous.next && previous.next.order < file.order) previous = previous.next;
		contribution.previous = previous;
		contribution.next = previous.next;
		if (previous.next) previous.next.previous = contribution;
		previous.next = contribution;
	}

	/** Commit appended records, retracting an optional provisional EOF record first. */
	append(path: string, records: UsageRecord[], previousTail?: UsageRecord) {
		const file = this.ensureFile(path);
		if (previousTail) {
			const contribution = file.keys.get(previousTail.key);
			if (contribution && --contribution.references === 0) {
				this.remove(previousTail.key, contribution);
				file.keys.delete(previousTail.key);
			}
		}
		for (const record of records) this.add(file, record);
	}
	/** Preserve file insertion order when it is truncated/replaced/rewritten. */
	replace(path: string, records: UsageRecord[]) {
		const file = this.ensureFile(path);
		for (const [key, contribution] of file.keys) this.remove(key, contribution);
		file.keys.clear();
		for (const record of records) this.add(file, record);
	}
	delete(path: string) {
		const file = this.files.get(path);
		if (!file) return;
		for (const [key, contribution] of file.keys) this.remove(key, contribution);
		this.files.delete(path);
	}
	clear() {
		this.files.clear(); this.heads.clear(); this.nextOrder = 0; this.amount = 0;
	}
}
