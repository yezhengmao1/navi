import { createHash } from "node:crypto";
import { ConfabExportError } from "./confab-errors.js";
import { cloudCredentialField, cloudCredentialValues, redactCredentialCopies, visitPemBody, visitSecretSpans } from "./confab-redaction.js";

/** Convert local branch content to Claude-compatible blocks; never pass through opaque binary/signatures. */
export function exportContent(branch: readonly any[], redact: (text: string) => string, token: string) {
  const leaves: { raw: string; set: (value: string) => void }[] = [];
  let payloadNodes = 0;
  const secretKey = /password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
  const scrub = (value: string) => redact(token ? value.split(token).join("[REDACTED CREDENTIAL]") : value);
  const string = (value: string, set: (value: string) => void) => {
    leaves.push({ raw: value, set }); set(scrub(value));
  };
  // Use tagged leaf wrappers so cross-block redaction can update all selected payloads before serialization.
  const boxes = new WeakSet<object>();
  const sanitize = (value: any, depth = 0): any => {
    if (depth > 128) throw new ConfabExportError("depth_limit");
    if (++payloadNodes > 1_000_000) throw new ConfabExportError("node_limit");
    if (typeof value === "string") { const box = { value: "" }; boxes.add(box); string(value, v => box.value = v); return box; }
    if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => {
      const safeKey = scrub(key);
      return [safeKey, (secretKey.test(key) || cloudCredentialField.test(key)) ? "[REDACTED FIELD]" : /base64|signature|image|attachment/i.test(key) || (key === "data" && (value.type === "image" || value.mimeType)) ? "[OMITTED BINARY]" : sanitize(val, depth + 1)];
    }));
    return typeof value === "number" || typeof value === "boolean" || value === null ? value : null;
  };
  const unwrap = (value: any): any => {
    if (value && typeof value === "object" && boxes.has(value)) return value.value;
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
    return value;
  };
  const textBlock = (value: string) => ({ type: "text", text: sanitize(value) });
  const id = (value: unknown) => {
    if (typeof value !== "string" || !value) throw new ConfabExportError("missing_tool_id");
    return "tool-" + createHash("sha256").update(value).digest("hex").slice(0, 32);
  };
  const content = (value: any): any[] => {
    if (typeof value === "string") return value ? [textBlock(value)] : [];
    if (!Array.isArray(value)) return [];
    return value.map(b => {
      if (b?.type === "text") return textBlock(String(b.text ?? ""));
      if (b?.type === "thinking") return { type: "thinking", thinking: sanitize(String(b.thinking ?? "")) };
      if (b?.type === "toolCall") {
        const block = { type: "tool_use", id: id(b.id), name: "redacted_tool", input: null as any };
        const raw = typeof b.name === "string" ? b.name : "";
        // Keep names in the redaction scan, but never serialize a prose marker as a tool identifier.
        string(raw, v => { block.name = v === raw && v.length > 0 && !/[^a-zA-Z0-9_.-]/.test(v) ? v : "redacted_tool"; });
        block.input = sanitize(b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments) ? b.arguments : { value: b.arguments ?? null });
        return block;
      }
      return textBlock("[图片、附件或未知内容块：原始载荷未上传，无法可靠脱敏]");
    });
  };
  const selected: { entry: any; role: string; blocks: any[]; toolUseResult?: any }[] = [];
  for (const entry of branch) {
    let role = "user", blocks: any[] = [];
    let toolUseResult: any;
    if (entry.type === "message") {
      const m = entry.message;
      if (!m) continue;
      blocks = content(m.content);
      if (m.role === "toolResult") {
        // Native Claude metadata belongs beside message, never in its visible content blocks.
        if (m.details !== undefined) toolUseResult = sanitize(
          typeof m.details === "string" || m.details && typeof m.details === "object" ? m.details : { value: m.details });
        blocks = [{ type: "tool_result", tool_use_id: id(m.toolCallId), is_error: m.isError === true, content: blocks }];
      } else if (m.role === "assistant") role = "assistant";
      else if (m.role !== "user") blocks.unshift(textBlock("[其他消息角色]"));
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (typeof entry.summary === "string") blocks = [textBlock("[压缩/分支摘要]\n" + entry.summary)];
    } else if (entry.type === "custom_message") {
      blocks = [textBlock("[扩展消息]"), ...content(entry.content)];
    }
    if (!blocks.length) continue;
    if (selected.length >= 20_000) throw new ConfabExportError("message_limit");
    selected.push({ entry, role, blocks, ...(toolUseResult !== undefined ? { toolUseResult } : {}) });
  }
  // Locate cross-block matches in the ORIGINAL text. A difference between global
  // and per-leaf scrubbing must not erase unrelated conversation history.
  const starts: number[] = [];
  let position = 0;
  for (const leaf of leaves) { starts.push(position); position += leaf.raw.length + 1; }
  const joined = leaves.map(x => x.raw).join("\n");
  // An environment assignment may be echoed later as an unlabeled CLI argument.
  // Gather before scrubbing so copies in other messages are protected as well.
  const cloudValues = cloudCredentialValues(joined);
  const leafAt = (offset: number) => {
    let low = 0, high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid + 1; else high = mid;
    }
    return low - 1;
  };
  // PEM payload lines never cross the synthetic newline between leaves. Mask
  // only their slices; the delimiter or END may live in a different message.
  const pem = new Map<number, { parts: string[]; offset: number }>();
  visitPemBody(joined, (start, end) => {
    const i = leafAt(start);
    const edit = pem.get(i) ?? { parts: [], offset: 0 };
    edit.parts.push(leaves[i].raw.slice(edit.offset, start - starts[i]), "[REDACTED PEM]");
    edit.offset = end - starts[i];
    pem.set(i, edit);
  });
  for (const [i, leaf] of leaves.entries()) {
    const edit = pem.get(i);
    if (edit || cloudValues.length) {
      const value = edit ? edit.parts.join("") + leaf.raw.slice(edit.offset) : leaf.raw;
      leaf.set(scrub(redactCredentialCopies(value, cloudValues)));
    }
  }
  visitSecretSpans(joined, (start, end) => {
    const first = leafAt(start), last = leafAt(end - 1);
    if (first < 0 || first === last) return; // Already handled by per-leaf scrub.
    for (let i = first; i <= last; i++) {
      if (starts[i] < end && starts[i] + leaves[i].raw.length > start)
        leaves[i].set("[REDACTED cross-block secret]");
    }
  });
  return selected.map(m => ({
    entry: m.entry, role: m.role, content: unwrap(m.blocks),
    ...(m.toolUseResult !== undefined ? { toolUseResult: unwrap(m.toolUseResult) } : {}),
  }));
}
