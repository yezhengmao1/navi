---
name: hiboard
description: 把任务结果推送到华为/荣耀手机「负一屏」（HiBoard 服务动态）。任务完成后想在手机上看到结果时用。
user-invocable: true
allowed-tools: Bash, Read, Write
---

# 负一屏推送（HiBoard）

把 markdown 内容推送到手机负一屏，一条 HTTPS 请求搞定。

**触发**：
- `/hiboard 「内容」` —— 把参数里的内容**原样当正文推送**，不要自行总结会话或改写。
- 用户说「推送到负一屏」「发到手机」「把这个结果推过去」等。

## 前置配置

`~/.navi/config.toml` 加 `[hiboard]` 段：

```toml
[hiboard]
auth_code = "负一屏授权码"   # 必填
# push_url = "https://..."   # 可选，默认华为云负一屏端点
```

`auth_code` 从 `~/.navi/config.toml` 的 `[hiboard]` 段读取。若配置里没有，脚本会报错，
此时引导用户把授权码写进 config.toml。**不要让用户把授权码贴进对话**。

## 用法

推送**优先用 JSON 文件**（markdown 里的换行/标题/表格能 100% 保留，避免命令行转义问题）：

```bash
# 1. 把正文写进 JSON
cat > /tmp/task.json <<'EOF'
{
  "task_name": "每日简报",
  "task_result": "任务已完成",
  "task_content": "# 每日简报\n\n## 要点\n- ...\n"
}
EOF

# 2. 推送
python3 .claude/skills/hiboard/push.py --data /tmp/task.json

# 先看 payload 不实际发送
python3 .claude/skills/hiboard/push.py --data /tmp/task.json --dry-run
```

也可不建文件、直接从别处拿正文：

```bash
python3 .claude/skills/hiboard/push.py --name "简报" --content report.md
echo "# 正文" | python3 .claude/skills/hiboard/push.py --name "简报" --content -
```

## JSON 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `task_name` | 是 | 任务名，如「每日简报」 |
| `task_content` | 是 | markdown 正文（负一屏正文区显示） |
| `task_result` | 否 | 结果描述，默认「任务已完成」 |
| `summary` | 否 | 摘要，默认据 name+result 生成 |
| `task_id` / `schedule_task_id` | 否 | 任务 ID；周期任务想合并成一条时保持一致 |
| `auth_code` | 否 | 临时覆盖配置里的授权码 |

## 编排要求

1. **正文取自用户给的内容，不要自行总结或改写**——
   - `/hiboard 「内容」`：把参数里的「内容」原样作为 `task_content` 推送。
   - 若用户没给具体内容（只说「推送」），才回头问推什么，或按上下文明确要求的结果推。
   - `task_name` 可从内容首行/主题提取，缺省用「通知」。
2. 把内容写进 JSON 的 `task_content`，调 `push.py --data`，读脚本输出判断成功/失败。
3. 成功回「✅ 推送成功」；失败把脚本给的错误码提示原样转达用户（如授权码无效、负一屏开关未开）。

## 原理

一次 POST 到负一屏端点 `.../claw/msg/upload`。**契约以实测为准**（与市场上
today-task 文档略有出入）：整体包一层 `data`，请求头必带 `x-trace-id`，每条
`msgContent` 需自带 `msgId`——否则分别报 `x-trace-id is empty` / `msgId cannot be blank`。

```
POST .../claw/msg/upload
Content-Type: application/json; charset=utf-8
x-trace-id: <随机 hex>            # 必填
```
```json
{ "data": { "authCode": "...", "msgContent": [{
    "msgId": "<随机 hex>", "scheduleTaskId": "...", "scheduleTaskName": "...",
    "summary": "...", "result": "...", "content": "markdown 正文",
    "source": "OpenClaw", "taskFinishTime": 1775183319 }] } }
```

成功响应 `{"code":"0000000000","desc":"OK"}`。时间戳用秒级 UTC（`int(time.time())`）。
