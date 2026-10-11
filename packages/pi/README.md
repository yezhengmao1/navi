# Navi Pi 扩展包

原独立 Pi 扩展项目的通用扩展已纳入此目录。这里是**可选 Pi package 源码**，不是项目自动加载目录；Navi 专属的 `subagent`、`brief-select` 仍位于仓库根 `.pi/extensions/`。

## 目录

```text
packages/pi/
├── package.json             # Pi package manifest
├── extensions/              # 通用扩展，详见 extensions/README.md
├── themes/magic.json        # magic 主题
├── tests/                   # 离线 Node 测试
└── install-extensions.sh    # 兼容旧的全局复制/软链接安装
```

包含：折叠显示、启动头部、命令确认、magic 编辑器/状态栏、清空会话、停用旧接口的额度提示，以及仅对指定 siflow 模型生效的采样参数覆盖。扩展会影响界面或执行行为，请先审核源码。

## 安装（从仓库根执行）

推荐使用 Pi 原生 package 管理，无需在此目录运行 `npm install`：

```bash
# 仅当前项目
pi install --local ./packages/pi

# 或所有项目（两者择一）
pi install ./packages/pi
```

安装后在 Pi 中 `/reload`，通过 `/settings` 选择 `magic` 主题，通过 `pi config` 管理资源。

**迁移注意：** 若旧脚本已在 `~/.pi/agent/extensions/`、`~/.pi/agent/themes/` 中留下同名文件或软链接，先审核并移除旧副本，再启用 package；Pi 不会自动把旧复制文件识别为同一个包。迁移源码本身不会修改用户配置或切换当前会话的加载来源。

兼容脚本仍可从任意目录运行（与 package 安装方式二选一）：

```bash
./packages/pi/install-extensions.sh --link
```

脚本会覆盖同名全局文件，并清理列出的旧扩展；`--uninstall` 按文件名删除，**不验证归属**。使用前检查目标目录，避免删除自行修改或另行安装的同名文件。

## 验证

从仓库根执行：

```bash
node --test packages/pi/tests/*.test.mjs
bash -n packages/pi/install-extensions.sh
```

也可在本目录执行 `npm test`。测试按自身文件位置解析扩展，不依赖当前工作目录；默认查找 `~/.pi/agent/install/current-version` 对应的 Pi，可用 `PI_PACKAGE_ROOT=/path/to/@earendil-works/pi-coding-agent` 覆盖。

测试不请求模型、不轮询额度、不更改真实用户配置。它们覆盖部分 UI 和生命周期行为，不代表命令安全规则或所有终端表现已完整验证。
