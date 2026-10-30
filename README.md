# Copilot Model Configurator

为 GitHub Copilot 的第三方模型（BYOK）提供可视化配置面板：按分组维护接口地址与凭据，用表单声明上下文、视觉、工具调用和思考强度，不必再手写 `chatLanguageModels.json`。

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/Qiu-liang/Copilot-Model-Configurator/releases)

> **English** — A VS Code extension for managing GitHub Copilot BYOK models through a visual panel. Endpoint groups own the base URL, API type and credentials; models declare context size, vision, tool calling and reasoning effort. It also provides connection tests, import/export, automatic backups and conflict detection. This is a configuration tool, not a proxy: requests still go directly from Copilot to your provider. The UI is currently in Chinese; issues and pull requests in English are welcome.

<!-- 截图：将界面截图保存为 docs/screenshot.png 后启用下一行 -->
<!-- ![模型管理面板](docs/screenshot.png) -->

## 为什么用它

Copilot 的 BYOK 配置本质上是一份 JSON。手写时很容易遇到这些问题：

- API 地址要按接口类型拼成完整端点，写错只能等请求失败；
- 明文写入 API Key，既容易被提交到 Git，也不方便轮换；
- 修改一个模型时误删同组其他模型或未知字段；
- `contextWindow`、`maxInputTokens`、`maxOutputTokens` 三者必须自洽；
- 思考强度在 Chat Completions、Responses、Messages 三种接口里的字段位置不同。

面板把这些规则固化成表单和校验，同时保留 JSON 预览、导入导出和冲突检测。

## 功能

**分组与模型**

- 左侧活动栏树按连接分组列出模型；点击模型在右侧面板编辑，点击分组修改地址与凭据。
- 视图标题栏提供“添加分组”和“添加模型”按钮；添加分组是独立页面，添加模型只使用已有分组。
- 新增、编辑、复制、删除模型，按连接分组浏览。
- 分组统一维护 Base URL、API 类型和 API Key；模型只填 ID、显示名称、上下文和能力。
- 保存分组设置会按分组地址重写该组全部模型 URL，并移除模型级 `apiType`。
- 支持 Chat Completions、Responses、Messages 三种 API 类型。

**上下文与能力**

- 设置总上下文窗口、最大输入/输出 Tokens；修改总窗口或输出时自动换算输入，也可手动覆盖。
- 视觉模型、工具调用、流式输出开关。
- 思考能力、支持强度、默认强度与参数格式；按接口类型写入不同字段。
- 写盘前预览模型 JSON（不含密钥）。

**连接与可靠性**

- 保存前测试连接：发送最小请求，按 DNS、超时、TLS、401/403、404、429、5xx、重定向、响应格式分类提示，可取消。
- 原子写入、自动备份（数量可配）、外部修改冲突检测。
- 合并写入：只修改目标分组和模型，保留其他分组、其他提供方与未知字段。

**导入导出与迁移**

- 导入两步确认：先解析预览冲突，再写入；默认剔除 API Key。
- 导出默认剔除 API Key，可复制到剪贴板或保存为文件。
- 旧版 `github.copilot.chat.customOAIModels` 只读展示，可导入面板，不自动删除旧设置。

**入口与可访问性**

- 活动栏模型树、视图标题按钮、命令面板和侧边栏右键菜单；右侧面板只显示编辑表单或分组设置，不重复模型列表。
- 窄屏自动切换单列导航；完整键盘操作、焦点管理、主题变量与屏幕阅读器标签。

## 安装

### 环境要求

- VS Code **1.90+** 桌面版（Windows / macOS / Linux；不支持 Web 版）。
- 已安装并登录 **GitHub Copilot Chat**；BYOK 是否可用取决于你的 Copilot 订阅。
- 能访问你的第三方 API 地址。

> 分组写入依赖 VS Code 内部命令，已在 **VS Code 1.141.1 + Copilot Chat 0.69.0** 验证。更旧的版本可能无法写入新的 API Key；扩展会明确报错，而不是退化为明文写入。

### 从 VSIX 安装（推荐）

从 [Releases](https://github.com/Qiu-liang/Copilot-Model-Configurator/releases) 下载最新的 `.vsix`。如果发布页暂时还没有安装包，请先按下方“从源码构建”生成。

1. 在扩展视图右上角 `...` → **从 VSIX 安装**，或使用命令行：

```bash
code --install-extension copilot-model-configurator-0.3.0.vsix
```

2. 重载窗口。

当前尚未发布到 VS Code 扩展市场。

### 从源码构建

需要 Node.js 22.18+（单元测试依赖 Node 内置的 TypeScript 支持）。

```bash
git clone https://github.com/Qiu-liang/Copilot-Model-Configurator.git
cd Copilot-Model-Configurator
npm install
npm run build
npx @vscode/vsce package
code --install-extension copilot-model-configurator-0.3.0.vsix
```

版本号以实际生成的 `.vsix` 文件名为准。

## 快速开始

1. 点击活动栏 **Copilot 模型**，在左侧模型树中选择模型；也可以运行命令 **Copilot 模型: 打开模型管理面板**。
2. 点击视图标题栏的 **添加分组** 按钮，在独立页面填写分组名称、**Base URL**、**API 类型**与认证方式；保存后左侧树出现该分组。
3. 选中分组后点击 **新增模型**，或在该分组页点击 **新增模型到该分组**，填写模型 ID、显示名称、上下文与能力。地址、类型和凭据自动继承自分组。
4. 可选：点击 **测试连接** 验证地址、类型和凭据。
5. 保存。若 Copilot 模型选择器没有立即更新，重载窗口后即可选择新模型。

> 模型 ID 必须与服务方文档一致，它不是显示名称。
>
> VS Code 原生树不支持在空白区域挂右键菜单；添加分组/模型入口位于视图标题栏和空状态欢迎页。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| Copilot 模型: 打开模型管理面板 | 打开完整管理面板 |
| Copilot 模型: 添加连接分组 | 打开独立的分组创建页面 |
| Copilot 模型: 添加第三方模型 | 使用已有分组直接进入新增模型流程 |
| Copilot 模型: 导出模型配置（不含密钥） | 预览、复制或保存脱敏配置 |
| Copilot 模型: 打开 chatLanguageModels.json | 查看当前 Profile 的实际配置 |
| Copilot 模型: 打开配置备份目录 | 找回保存前的自动备份 |
| Copilot 模型: 打开 Copilot 官方模型管理 | 跳转到官方入口 |

## 工作原理

- **只作用于当前 Profile**：配置写入当前 VS Code Profile 的 `chatLanguageModels.json`；不同 Profile 互不影响。
- **合并而非覆盖**：读取原始文档，只修改目标分组和目标模型，保留同组其他模型、其他分组、其他提供方和未知字段。
- **分组是接口单位**：`baseUrl` + `apiType`（以及分组凭据）由分组统一维护，每个模型的 `url` 由面板派生。`baseUrl` 是面板私有字段，Copilot 会忽略；若被其他工具清理，面板会从模型 URL 重新推导。
- **密钥不进配置文件**：API Key 由 VS Code 密钥存储保存，配置文件里只有 `${input:...}` 引用；面板不回显已保存的 Key。写入新 Key 时通过内部命令重建分组，命令不可用则拒绝写入。
- **不是代理**：扩展不接管 Copilot 的聊天请求，也不保证第三方接口一定兼容。

<details>
<summary>配置结构示例（字段映射示意，不是稳定 Schema）</summary>

```json
[
  {
    "vendor": "customendpoint",
    "name": "My Provider",
    "baseUrl": "https://api.example.com/v1",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "provider-model-id",
        "name": "My Model",
        "url": "https://api.example.com/v1/chat/completions",
        "contextWindow": 128000,
        "maxInputTokens": 120000,
        "maxOutputTokens": 8000,
        "toolCalling": true,
        "vision": true,
        "streaming": true,
        "supportsReasoningEffort": ["low", "medium", "high"]
      }
    ]
  }
]
```

</details>

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `copilotModelManager.connectionTimeoutSeconds` | `15` | 连接测试与模型发现超时（3–120 秒） |
| `copilotModelManager.backupCount` | `10` | 保留的配置备份数量，`0` 表示不备份（0–100） |
| `copilotModelManager.confirmBeforeDelete` | `true` | 删除模型或分组前显示确认 |
| `copilotModelManager.confirmTestRequest` | `true` | 首次测试某个地址与模型组合时，提示会发送测试消息并可能产生费用 |

## 安全与隐私

- 不收集遥测。
- API Key 不写入配置文件、导出内容、日志或 Webview 状态；编辑时输入框为空，只显示“已配置，不修改则保留”。
- 连接测试只由用户主动触发，只发送一条最小请求，不发送图片、工具或高强度思考参数。
- 导入和导出默认剔除密钥；导入时主动清理明文 `apiKey`。
- Webview 使用严格 CSP，用户输入按纯文本渲染。
- 日志和错误信息经过脱敏，不记录完整 URL 或凭据。

## 兼容性与已知限制

- 依赖 Copilot 内部的分组配置格式和 `lm.migrateLanguageModelsProviderGroup` 命令。VS Code / Copilot 升级后可能需要适配；命令缺失时会明确提示，不会退化为不安全的写入方式。
- `customoai` 提供方已标记为弃用，扩展优先使用 `customendpoint`，仅对旧配置保留兼容读取。
- 一个分组只能有一套地址与凭据；不同 Base URL 或不同 Key 的模型必须拆到不同分组。
- 已保存的 API Key 不会回传，测试连接时需要重新输入一次。
- 不支持分组重命名和跨分组迁移；如需调整，请新建模型后删除旧条目。
- 删除最后一个模型会保留空分组与凭据引用；这是为了避免隐式删除仍可能被复用的凭据。
- 保存后依赖 VS Code 文件监听刷新模型列表；若选择器未更新，请刷新面板或重载窗口。
- 不支持 VS Code Web 版；配置作用域为当前 Profile，不处理多设备同步冲突。

## 常见问题

**保存后，Copilot 模型选择器里没有新模型？**

先重载窗口。仍不显示时，确认 Copilot Chat 已安装并登录，并检查当前 Profile 的 `chatLanguageModels.json`（命令：**打开 chatLanguageModels.json**）。

**测试连接返回 401 / 403？**

已保存的 Key 不会回显，测试时需要重新输入。再确认 Base URL 是否包含多余的 `/chat/completions`、API 类型是否与服务端一致，以及网关是否改写了 `Authorization` 头。

**会不会覆盖我手写的配置？**

不会整体覆盖。保存只合并目标分组和目标模型，并保留未知字段；写入前会比对配置指纹，检测到外部修改时停止并提示。

**支持 Claude、Gemini 或其他厂商吗？**

只要服务端提供 Chat Completions、Responses 或 Messages 兼容接口即可配置。扩展不做厂商预设，也不验证模型声明的能力是否真实；勾选“视觉”不会让纯文本模型获得图片能力。

**为什么编辑模型时不能换分组？**

换组会产生重复模型和遗留凭据。请在新分组中新建模型，再删除旧条目。

**删除模型后，分组为什么还在？**

凭据属于分组。为避免误删仍被其他模型使用的 Key，删除模型不会删除分组；请在分组设置中单独删除分组或清除凭据。

**和 VS Code 官方的“管理模型”有什么区别？**

官方入口仍可从面板打开。本扩展补充了分组统一地址/凭据、批量重写模型 URL、思考强度字段、导入导出、自动备份和冲突检测。

## 开发

```bash
npm install
npm run check
npm test
npm run build
```

开发时可用 `npm run watch` 持续构建。集成测试需要本机安装 VS Code：

```bash
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm run test:integration
```

其他平台请将 `VSCODE_EXECUTABLE` 指向对应的 VS Code 可执行文件。

目录结构：

```text
src/
├── extension.ts       # 命令、侧边栏、面板、文件监听、生命周期
├── adapters/          # Copilot 配置读写边界（唯一写入点）
├── models/            # 草稿、校验、分组地址、导入导出
├── services/          # 保存编排、冲突检测、连接测试、脱敏
├── panel/             # Webview 宿主、消息协议、模型树
└── webview/           # 无框架前端（HTML / CSS / TypeScript）
test/
├── unit/              # 单元测试
└── integration/       # 真实 VS Code 集成测试
```

设计与实现细节见 [DEVELOPMENT.md](./DEVELOPMENT.md) 和 [IMPLEMENTATION.md](./IMPLEMENTATION.md)。

## 许可证

[MIT](./LICENSE) © 2026 Qiu-liang

本项目为个人项目，与 GitHub / Microsoft 无隶属关系。GitHub Copilot 与 Visual Studio Code 是其各自所有者的商标。
