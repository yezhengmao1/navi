# siyuan MCP Server

通过 MCP（Model Context Protocol）连接[思源笔记](https://b3log.org/siyuan/)，让 Claude 直接对笔记进行创建、编辑、搜索等操作。

## 能力

- 文档：创建 / 读取 / 重命名 / 删除、列出文档树、列出笔记本
- 块：插入 / 追加 / 更新 / 删除、读取 kramdown
- 检索：全文搜索、SQL 查询

## 配置

在 `.claude/settings.json` 的 `mcpServers` 中注册（仓库已内置）：

```json
{
  "mcpServers": {
    "siyuan": {
      "command": "node",
      "args": ["mcp/siyuan/index.js"]
    }
  }
}
```

思源服务地址与 API token 读 `~/.navi/config.toml` 的 `[siyuan]` 段：

```toml
[siyuan]
url   = "http://127.0.0.1:6806"
token = "your-siyuan-api-token"
```

token 在思源「设置 → 关于 → API token」获取。

## 文件结构

- `index.js` — MCP Server 实现
- `package.json` — 依赖声明

## 安装依赖

```bash
cd mcp/siyuan && npm install
```
