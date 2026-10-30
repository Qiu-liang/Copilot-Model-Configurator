# Copilot Model Configurator

在 VS Code 中可视化管理 GitHub Copilot 的第三方模型配置，不必手写 `chatLanguageModels.json`。

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC)

## 功能

- 新增、编辑、复制、删除模型，按连接分组管理；分组设置统一维护 API 地址、API 类型与 API Key。
- 模型只配置 ID、显示名称、上下文与能力，地址和类型从分组继承。
- 设置总上下文窗口、最大输入/输出 Tokens；总窗口变化时自动换算输入，也可手动覆盖。
- 切换视觉模型、工具调用、流式输出。
- 设置思考能力、支持的思考强度、默认强度与参数格式。
- 在分组设置中选择 Chat Completions / Responses / Messages API，并统一应用到该分组模型。
- 保存前测试连接，按 DNS、超时、TLS、认证、限流、重定向、服务端错误分类提示；支持取消。
- 保存前预览 JSON、自动备份、外部修改冲突检测。
- 导入两步确认：先解析预览，再写入；导入默认剔除 API Key。
- 导出默认剔除 API Key，可复制到剪贴板或保存为文件。
- 旧版 `customOAIModels` 设置只读展示并可导入面板，不自动删除旧设置。
- 活动栏侧边栏、视图标题按钮与命令面板入口，窄屏自动切换为单列导航。
- 完整键盘操作、焦点管理、主题变量与屏幕阅读器标签。

## 使用

1. 安装扩展后，点击活动栏的 **Copilot 模型**，或运行命令 **Copilot 模型：打开模型管理面板**。
2. 新建分组时填写 **API 地址（Base URL）** 与 **API 类型**，保存分组后再为分组设置 **API Key**。
3. 点击 **新增模型**，只需填写模型 ID、显示名称与上下文/能力；地址、类型和凭据自动继承分组。
4. 保存后，在 Copilot 聊天模型选择器中选择该模型。

也可以运行 **Copilot 模型：添加第三方模型** 直接进入新增流程，或从侧边栏模型右键复制/删除。

## 重要说明

- 本扩展是配置工具，不代理 Copilot 请求，也不保证第三方接口一定兼容 Copilot。
- 分组是接口配置单位：同一分组共用 API 地址、API 类型与 API Key；需要不同地址请拆分成多个分组。
- 分组地址保存在分组对象的 `baseUrl` 字段（Copilot 会忽略），每个模型的 `url` 由面板按 `baseUrl + apiType` 派生写入。
- 保存分组设置会重写该分组全部模型的地址，并移除模型级 `apiType`。
- 配置写入当前 VS Code Profile；不同 Profile 互不影响。
- API Key 由 VS Code 密钥存储保存，绝不会明文写入配置文件或导出内容；面板不会回显已保存的 Key。
- 模型“支持思考”只声明能力；具体强度由 Copilot 模型选择器按会话保存。
- 编辑模型时不能更换分组，避免产生重复模型；如需迁移，请新建后删除旧条目。
- 删除模型不会隐式删除分组凭据；删除分组或清除凭据都需要单独确认。
- 写入依赖 VS Code 内部的分组命令；版本不支持时会明确提示，而不是退化为不安全写法。

## 开发

```bash
npm install
npm run check
npm test
npm run build
```

集成测试（需要本机安装 VS Code）：

```bash
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm run test:integration
```

详见 [开发文档](./DEVELOPMENT.md) 与 [实现说明](./IMPLEMENTATION.md)。

## 已知限制

- 依赖 VS Code / Copilot 的语言模型分组格式，升级后可能需要适配。
- 分组地址 `baseUrl` 是面板私有字段；若被其他工具清理，面板会从模型 URL 重新推导，并在下次保存时补回。
- 一个分组只能有一个接口地址；不同地址的模型必须拆分到不同分组。
- 保存后由 VS Code 文件监听刷新模型列表；若选择器未更新，请刷新面板或重载窗口。
- 已保存的 API Key 不会回传，测试连接时需要重新输入一次。
- 不支持分组重命名和跨分组迁移。
