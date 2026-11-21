import { StringDecoder } from "node:string_decoder";

export const OUTPUT_LIMIT = 12000;
export const STDERR_LIMIT = 16000;
// A single JSON event may contain a large tool result. Fail explicitly rather than
// retaining an unbounded unterminated line or silently losing the final answer.
export const JSON_LINE_LIMIT = 4 * 1024 * 1024;

export function boundedText(text: string, limit = OUTPUT_LIMIT): string {
 return text.length > limit ? text.slice(0, limit) + "\n[Output truncated]" : text;
}

export function appendTail(previous: string, chunk: string, limit = STDERR_LIMIT): string {
 return (previous + chunk).slice(-limit);
}

/** Streaming UTF-8 decoding with a bounded pending line (limits count UTF-16 units). */
export class BoundedLines {
 private decoder = new StringDecoder("utf8");
 private pending = "";
 private failed = false;
 constructor(private line: (text: string) => void, private overflow: () => void,
  private limit = JSON_LINE_LIMIT) {}
 push(chunk: Buffer) { if (!this.failed) this.consume(this.decoder.write(chunk)); }
 end() {
  if (this.failed) return;
  this.consume(this.decoder.end());
  if (this.pending) this.line(this.pending);
  this.pending = "";
 }
 private consume(text: string) {
  let start = 0;
  while (start < text.length) {
   const newline = text.indexOf("\n", start);
   const end = newline === -1 ? text.length : newline;
   if (this.pending.length + end - start > this.limit) {
    this.pending = ""; this.failed = true; this.overflow(); return;
   }
   this.pending += text.slice(start, end);
   if (newline === -1) return;
   this.line(this.pending);
   this.pending = "";
   start = newline + 1;
  }
 }
}

/** Retain text only, never tool arguments/results, thinking, or image payloads. */
export function finalAssistantText(message: {content: Array<{type: string; text?: string}>}): string {
 const text = message.content.find(part => part.type === "text")?.text ?? "";
 return boundedText(text);
}
