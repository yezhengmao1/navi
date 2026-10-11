import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "siflow";
const MODEL = "stage2_iter_0001180";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || ctx.model.id !== MODEL) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

		return {
			...event.payload,
			temperature: 1,
			top_p: 0.95,
			top_k: -1,
		};
	});
}
