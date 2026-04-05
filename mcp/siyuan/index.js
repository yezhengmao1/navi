import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const configPath = join(homedir(), ".navi", "config.toml");
const config = parseToml(readFileSync(configPath, "utf-8"));
const API_BASE = config.siyuan?.url || "http://127.0.0.1:6806";
const API_TOKEN = config.siyuan?.token || "";

async function api(endpoint, body = {}) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || `API error code ${json.code}`);
  return json.data;
}

const server = new McpServer({
  name: "siyuan",
  version: "1.0.0",
});

// --- Notebook ---

server.tool("list_notebooks", "列出所有笔记本", {}, async () => {
  const data = await api("/api/notebook/lsNotebooks");
  const list = data.notebooks.map((n) => `- ${n.name} (${n.id})${n.closed ? " [closed]" : ""}`);
  return { content: [{ type: "text", text: list.join("\n") }] };
});

// --- Document ---

server.tool(
  "create_doc",
  "在指定笔记本中创建文档（markdown）",
  {
    notebook: z.string().describe("笔记本 ID"),
    path: z.string().describe("文档路径，如 /wiki/主题名"),
    markdown: z.string().describe("文档内容（markdown）"),
  },
  async ({ notebook, path, markdown }) => {
    const data = await api("/api/filetree/createDocWithMd", { notebook, path, markdown });
    return { content: [{ type: "text", text: `文档已创建，ID: ${data}` }] };
  }
);

server.tool(
  "get_doc",
  "获取文档内容（返回 markdown）",
  {
    id: z.string().describe("文档块 ID"),
  },
  async ({ id }) => {
    const data = await api("/api/export/exportMdContent", { id });
    return { content: [{ type: "text", text: data.content }] };
  }
);

server.tool(
  "rename_doc",
  "重命名文档",
  {
    notebook: z.string().describe("笔记本 ID"),
    path: z.string().describe("文档路径"),
    title: z.string().describe("新标题"),
  },
  async ({ notebook, path, title }) => {
    await api("/api/filetree/renameDoc", { notebook, path, title });
    return { content: [{ type: "text", text: "已重命名" }] };
  }
);

server.tool(
  "remove_doc",
  "删除文档",
  {
    notebook: z.string().describe("笔记本 ID"),
    path: z.string().describe("文档路径"),
  },
  async ({ notebook, path }) => {
    await api("/api/filetree/removeDoc", { notebook, path });
    return { content: [{ type: "text", text: "已删除" }] };
  }
);

// --- Block ---

server.tool(
  "insert_block",
  "在指定块后插入新块",
  {
    previousID: z.string().describe("前一个块的 ID"),
    dataType: z.enum(["markdown", "dom"]).default("markdown"),
    data: z.string().describe("块内容"),
  },
  async ({ previousID, dataType, data }) => {
    const result = await api("/api/block/insertBlock", { previousID, dataType, data });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "append_block",
  "在文档或块末尾追加子块",
  {
    parentID: z.string().describe("父块 ID（通常是文档 ID）"),
    dataType: z.enum(["markdown", "dom"]).default("markdown"),
    data: z.string().describe("块内容"),
  },
  async ({ parentID, dataType, data }) => {
    const result = await api("/api/block/appendBlock", { parentID, dataType, data });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "update_block",
  "更新指定块的内容",
  {
    id: z.string().describe("块 ID"),
    dataType: z.enum(["markdown", "dom"]).default("markdown"),
    data: z.string().describe("新内容"),
  },
  async ({ id, dataType, data }) => {
    const result = await api("/api/block/updateBlock", { id, dataType, data });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "delete_block",
  "删除指定块",
  {
    id: z.string().describe("块 ID"),
  },
  async ({ id }) => {
    const result = await api("/api/block/deleteBlock", { id });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_block_kramdown",
  "获取块的 kramdown 源码",
  {
    id: z.string().describe("块 ID"),
  },
  async ({ id }) => {
    const data = await api("/api/block/getBlockKramdown", { id });
    return { content: [{ type: "text", text: data.kramdown }] };
  }
);

// --- Search & Query ---

server.tool(
  "sql_query",
  "执行 SQL 查询思源数据库（blocks 表）",
  {
    stmt: z.string().describe("SQL 语句，如 SELECT * FROM blocks WHERE content LIKE '%关键词%' LIMIT 10"),
  },
  async ({ stmt }) => {
    const data = await api("/api/query/sql", { stmt });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "search",
  "全文搜索文档",
  {
    query: z.string().describe("搜索关键词"),
  },
  async ({ query }) => {
    const data = await api("/api/search/fullTextSearchBlock", { query });
    const blocks = data.blocks || [];
    if (blocks.length === 0) return { content: [{ type: "text", text: "无结果" }] };
    const lines = blocks.slice(0, 20).map(
      (b) => `- [${b.content?.slice(0, 80)}](siyuan://blocks/${b.id}) (${b.hpath})`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// --- File tree ---

server.tool(
  "list_doc_tree",
  "列出笔记本的文档树",
  {
    notebook: z.string().describe("笔记本 ID"),
    path: z.string().default("/").describe("起始路径，默认根目录"),
  },
  async ({ notebook, path }) => {
    const data = await api("/api/filetree/listDocsByPath", { notebook, path });
    const files = (data.files || []).map((f) => `- ${f.name} (${f.id})`);
    return { content: [{ type: "text", text: files.join("\n") || "空目录" }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
