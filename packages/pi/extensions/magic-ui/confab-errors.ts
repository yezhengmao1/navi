/** Only fixed local diagnostics may be shown; never expose remote bodies or arbitrary error messages. */
const messages = {
  message_limit: "会话记录超过 20,000 条，已停止导出。",
  line_limit: "单条记录的 JSON 编码大小超过插件 14 MiB 分块预算（对齐上游 CLI），无法完整上传；不是当前部署已确认的服务端限制。",
  depth_limit: "工具参数或附加信息嵌套超过 128 层，已停止导出。",
  node_limit: "工具参数及附加信息累计超过 1,000,000 个数据节点，已停止导出。",
  missing_tool_id: "工具调用或结果缺少关联 ID，无法正确导出。",
  timestamp: "记录缺少有效的消息时间和条目时间，已停止导出。",
} as const;
export class ConfabExportError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); }
}
export class ConfabHttpError extends Error {
  constructor(readonly status: number) { super("Confab request failed."); }
}
export const exportDiagnostic = (error: unknown): string | undefined => {
  if (error instanceof ConfabExportError) return messages[error.code];
  if (error instanceof ConfabHttpError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    if (error.status === 413) return "服务器或反向代理返回 HTTP 413：当前部署的请求体限制低于本次上传大小。未显示服务端正文。";
    return `服务器返回 HTTP ${error.status}；请检查账号、权限或服务状态。未显示服务端正文。`;
  }
  return undefined;
};
