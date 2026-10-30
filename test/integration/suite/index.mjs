import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

async function waitFor(check, timeoutMs = 15000, intervalMs = 200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('等待条件超时');
}

export async function run() {
  const userDataDir = process.env.CMC_USER_DATA;
  assert.ok(userDataDir, 'CMC_USER_DATA 必须指向测试用 user-data 目录');

  const extension = vscode.extensions.getExtension('local.copilot-model-configurator');
  assert.ok(extension, `扩展未加载。已安装：${vscode.extensions.all.map((entry) => entry.id).join(', ')}`);
  if (!extension.isActive) {
    await extension.activate();
  }

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('lm.migrateLanguageModelsProviderGroup'), '缺少官方分组命令');
  assert.ok(commands.includes('copilotModels.open'), '扩展命令未注册');

  assert.ok(extension, '扩展未加载');
  const api = extension.isActive ? extension.exports : await extension.activate();
  assert.ok(api?.getService, '扩展未导出测试 API');
  await api.ready;

  const service = api.getService();
  assert.ok(service, '扩展服务未初始化');

  // 打开面板命令应创建管理面板。
  await vscode.commands.executeCommand('copilotModels.open');
  await waitFor(() =>
    vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => String(tab.input?.viewType ?? '').endsWith('copilotModels.panel')),
    ),
  );

  // 以扩展实际解析到的配置路径为准；不同 VS Code 版本对 globalStorageUri 的布局可能不同。
  const configPath = service.configFilePath;
  assert.ok(configPath.startsWith(userDataDir), `配置路径不在测试目录内：${configPath}`);
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const original = read();

  // 测试宿主不加载内置 Copilot 扩展，显式声明当前目标版本的能力。
  service.overrideCapabilitiesForTesting('customendpoint', {
    supportsApiType: true,
    supportsReasoningEffort: true,
    supportsReasoningEffortFormat: true,
    supportsThinking: true,
    supportsDefaultReasoningEffort: false,
  });

  const snapshot = await service.reload();
  assert.equal(snapshot.source, 'file');
  assert.ok(snapshot.fingerprint.length === 64);
  const probe = snapshot.groups.find((group) => group.name === 'ProbeGroup');
  assert.ok(probe, '应读取到现有 customendpoint 分组');
  assert.equal(probe.hasApiKey, true);
  assert.equal(probe.models[0]?.id, 'existing');

  // 1) 不带密钥保存：直接写文件，保留其他分组与密钥引用。
  await service.saveDraft(
    {
      vendor: 'customendpoint',
      groupName: 'ProbeGroup',
      id: 'added',
      name: 'Added Model',
      url: 'https://api.example.com/v1/chat/completions',
      apiType: 'chat-completions',
      contextWindow: 2000,
      maxInputTokens: 1900,
      maxOutputTokens: 100,
      toolCalling: true,
      vision: true,
      thinking: true,
      streaming: true,
      supportsReasoningEffort: ['low', 'high'],
      reasoningEffortFormat: 'chat-completions',
    },
    snapshot.fingerprint,
  );
  const afterAdd = read();
  const keep = afterAdd.find((group) => group.vendor === 'openai');
  assert.equal(JSON.stringify(keep), JSON.stringify(original.find((group) => group.vendor === 'openai')));
  const updatedGroup = afterAdd.find((group) => group.name === 'ProbeGroup');
  assert.equal(updatedGroup.apiKey, '${input:chat.lm.secret.old}', '保存模型不得改动密钥引用');
  assert.equal(updatedGroup.models.length, 2);
  const added = updatedGroup.models.find((model) => model.id === 'added');
  assert.equal(added.name, 'Added Model');
  assert.equal(added.vision, true);
  assert.deepEqual(added.supportsReasoningEffort, ['low', 'high']);
  assert.equal(added.reasoningEffortFormat, 'chat-completions');

  // 2) 编辑模型时保留未知字段。
  const current = await service.reload();
  const targetModel = current.groups.find((group) => group.name === 'ProbeGroup').models.find((model) => model.id === 'existing');
  await service.saveDraft(
    {
      ...targetModel,
      name: 'Existing Renamed',
      vision: true,
    },
    current.fingerprint,
    { vendor: 'customendpoint', groupName: 'ProbeGroup', id: 'existing' },
  );
  const afterEdit = read();
  const edited = afterEdit.find((group) => group.name === 'ProbeGroup').models.find((model) => model.id === 'existing');
  assert.equal(edited.name, 'Existing Renamed');
  assert.equal(edited.vision, true);
  assert.equal(edited.toolCalling, true, '未修改字段应保留');

  // 3) 过期 fingerprint 必须拒绝写入。
  await assert.rejects(
    () =>
      service.saveDraft(
        {
          ...targetModel,
          id: 'conflict',
          name: 'Conflict',
        },
        snapshot.fingerprint,
      ),
    (error) => /外部修改/.test(String(error.message)),
  );

  // 4) 校验错误不写盘。
  const beforeInvalid = fs.readFileSync(configPath, 'utf8');
  const fresh = await service.reload();
  await assert.rejects(
    () =>
      service.saveDraft(
        {
          ...targetModel,
          id: 'bad id',
          contextWindow: 100,
          maxInputTokens: 90,
          maxOutputTokens: 100,
        },
        fresh.fingerprint,
      ),
    (error) => Array.isArray(error.issues),
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeInvalid);

  // 5) 删除模型并保留分组。
  const beforeDelete = await service.reload();
  await service.deleteModel(
    { vendor: 'customendpoint', groupName: 'ProbeGroup', id: 'added' },
    beforeDelete.fingerprint,
  );
  const afterDelete = read();
  const remaining = afterDelete.find((group) => group.name === 'ProbeGroup');
  assert.equal(remaining.models.some((model) => model.id === 'added'), false);

  // 6) 导出不含密钥。
  const exported = await service.export();
  assert.equal(exported.includes('chat.lm.secret'), false);
  assert.equal(exported.includes('apiKey'), false);
  assert.ok(exported.includes('ProbeGroup'));
  const parsedExport = JSON.parse(exported);

  // 7) 带新密钥保存：测试宿主缺少 Copilot 提供方时必须失败且不写盘。
  const beforeKey = await service.reload();
  const existingForKey = beforeKey.groups
    .find((group) => group.name === 'ProbeGroup')
    .models.find((model) => model.id === 'existing');
  const beforeKeyText = fs.readFileSync(configPath, 'utf8');
  await assert.rejects(
    () =>
      service.saveDraft(
        {
          ...existingForKey,
          name: 'Key Updated Model',
          apiKey: 'new-secret-key-789',
        },
        beforeKey.fingerprint,
        { vendor: 'customendpoint', groupName: 'ProbeGroup', id: 'existing' },
      ),
    (error) => /API Key/.test(String(error.message)),
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeKeyText, '密钥写入失败时不得留下半成品配置');
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('new-secret-key-789'), false);
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('Key Updated Model'), false);

  // 7) 导入含明文密钥时拒绝落盘密钥，且保留已有分组的凭据。
  const beforeImport = await service.reload();
  const importedGroups = JSON.parse(JSON.stringify(parsedExport)).map((group) => ({
    ...group,
    apiKey: 'plaintext-should-be-dropped',
  }));
  const importable = importedGroups.find((group) => group.vendor === 'customendpoint');
  assert.ok(importable, '导出结果应包含 customendpoint 分组');
  importable.name = 'ImportedGroup';
  const importResult = await service.importGroups(
    importedGroups,
    beforeImport.fingerprint,
    beforeImport.vendors[0],
  );
  assert.equal(importResult.strippedCredentials, true);
  const afterImport = read();
  assert.equal(JSON.stringify(afterImport).includes('plaintext-should-be-dropped'), false);
  assert.ok(afterImport.some((group) => group.name === 'ImportedGroup'));

  // 8) 导入覆盖同名分组时保留原 apiKey 引用。
  const beforeOverwrite = await service.reload();
  const overwritten = JSON.parse(JSON.stringify(parsedExport)).filter((group) => group.name === 'ProbeGroup');
  await service.importGroups(overwritten, beforeOverwrite.fingerprint, beforeOverwrite.vendors[0]);
  const afterOverwrite = read();
  const probeAfterOverwrite = afterOverwrite.find((group) => group.name === 'ProbeGroup');
  assert.equal(probeAfterOverwrite.apiKey, '${input:chat.lm.secret.old}', '覆盖导入不应丢失原有凭据');

  // 9) 导入预览不写盘，且接受单个分组对象。
  const beforePreview = fs.readFileSync(configPath, 'utf8');
  const preview = await service.previewImport({
    name: 'PreviewOnly',
    vendor: 'customendpoint',
    models: [
      {
        id: 'preview-model',
        name: 'Preview Model',
        url: 'https://preview.example.com/v1/chat/completions',
        contextWindow: 1000,
        maxInputTokens: 900,
        maxOutputTokens: 100,
        toolCalling: true,
        vision: false,
        streaming: true,
      },
    ],
  });
  assert.equal(preview.canApply, true);
  assert.equal(preview.groups[0]?.name, 'PreviewOnly');
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforePreview, '预览不得写入配置');

  // 10) 无效导入在后端再次校验并拒绝。
  const beforeInvalidImport = await service.reload();
  await assert.rejects(
    () =>
      service.importGroups(
        {
          name: 'InvalidImport',
          vendor: 'customendpoint',
          models: [
            {
              id: 'bad',
              name: 'Bad',
              url: 'https://x.test/v1/chat/completions',
              contextWindow: 100,
              maxInputTokens: 900,
              maxOutputTokens: 100,
              toolCalling: true,
              vision: false,
              streaming: true,
            },
          ],
        },
        beforeInvalidImport.fingerprint,
      ),
    /未通过校验/,
  );

  // 11) 分组统一接口：写入 baseUrl/apiType，重写全部模型地址并保留凭据引用。
  const beforeGroupSettings = await service.reload();
  await service.saveGroupSettings(
    { vendor: 'customendpoint', groupName: 'ProbeGroup' },
    'https://group.example.com/v1/chat/completions',
    'responses',
    false,
    beforeGroupSettings.fingerprint,
  );
  const afterGroupSettings = read();
  const probeWithEndpoint = afterGroupSettings.find((group) => group.name === 'ProbeGroup');
  assert.equal(probeWithEndpoint.baseUrl, 'https://group.example.com/v1');
  assert.equal(probeWithEndpoint.apiType, 'responses');
  assert.equal(probeWithEndpoint.apiKey, '${input:chat.lm.secret.old}', '分组设置不应改动凭据引用');
  for (const model of probeWithEndpoint.models) {
    assert.equal(model.url, 'https://group.example.com/v1/responses');
    assert.equal('apiType' in model, false, '模型级 apiType 应被移除');
  }

  // 12) 模型保存沿用分组接口，忽略表单里的地址与类型。
  const beforeGroupModel = await service.reload();
  const managedGroup = beforeGroupModel.groups.find((group) => group.name === 'ProbeGroup');
  const managedModel = managedGroup.models.find((model) => model.id === 'existing');
  assert.ok(managedModel);
  await service.saveDraft(
    {
      ...managedModel,
      name: 'Group Managed',
      url: 'https://ignored.example.com/v1/chat/completions',
      apiType: 'chat-completions',
    },
    beforeGroupModel.fingerprint,
    { vendor: 'customendpoint', groupName: 'ProbeGroup', id: managedModel.id },
  );
  const afterManagedSave = read().find((group) => group.name === 'ProbeGroup');
  const savedManaged = afterManagedSave.models.find((model) => model.id === managedModel.id);
  assert.equal(savedManaged.name, 'Group Managed');
  assert.equal(savedManaged.url, 'https://group.example.com/v1/responses');
  assert.equal('apiType' in savedManaged, false);

  // 13) 清除分组凭据引用，其余模型保留。
  const beforeClear = await service.reload();
  await service.clearApiKey('customendpoint', 'ProbeGroup', beforeClear.fingerprint);
  const afterClear = read();
  const probeAfterClear = afterClear.find((group) => group.name === 'ProbeGroup');
  assert.equal('apiKey' in probeAfterClear, false);
  assert.ok(probeAfterClear.models.length > 0, '清除凭据不应删除模型');

  // 14) 无认证分组中的模型按“无需认证”再次保存，不被要求补密钥。
  const noAuthSnapshot = await service.reload();
  const noAuthGroup = noAuthSnapshot.groups.find((group) => group.name === 'ProbeGroup');
  assert.ok(noAuthGroup);
  assert.equal(noAuthGroup.hasApiKey, false);
  const noAuthModel = noAuthGroup.models[0];
  assert.equal(noAuthModel.credentialMode, 'none', '分组无凭据时模型应解析为无需认证');
  await service.saveDraft(
    { ...noAuthModel, name: 'No Auth Model' },
    noAuthSnapshot.fingerprint,
    { vendor: 'customendpoint', groupName: 'ProbeGroup', id: noAuthModel.id },
  );
  const afterNoAuth = await service.reload();
  const noAuthSaved = afterNoAuth.groups
    .find((group) => group.name === 'ProbeGroup')
    .models.find((model) => model.id === noAuthModel.id);
  assert.equal(noAuthSaved.name, 'No Auth Model');
  assert.equal(noAuthSaved.credentialMode, 'none');
  assert.equal('apiKey' in read().find((group) => group.name === 'ProbeGroup'), false);

  // 15) 更新分组密钥与其它写入路径一致：过期快照必须拒绝，不覆盖外部修改。
  await assert.rejects(
    () => service.updateApiKey('customendpoint', 'ProbeGroup', 'stale-key-123', snapshot.fingerprint),
    (error) => /外部修改/.test(String(error.message)),
  );

  // 16) 快照最新但宿主缺少 Copilot 时，密钥写入失败且不落盘。
  const keySnapshot = await service.reload();
  const beforeKeyUpdateText = fs.readFileSync(configPath, 'utf8');
  await assert.rejects(
    () => service.updateApiKey('customendpoint', 'ProbeGroup', 'hostless-key-456', keySnapshot.fingerprint),
    (error) => /API Key/.test(String(error.message)),
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeKeyUpdateText, '密钥写入失败不得改动配置');
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('hostless-key-456'), false);

  // 17) 侧边栏内联按钮传入的是树元素而非模型记录：命令必须能按 ref 定位并删除。
  const settings = vscode.workspace.getConfiguration('copilotModelManager');
  await settings.update('confirmBeforeDelete', false, vscode.ConfigurationTarget.Global);
  const beforeInline = await service.reload();
  const inlineModel = beforeInline.groups.find((group) => group.name === 'ProbeGroup')?.models[0];
  assert.ok(inlineModel, '前置条件：ProbeGroup 应包含模型');
  const addedInline = await service.saveDraft(
    {
      ...inlineModel,
      id: 'inline-delete',
      name: 'Inline Delete',
    },
    beforeInline.fingerprint,
  );
  assert.ok(
    addedInline.groups.some((group) => group.models.some((model) => model.id === 'inline-delete')),
    '前置条件：模型应已保存',
  );
  class FakeModelLeaf extends vscode.TreeItem {
    constructor(model) {
      super(model.name || model.id, vscode.TreeItemCollapsibleState.None);
      this.model = model;
      this.ref = { vendor: model.vendor, groupName: model.groupName, id: model.id };
      this.contextValue = 'copilotModels.model';
    }
  }
  const treeElement = new FakeModelLeaf({
    id: 'inline-delete',
    name: 'Inline Delete',
    vendor: 'customendpoint',
    groupName: 'ProbeGroup',
  });
  await vscode.commands.executeCommand('copilotModels.deleteModel', treeElement);
  const afterInline = await service.reload();
  assert.equal(
    afterInline.groups.some((group) => group.models.some((model) => model.id === 'inline-delete')),
    false,
    '内联删除按钮必须真正删除目标模型',
  );
  await settings.update('confirmBeforeDelete', undefined, vscode.ConfigurationTarget.Global);

  console.log('集成用例全部通过（含侧边栏树元素 ref 回归）');
  fs.writeFileSync(configPath, JSON.stringify(original, null, '\t') + '\n', 'utf8');
}
