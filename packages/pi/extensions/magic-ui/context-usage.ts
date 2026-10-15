import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Usage = ReturnType<ExtensionContext["getContextUsage"]>;

/** Read after lifecycle handlers persist their changes, never inside render(). */
export function contextUsageCache(requestRender: () => void) {
	let value: Usage;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let latest: Pick<ExtensionContext, "getContextUsage">;
	return {
		get: () => value,
		invalidate(ctx: Pick<ExtensionContext, "getContextUsage">) {
			if (disposed) return;
			latest = ctx;
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				let next: Usage;
				try { next = latest.getContextUsage(); } catch { next = undefined; }
				if (next?.tokens === value?.tokens && next?.percent === value?.percent
					&& next?.contextWindow === value?.contextWindow) return;
				value = next;
				requestRender();
			}, 0);
			timer.unref();
		},
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
