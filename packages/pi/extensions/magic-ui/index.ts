import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerHeader from "./header.js";
import registerEditorFooter from "./editor-footer.js";
import registerCompact from "./compact.js";
import registerQuestionnaire from "./questionnaire.js";
import registerQuota from "./quota.js";
import registerHerdrFork from "./herdr-fork/index.js";
import registerSessionMention from "./session-mention.js";
import registerBlockTiming from "./block-timing.js";
import { userAlignmentAdapter } from "./user-alignment.js";
import { staticMessageBackground, paintStaticMessage } from "./message-flow.js";
import { renderRefresh } from "./render-refresh.js";

/** One discoverable extension; implementation modules never register themselves. */
export default function (pi: ExtensionAPI) {
  const timing = registerBlockTiming(pi);
  let paint = (text: string, _width: number, _row: number, _height: number) => text;
  let labelStyle = (text: string) => text;
  let styleKey = () => "";
  const alignment = userAlignmentAdapter((...args) => paint(...args), text => labelStyle(text), () => styleKey());
  let root: any;
  const refresh = renderRefresh(() => { if (root) alignment.update(root); }, () => root?.requestRender());
  // Submitted user messages change only at lifecycle boundaries, not on token deltas.
  const discoverMessages = () => { if (root) refresh.request(true); };
  pi.on("session_start", discoverMessages);
  pi.on("session_switch", discoverMessages);
  pi.on("session_tree", discoverMessages);
  pi.on("session_compact", discoverMessages);
  pi.on("agent_start", discoverMessages);
  pi.on("agent_end", discoverMessages);
  pi.on("message_start", event => { if (event.message.role === "user") discoverMessages(); });
  pi.on("message_end", event => { if (event.message.role === "user") discoverMessages(); });
  const dispose = () => {
    refresh.reset(); alignment.dispose(); root = undefined; timing.dispose();
  };
  pi.on("session_shutdown", dispose);
  registerHeader(pi, {
    mount(tui, ctx) {
      dispose(); root = tui;
      labelStyle = text => ctx.ui.theme.fg("dim", text);
      // Submitted messages are history: no animation or transcript refresh timer.
      styleKey = () => staticMessageBackground(ctx.ui.theme) + labelStyle(" User");
      paint = text => paintStaticMessage(text, staticMessageBackground(ctx.ui.theme));
      timing.mount(tui, ctx); alignment.update(tui);
      // Resource factories may run before the transcript is attached.
      refresh.request(true);
    },
    update() { timing.update(); refresh.flush(); },
    dispose,
  });
  registerEditorFooter(pi);
  registerCompact(pi);
  registerQuestionnaire(pi);
  registerQuota(pi);
  registerHerdrFork(pi);
  registerSessionMention(pi);
}
