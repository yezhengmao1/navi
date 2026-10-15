/** Coalesce event bursts; ordinary renders never discover the whole transcript. */
export function renderRefresh(discover: () => void, requestRender: () => void, delay = 50) {
	let dirty = false;
	let discoverAfterEvents = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		if (!dirty) return;
		dirty = false;
		discover();
	};
	const request = (structureChanged = false) => {
		dirty ||= structureChanged;
		discoverAfterEvents ||= structureChanged;
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			// A layout may flush before native event handlers attach new nodes.
			// Retain one post-event discovery even if that early flush ran.
			dirty ||= discoverAfterEvents;
			discoverAfterEvents = false;
			flush();
			requestRender();
		}, delay);
		timer.unref();
	};
	return {
		request,
		flush,
		reset() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			dirty = false;
			discoverAfterEvents = false;
		},
	};
}
