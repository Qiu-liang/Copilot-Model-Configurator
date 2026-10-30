# 实现说明

本文件记录当前代码与 [DEVELOPMENT.md](./DEVELOPMENT.md) 的对应关系、验证方式，以及仍受 VS Code / Copilot 版本限制的部分。设计依据与字段语义见开发文档。

## 1. 已实现范围

### 命令与入口

- `copilotModels.open` / `copilotModels.addGroup` / `copilotModels.add`：打开模型管理面板、打开独立添加分组页，或直接进入新增模型流程。
- `copilotModels.openModel` / `copilotModels.copyModel` / `copilotModels.openGroup`：从侧边栏树打开模型、复制模型、打开分组设置。
- `copilotModels.deleteModel`：侧边栏右键删除，带确认。
- 树命令的实参有两种来源：`TreeItem.command.arguments` 传显式 ref，`view/item/context` 内联按钮传树元素实例。四个树命令统一用 `models/refs.ts` 的 `modelRefOf` / `groupRefOf` 归一化后再执行。
- `copilotModels.refresh` / `copilotModels.export` / `copilotModels.importLegacy`。
- `copilotModels.openConfigFile` / `copilotModels.openBackups` / `copilotModels.openLegacySetting` / `copilotModels.openDashboard`。
- 活动栏“Copilot 模型”视图展示分组/模型树；视图标题按钮提供打开面板、添加分组、添加模型和刷新，空状态欢迎页也提供添加分组/模型链接。原生树空白区域右键受 VS Code 限制。
- 面板只显示欢迎页、添加分组页、编辑表单或分组设置，不再重复渲染模型列表；点击树中的模型或分组会定向打开面板。
- 面板“更多”菜单提供导入、导出、旧版导入、打开配置文件/备份目录/旧设置和官方模型管理。

### 模型管理

- 新增、编辑、复制、删除模型；删除最后一个模型时保留空分组与凭据，避免隐式删除凭据。
- 分组是接口配置单位：分组设置页统一维护 API 地址（`baseUrl`）、API 类型（`apiType`）、API Key，并可新增模型、清除凭据引用、删除分组、打开 JSON 配置。
- 独立的添加分组页收集分组名称、提供方、API 地址、API 类型、认证方式与 API Key；保存后创建空分组并显示该分组设置页。
- 模型表单只保留模型自身字段（ID、显示名称、上下文、能力、思考强度）；只允许选择已有分组，接口以只读方式展示并提供“打开分组设置”。新建分组不再嵌入模型表单。
- 保存模型时按分组 `baseUrl + apiType` 派生 `url` 并删除模型级 `apiType`；保存分组设置时批量重写该分组全部模型地址。
- 表单字段：连接分组（仅已有）、模型 ID、显示名称、总上下文窗口、最大输入/输出 Tokens、工具调用、视觉、流式、思考能力、支持强度、默认强度、强度参数格式；分组接口与凭据由添加分组页/分组设置页维护。
- 模型 ID 与显示名称在用户未手动修改名称时自动同步；总窗口/输出变化时自动换算输入，手动编辑输入后停止自动跟随，可一键恢复自动换算。
- 思考开启状态由 `thinking` 或非空 `supportsReasoningEffort` 任一存在推导（二者互不覆盖）；关闭时清空强度字段；默认强度必须属于支持列表；目标版本不支持默认强度时只给出警告并提示到模型选择器设置。开启但未选强度时只写原生 `thinking`，并以警告提示不会显示强度选择器。
- 高级设置包含即将写入的模型 JSON 预览（不含密钥）、分组凭据入口、配置/备份/旧设置入口。

### 保存、导入与导出

- 原子写入（临时文件 + rename），写入前备份，备份数量可配置。
- 分组 `baseUrl` 是面板私有字段：凭据重建前从 migrate payload 剔除，写入成功后回读补回，避免官方命令重建分组时丢失。
- 写入前比对配置指纹；外部修改导致冲突时拒绝覆盖，面板提示使用最新快照继续或刷新。
- 合并时只修改目标分组和目标模型，保留同组其他模型、其他分组、其他提供方与未知字段。
- 导入为两步：`config/import` 只解析并校验，返回分组预览、冲突与错误；用户确认后 `config/importApply` 才写入。
- 导入清洗分组级与模型级 `apiKey`；覆盖同名分组时保留原有凭据引用、`settings` 与分组 `baseUrl`/`apiType`。
- 导出使用字段白名单，剔除密钥、`settings` 和未知字段，保留分组 `baseUrl`/`apiType`；支持预览、复制到剪贴板、保存到文件。
- 旧版 `github.copilot.chat.customOAIModels` 只读加载，支持导入到面板，不写旧设置、不自动删除旧设置。

### 连接测试

- 后端发起最小 Chat Completions / Responses / Messages 请求，不发送图片、工具或高强度思考。
- 首次对某个地址与模型组合测试时弹窗提示会发送测试消息并可能产生费用（可通过设置关闭）。
- 默认超时 15 秒，可取消；开始新测试会取消旧测试。
- 不跟随重定向，响应体最多读取 8 KB，错误内容截断并脱敏。
- 按 DNS、超时、TLS、401、403、404、429、5xx、重定向、响应格式、配置问题分类提示。

## 2. 架构

```text
src/
├── extension.ts                        # 命令、侧边栏、面板、文件监听、生命周期
├── panel/
│   ├── ModelPanel.ts                   # Webview 宿主、CSP、nonce、资源与消息入口
│   ├── MessageController.ts            # 请求校验、去重、确认、错误分类与响应
│   ├── protocol.ts                     # type/requestId/payload 协议与请求账本
│   └── ModelTreeProvider.ts            # 侧边栏分组/模型树
├── models/
│   ├── modelConfig.ts                  # 内部类型与快照
│   ├── draft.ts                        # 草稿映射、校验、URL/强度换算
│   ├── configDocument.ts               # 原始分组文档操作与脱敏导出
│   └── importExport.ts                 # 导入清洗、预览、合并、旧版转换
├── services/
│   ├── ModelConfigService.ts           # 快照、冲突、合并、保存、导入导出编排
│   ├── ConnectionTester.ts             # 最小请求、超时、取消、错误分类
│   └── redact.ts                       # 日志与错误脱敏
├── adapters/
│   ├── CopilotConfigAdapter.ts         # 唯一的 Copilot 读写边界与能力汇总
│   ├── CurrentGroupAdapter.ts          # 当前 Profile 分组读写、凭据重建命令
│   ├── LegacySettingsAdapter.ts        # 旧版设置只读适配器
│   ├── ConfigFileStore.ts              # 原子文件读写与备份
│   └── ProviderRegistry.ts             # 读取安装版 Copilot 提供方 Schema
└── webview/
    ├── index.html                      # Webview 模板（CSP 占位符）
    ├── styles.css                      # VS Code 主题变量、响应式布局
    └── main.ts                         # 添加分组、分组设置、表单、导入预览、对话框
```

### 2.1 唯一读写边界

`CopilotConfigAdapter` 组合文件存储、当前分组适配器、旧版设置适配器和提供方注册表，业务层只依赖它。未来若出现公开 API，只需替换该适配器，Webview 与表单逻辑不变。

### 2.2 直接读写配置文件

VS Code 没有公开 API 读取完整的 `chatLanguageModels.json`。当前实现由扩展的 `globalStorageUri` 推导：

```text
<profile-dir>/globalStorage/<publisher>.<extension>/chatLanguageModels.json
→ <profile-dir>/chatLanguageModels.json
```

默认 Profile 下 `<profile-dir>` 即用户数据目录；命名 Profile 下为 `User/profiles/<id>`，与其 `languageModelsResource` 布局一致。读取时不做结构猜测，只在解析失败时中止写入。

### 2.3 写入分两条路径

| 场景 | 实现 | 原因 |
| --- | --- | --- |
| 不带新 API Key | 合并模型后直接原子写文件 | 保留未知字段与其他分组最可靠，且密钥引用（`${input:...}`）原样保留 |
| 带新 API Key | 先确认命令与 Copilot 可用 → 落盘模型（保留旧密钥引用）→ 临时移除分组 → 调用 `lm.migrateLanguageModelsProviderGroup` 重建 → 回读校验；失败恢复原分组 | 只有 VS Code 核心能写入加密密钥存储，且必须避免半成品状态 |

`lm.migrateLanguageModelsProviderGroup` 属于内部命令。调用前通过命令列表检测其是否存在；缺失时保存会明确报错，不会退化为明文写密钥。

### 2.4 提供方能力按安装版本检测

`ProviderRegistry` 读取 `GitHub.copilot-chat` 的 `packageJSON.contributes.languageModelChatProviders`，据此决定：

- 是否展示 API 类型与强度参数格式；
- 是否允许写入 `apiType` 与 `reasoningEffortFormat`；
- 是否提示 `defaultReasoningEffort` 不受支持。

截至 v1.141.1 随包 Copilot 0.69.0：

- `customendpoint` 是推荐目标，支持模型级 `apiType`、`supportsReasoningEffort`、`reasoningEffortFormat`；
- `customoai` 标记为已弃用，仅作为兼容读取与可选手动目标；
- `defaultReasoningEffort` 不在安装版模型 Schema 中，因此默认不写入，只在 UI 提示到模型选择器设置。

## 3. Webview 协议

所有请求使用统一信封，响应按 `requestId` 关联：

```typescript
interface WebviewRequest {
  type: string;        // 受白名单限制
  requestId: string;   // 后端一次性账本校验
  payload: object;     // 按类型逐字段校验
}

interface ExtensionResponse {
  type: 'response';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; field?: string; issues?: ValidationIssue[] };
}
```

请求类型：

| 请求 | 后端行为 |
| --- | --- |
| `config/list` | 读取当前 Profile 并推送快照 |
| `config/save` | 校验、合并、写入、回读 |
| `config/delete` | 删除模型并回读 |
| `config/deleteGroup` | 删除分组并回读 |
| `group/create` | 创建空分组并写入 baseUrl/apiType，可选写入 API Key |
| `group/save` | 保存分组统一接口（baseUrl/apiType）并批量重写模型地址 |
| `group/promptApiKey` | 用 VS Code 输入框收集密钥并重建分组 |
| `group/clearApiKey` | 清除分组凭据引用（单独确认） |
| `connection/test` / `connection/cancel` | 受限测试与取消 |
| `config/export` / `config/exportSave` | 脱敏导出、复制或保存 |
| `config/import` / `config/importApply` | 导入预览与确认写入 |
| `legacy/import` / `legacy/openSetting` | 旧版设置导入与打开 |
| `panel/openOfficial` / `panel/openConfigFile` / `panel/openBackups` | 官方入口与本地文件入口 |
| `ui/dirty` / `ui/refresh` | 面板脏标记与刷新 |

- `RequestLedger` 拒绝重复 `requestId`，防止重复保存/删除等重放。
- 未知消息类型、非法字段和伪造 payload 在 `MessageController` 统一拒绝。
- 密钥只出现在添加分组页、新增/编辑表单的保存或测试请求中；更新已有分组密钥使用 VS Code 输入框，不进入 Webview。
- 错误和日志经过 `redact.ts`，移除已知密钥、Bearer token、`sk-` 形式和敏感查询参数。

## 4. 安全措施

- CSP：`default-src 'none'`，脚本仅 nonce，样式/字体/图片仅扩展资源，`connect-src 'none'`。
- Webview 不使用 `innerHTML` 渲染任何用户输入，全部使用 `textContent`/`createElement`。
- API Key 不回显：编辑时输入框为空，显示“已配置，不修改则保留”。
- 导出白名单剔除 `apiKey`、`settings` 与未知字段；导入主动剔除明文密钥。
- 连接测试只由用户主动触发；`http://` 非本机地址默认拒绝写入，需高级设置确认。
- 日志默认不记录完整 URL、模型返回正文或凭据。

## 5. 主要文件

| 文件 | 作用 |
| --- | --- |
| [src/extension.ts](./src/extension.ts) | 注册命令、侧边栏、初始化服务、监听配置文件与旧版设置 |
| [src/panel/ModelPanel.ts](./src/panel/ModelPanel.ts) | Webview 宿主、CSP、模板加载、脏标题 |
| [src/panel/ModelTreeProvider.ts](./src/panel/ModelTreeProvider.ts) | 侧边栏分组/模型树与空状态描述 |
| [src/panel/MessageController.ts](./src/panel/MessageController.ts) | 消息校验、请求去重、确认对话框、错误响应 |
| [src/webview/main.ts](./src/webview/main.ts) | 表单、分组设置、导入预览、对话框、可访问性 |
| [src/services/ModelConfigService.ts](./src/services/ModelConfigService.ts) | 快照、冲突检测、合并、保存、导入导出 |
| [src/adapters/CopilotConfigAdapter.ts](./src/adapters/CopilotConfigAdapter.ts) | 唯一 Copilot 读写边界与能力汇总 |
| [src/adapters/CurrentGroupAdapter.ts](./src/adapters/CurrentGroupAdapter.ts) | 原子写入、备份、凭据重建命令 |
| [src/models/draft.ts](./src/models/draft.ts) | 草稿映射、校验、URL 推导、复制草稿 |
| [src/models/groupEndpoint.ts](./src/models/groupEndpoint.ts) | 分组接口归一化、推导、批量重写与校验 |
| [src/models/importExport.ts](./src/models/importExport.ts) | 导入清洗、预览、合并、旧版转换 |
| [src/services/ConnectionTester.ts](./src/services/ConnectionTester.ts) | 最小请求、超时、取消、错误分类与脱敏 |

## 6. 验证

```bash
npm run check              # TypeScript 类型检查
npm test                   # 133 项单元测试
npm run build              # 构建 dist/extension.js、dist/webview.js 与 Webview 资源
npm run test:integration   # 真实 VS Code 集成测试（使用本地安装的 VS Code）
```

集成测试在 `.vscode-test/user-data` 建立隔离 Profile，覆盖：

- 扩展加载、命令注册、配置读取；
- 不带密钥的新增模型，其他分组与 `${input:...}` 密钥引用不变；
- 编辑模型保留未修改字段；
- 过期 fingerprint 被拒绝；
- 校验失败不写盘；
- 删除模型保留分组；
- 导出不含密钥；
- 导入含明文密钥时移除该字段并保留原凭据；
- 导入预览不写盘、接受单个分组对象；
- 无效导入在后端再次校验并拒绝；
- 清除分组凭据引用但保留模型；
- 分组统一接口：写入 baseUrl/apiType、重写全部模型 url、移除模型级 apiType、保留凭据引用；
- 模型保存沿用分组接口，忽略表单地址；
- 无认证分组中的模型再次保存不需要补密钥，且仍解析为无需认证；
- 缺少 Copilot 提供方时拒绝保存密钥，且不留下半成品配置。

运行要求：已安装 VS Code，且 `VSCODE_EXECUTABLE` 指向可执行文件，例如：

```bash
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm run test:integration
```

Webview 还使用本地静态夹具做过渲染验收：添加分组页/分组设置/编辑表单/新增表单/导入预览/放弃修改对话框、窄屏单列导航、固定操作区、上下文自动换算、URL 失焦校验、连接测试结果与错误汇总均已人工检查。

## 7. 已知限制

1. 内部命令不是稳定 API。VS Code/Copilot 升级后若命令或字段改名，需要更新 `CurrentGroupAdapter` 与 `ProviderRegistry`。
2. 测试宿主不一定加载随包 Copilot 扩展；集成测试通过 `overrideCapabilitiesForTesting` 注入目标能力，生产环境仍读取真实清单。
3. 直接修改文件依赖 VS Code 的文件监听刷新模型列表，通常即时生效；若模型选择器未更新，可执行“刷新”或重载窗口。
4. 更新分组 API Key 会重建该分组；期间若 VS Code 拒绝命令，扩展会恢复原分组并提示改用官方模型管理。
5. 已保存的 API Key 不会回传到面板，因此测试连接时需要重新输入 Key；这是避免泄露的刻意限制。
6. 删除最后一个模型会保留空分组与凭据引用；如需移除，请使用分组设置中的“删除分组”。这避免隐式删除仍可能被复用的凭据。
7. 当前不处理“同一模型 ID 跨分组迁移”，也不提供分组重命名；这些操作容易产生遗留配置，留待后续设计。
8. 旧版设置导入不校验每个旧模型是否能被当前 Copilot 接受，导入后请在模型选择器中确认；旧设置不会被自动清理。

## 8. 手工验收建议

1. 在测试 Profile 中打开面板，确认现有分组、凭据状态与旧版设置展示正确。
2. 新增模型并保存，重载窗口后在 Copilot 模型选择器确认出现。
3. 编辑视觉、上下文、思考强度，检查 `chatLanguageModels.json` 只发生预期变化。
4. 在低/中/高强度之间切换，用可控测试服务器确认请求字段。
5. 输入新 API Key，确认文件仍是 `${input:...}` 引用且面板不回显。
6. 在编辑器中手动修改配置后尝试保存，确认出现冲突提示而不是覆盖。
7. 导出后检查文件不含 `apiKey`，导入预览确认后再写入。
8. 在视图标题栏点击“添加分组”，创建空分组；再在该分组下新增模型，确认树与面板同步。
9. 缩窄窗口，确认分组创建页、表单和分组设置可用，底部操作区仍可达。
