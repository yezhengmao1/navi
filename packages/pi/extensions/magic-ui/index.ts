import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerHeader from "./header.js";
import registerEditorFooter from "./editor-footer.js";
import registerCompact from "./compact.js";
import registerQuestionnaire from "./questionnaire.js";
import registerQuota from "./quota.js";
import registerBlockTiming from "./block-timing.js";
import { userAlignmentAdapter } from "./user-alignment.js";
import { messageFlowPalette, paintMessageFlow } from "./message-flow.js";

/** One discoverable extension; implementation modules never register themselves. */
export default function (pi: ExtensionAPI) {
  const timing = registerBlockTiming(pi);
  let paint = (text: string, _width: number, _row: number, _height: number) => text;
  const alignment = userAlignmentAdapter((...args) => paint(...args));
  let root: unknown;
  let flowTimer: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {
    if (flowTimer) clearInterval(flowTimer);
    flowTimer = undefined;
    alignment.dispose(); root = undefined; timing.dispose();
  };
  pi.on("session_shutdown", dispose);
  registerHeader(pi, {
    mount(tui, ctx) {
      dispose(); root = tui;
      const started = performance.now();
      paint = (text, width, row, height) => paintMessageFlow(text,
        messageFlowPalette(width, ctx.ui.theme, performance.now() - started, row, height));
      timing.mount(tui, ctx); alignment.update(tui);
      const renderer = tui as { requestRender?: () => void };
      flowTimer = setInterval(() => renderer.requestRender?.(), 200);
      flowTimer.unref();
    },
    update() { timing.update(); if (root) alignment.update(root); },
    dispose,
  });
  registerEditorFooter(pi);
  registerCompact(pi);
  registerQuestionnaire(pi);
  registerQuota(pi);
}
