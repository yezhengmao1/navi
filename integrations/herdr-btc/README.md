# Herdr Bitcoin Price & Clock

Python 3.11+，Linux/macOS，Herdr 0.8.2+；仅 Python 标准库，无 API key。
顶部右侧显示价格、`▁▂▄▅▇█` 涨跌图、`😱 5` 和时钟（示例）。
字符图从左到右表示最近 30 个完整分钟，每 5 分钟取一个收盘价，总共 6 格。
使用 `▁▂▃▄▅▆▇█` 按这 6 个价格的最低／最高值缩放；横盘显示 `▄▄▄▄▄▄`，缺失点显示 `·`。
恐慌／贪婪指数来自 [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/)，范围 0–100，每 15 分钟拉取一次每日指数。状态栏仅显示 emoji 和数值：
😱 极度恐慌、😨 恐慌、😐 中性、🤑 贪婪、🤯 极度贪婪；`😐 --` 表示暂不可用。
价格为 Coinbase BTC/USD，百分比为相对过去 24 小时开盘价的变化。

## 本地安装

在此目录执行：

```sh
herdr plugin link .
python3 configure.py
```

也可以在 Herdr 插件动作中运行 “Enable BTC price and clock in tab bar”。
配置脚本备份现有 `~/.config/herdr/config.toml`、保留其他设置并热重载。
已经有自定义 `ui.tab_bar_right` 时停止，避免覆盖：请手动合并以下条目。

```toml
[ui]
tab_bar_right = [
  { type = "command", command = "python3 /absolute/path/to/btc_status.py", interval_seconds = 60, timeout_seconds = 10 },
  { type = "datetime", format = "%H:%M" },
]
tab_bar_right_separator = " "
```

`datetime` 使用 Herdr **服务端本地时区**，本机目前为 UTC。
可改为 `%m-%d %H:%M` 显示日期；修改后执行 `herdr server reload-config`。

## 刷新和缓存

Herdr 在后台每 60 秒执行价格命令，不随 UI 重绘请求 API。
缓存位于 `${XDG_CACHE_HOME:-~/.cache}/herdr-btc-status/`，文件锁避免并发刷新，
写入通过原子替换完成。三个接口并行请求，各自超时为 5 秒，失败也缓存 60 秒，避免密集重试。
价格和字符图每 60 秒刷新，指数独立缓存；某个接口失败不影响其他数据。
断网时保留旧报价并显示 `[stale Nm]`；无缓存时对应字段显示 `unavailable`。字符图只展示当前 30 分钟窗口，过期点会移除。
指数抓取超过 30 分钟或源数据超过两天也标记 stale。
时钟独立更新。手动刷新：`python3 btc_status.py --refresh`。

## GitHub 安装

将本目录内容放在你自己的公开 GitHub 仓库根目录后，可运行：

```sh
herdr plugin install OWNER/REPO
```

安装后运行插件的 Configure 动作开启顶部显示。此目录尚未发布到 GitHub，
`OWNER/REPO` 是占位符。仓库添加 `herdr-plugin` topic 可进入社区索引。
如果安装更新改变了 checkout 路径，重新运行 Configure 动作以更新绝对路径。

## 卸载

删除配置中 `# BEGIN herdr-btc-status` 到 `# END herdr-btc-status` 的块，
执行 `herdr server reload-config` 和 `herdr plugin unlink navi.btc-status`。
缓存可以自行删除。

## 验证

```sh
python3 -m unittest discover -s . -p 'test_*.py'
```

接口依据：[Herdr 配置](https://herdr.dev/docs/configuration/)、
[插件](https://herdr.dev/docs/plugins/)、
[Coinbase 分钟行情](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)、
[Coinbase 产品统计](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-stats)。
