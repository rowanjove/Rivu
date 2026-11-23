<div align="center">

<img src="assets/rivu.png" alt="Rivu 图标" width="76" height="76" />

# Rivu

**面向 Windows 的本地优先桌面 RSS 阅读器**

订阅、文章、离线资源与阅读状态默认全部保存在本机，核心阅读无需账户、不依赖云端。

[![Release](https://img.shields.io/github/v/release/rowanjove/Rivu?display_name=tag&color=2f6feb)](https://github.com/rowanjove/Rivu/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078d4)](https://github.com/rowanjove/Rivu/releases)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[English](README_EN.md) · [下载](#下载) · [核心功能](#核心功能) · [数据与隐私](#数据与隐私) · [从源码运行](#从源码运行) · [许可证](#许可证)

</div>

---

![Rivu 主界面](docs/images/rivu-timeline.png)

> *截图使用本地合成的演示订阅与文章，不含个人资料。*

<details>
<summary>查看首次启动界面截图</summary>

![Rivu 首次启动界面](docs/images/rivu-empty-library.png)

</details>

## 下载

- **[下载 Windows x64 便携版（v0.1.0）](https://github.com/rowanjove/Rivu/releases/latest/download/Rivu-0.1.0-portable-win-x64.zip)**
- **[SHA-256 校验值](https://github.com/rowanjove/Rivu/releases/latest/download/SHA256SUMS.txt)** · **[查看所有版本](https://github.com/rowanjove/Rivu/releases)**

### 使用说明

1. 解压完整 ZIP 后运行目录中的 `Rivu.exe`。这是**便携目录包**（不是单文件 EXE 或安装程序），请保留解压目录中的其他文件。
2. 当前发布包**尚未进行代码签名**，运行前建议先在 PowerShell 中核对 SHA-256 校验值：
   ```powershell
   Get-FileHash .\Rivu-0.1.0-portable-win-x64.zip -Algorithm SHA256
   ```
3. 默认数据目录为 `%APPDATA%\rivu`；如需隔离测试或使用独立目录，可在启动前设置环境变量 `RIVU_DATA_DIR`。

## 核心功能

### 多来源订阅与导入
- **主流与扩展来源**：支持 RSS、Atom、JSON Feed、可自定义字段路径映射的公开 JSON API，以及自建或公共 RSSHub 实例路由。
- **本地邮件通讯**：可直接读取本地文件夹中的 `.eml` Newsletter。
- **迁移方便**：支持 OPML 预览导入与导出，以及图片、音频和视频媒体链接展示。

### 高效阅读与信息整理
- **阅读体验**：提供三栏布局与沉浸式阅读模式；支持浅色 / 深色 / 跟随系统主题，以及字体、字号、行高、栏宽与界面密度调节。
- **全文与检索**：内置基于 Mozilla Readability 的原文全文提取，以及本地全文搜索。
- **分类与自动化**：支持分类、标签、收藏、智能文件夹和优先级规则（按订阅源、标题/正文关键词、日期或标签自动执行打标、保存、静音或屏蔽）。
- **键盘导航**：支持常用阅读快捷键，减少鼠标切换：

| 快捷键 | 动作 |
| --- | --- |
| `J` / `K` | 下一篇 / 上一篇 |
| `S` | 收藏 / 取消收藏 |
| `M` | 切换已读 / 未读 |
| `O` | 在默认浏览器中打开原文 |
| `Esc` | 退出沉浸式阅读 |

### 离线缓存与永久归档
- **离线阅读**：可将文章正文与配图保存到本机，断网环境下仍可正常阅读。
- **永久归档**：为重要文章创建带版本记录的本地归档，可选同时保存图片、音视频附件与来源网页快照，并导出为自包含的 ZIP 包（内置独立 `index.html`、`metadata.json` 与本地资源）。

### 可选且透明的 AI 辅助
- **任意 OpenAI Compatible 接口**：可接入本地模型服务（如默认指向 `http://127.0.0.1:1234/v1` 的本地推理端）或云端接口，按任务分别配置模型。
- **覆盖阅读全流程**：支持文章摘要、全文翻译（支持对照与仅译文视图）、基于引文的文章问答、关键词、主题分类、概念解释、改写草稿、标签建议与过滤审阅。
- **显式确认与可控边界**：手动请求前会展示将要发送的内容范围并由用户确认；AI 自动规则（摘要 / 关键词 / 分类）需要单独授权，并支持单批处理数量上限控制。

### 本地备份与网络设置
- **手动与自动备份**：支持一键备份与校验恢复，也支持按日或按周自动备份（默认保留最近 7 份），并在恢复阶段记录状态以便异常中断后安全恢复。
- **网络代理**：支持跟随系统环境变量、直连或自定义 HTTP / HTTPS 代理与免代理规则。

## 数据与隐私

- **无需账户，无云同步**：Rivu 不提供订阅内容的云同步，也不收集账号信息。
- **本地存储与监听边界**：数据库（SQLite）、配置和日志保存在 `%APPDATA%\rivu`；本地服务仅绑定 `127.0.0.1`。
- **AI 零默认外发**：未配置 AI 服务时不会发起任何 AI 请求。启用后，仅在你确认的请求中发送对应文章内容；授权自动规则后，后续匹配文章才会按规则自动发送给所配置的 Provider。
- **凭据保护**：备份文件默认**不包含** AI API 密钥；只有在主动勾选后才会写入备份。

## 技术栈

- **桌面端与前端**：Electron · React 19 · TypeScript · Vite
- **本地服务与存储**：Fastify · Node.js 24（内置 `node:sqlite`） · Mozilla Readability · DOMPurify

## 从源码运行

开发和构建需要 **Node.js 24** 与 **npm**；生成 Windows 便携目录包需要在 **Windows** 环境下运行。

```powershell
# 安装依赖
npm ci

# 启动开发模式（Vite + Electron）
npm run dev
```

常用测试与打包命令：

| 命令 | 说明 |
| --- | --- |
| `npm test` | 构建服务端模块并运行完整测试套件 |
| `npm run dist:win` | 执行类型检查、应用构建、Windows 便携包打包、ZIP 校验与基础桌面主流程验证 |
| `npm run release:verify` | 运行完整回归测试与最新便携包的桌面验证并整理产物 |

## 许可证

Rivu 采用 [Apache License 2.0](LICENSE) 开源许可，归属说明见 [NOTICE.md](NOTICE.md)。

第三方依赖保留其各自许可证：依赖清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，完整许可证文本见 [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt)。
