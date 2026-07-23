---
name: feishu
description: 把任务结果 / 通知推送到飞书群自定义机器人（webhook）。想在飞书群里收到结果时用。
---

# 飞书群机器人推送

把 markdown 内容推送到飞书群自定义机器人，一条 HTTPS 请求搞定。

**触发**：
- `/feishu 「内容」` —— 把参数里的内容**原样当正文推送**，不要自行总结会话或改写。
- 用户说「推送到飞书」「发到飞书群」「用飞书机器人通知」等。

## KEY 与配置

webhook 形如 `https://open.feishu.cn/open-apis/bot/v2/hook/<KEY>`，`<KEY>` 是每个机器人独有的一段。

**KEY 优先级**：`--key` 参数 > JSON 里的 `key` > 配置 `[feishu].key`。

参数直接给最省事；想固定一个默认机器人，就在 `~/.navi/config.toml` 加 `[feishu]` 段：

```toml
[feishu]
key = "webhook 末段（hook/ 之后那串，如 1b64311b-...）"   # 可选，--key 未传时用
# base_url = "https://open.feishu.cn/open-apis/bot/v2/hook/"  # 可选，默认飞书官方
```

`--key` 既可传纯末段，也可整条 webhook URL，脚本会自动归一。**不要让用户把 KEY 贴进对话历史**——引导写进 config 或用参数。

## 用法

纯文本（不带标题）：

```bash
python3 .agents/skills/feishu/push.py --key <KEY> --content report.md
echo "# 正文" | python3 .agents/skills/feishu/push.py --key <KEY> --content -
```

带标题 → 自动升级为 interactive 卡片（正文按 lark_md 渲染 markdown：加粗、列表、链接等）：

```bash
python3 .agents/skills/feishu/push.py --key <KEY> --title "每日简报" --content report.md
```

复杂 markdown **优先用 JSON 文件**（换行/标题保留最稳）：

```bash
cat > /tmp/task.json <<'EOF'
{ "title": "每日简报", "content": "**要点**\n- ...\n" }
EOF
python3 .agents/skills/feishu/push.py --key <KEY> --data /tmp/task.json
python3 .agents/skills/feishu/push.py --key <KEY> --data /tmp/task.json --dry-run  # 只看 payload
```

KEY 已写进配置时，`--key` 可省略。

## JSON 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `content` | 是 | markdown 正文 |
| `title` | 否 | 给了则以蓝色标题卡片推送；不给为纯文本 |
| `template` | 否 | 卡片标题栏配色（blue/green/red/grey…），默认 blue |
| `key` | 否 | 覆盖配置里的 webhook KEY |

## 编排要求

1. **正文取自用户给的内容，不要自行总结或改写**——`/feishu 「内容」` 把参数原样作为 `content`。
   用户只说「推送」而没给内容时，才回头问推什么。
2. 复杂 markdown 写进 JSON 的 `content` 调 `--data`；简单一行用 `--content`。
3. 读脚本输出判断成功/失败：成功回「✅ 推送成功」；失败把错误码提示原样转达
   （常见：签名校验/自定义关键词未命中/KEY 错误）。

## 原理

一次 POST 到 `https://open.feishu.cn/open-apis/bot/v2/hook/<KEY>`：

- 无标题：`{"msg_type":"text","content":{"text":"..."}}`
- 有标题：`{"msg_type":"interactive","card":{...}}`，正文元素用 `lark_md` 渲染 markdown。

成功响应 `{"code":0,"msg":"success"}`。若机器人在飞书侧开了「签名校验」，本 skill 不支持
签名（code 19021），请改用「自定义关键词」或 IP 白名单；开了自定义关键词时正文需含关键词（19024）。
