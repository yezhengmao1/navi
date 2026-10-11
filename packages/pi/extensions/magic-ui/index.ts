import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerHeader from "./header.js";
import registerEditorFooter from "./editor-footer.js";
import registerCompact from "./compact.js";
import registerQuestionnaire from "./questionnaire.js";
import registerQuota from "./quota.js";

/** One discoverable extension; implementation modules never register themselves. */
export default function (pi: ExtensionAPI) {
  registerHeader(pi);
  registerEditorFooter(pi);
  registerCompact(pi);
  registerQuestionnaire(pi);
  registerQuota(pi);
}
