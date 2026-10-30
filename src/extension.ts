import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigFileStore } from './adapters/ConfigFileStore.ts';
import { CopilotConfigAdapter } from './adapters/CopilotConfigAdapter.ts';
import { ModelPanel } from './panel/ModelPanel.ts';
import { ModelTreeProvider, describeEmptyState, type ModelTreeItem } from './panel/ModelTreeProvider.ts';
import { ConnectionTester } from './services/ConnectionTester.ts';
import { ModelConfigService } from './services/ModelConfigService.ts';
import { groupRefOf, modelRefOf } from './models/refs.ts';
import type { GroupRef, ModelRef } from './models/modelConfig.ts';

export interface ExtensionApi {
  readonly version: string;
  readonly ready: Promise<void>;
  getService(): ModelConfigService | undefined;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel('Copilot 模型管理', { log: true });
  context.subscriptions.push(log);

  const store = ConfigFileStore.fromGlobalStorage(context.globalStorageUri.fsPath);
  const adapter = new CopilotConfigAdapter(store, log);
  const tester = new ConnectionTester(() =>
    vscode.workspace.getConfiguration('copilotModelManager').get<number>('connectionTimeoutSeconds', 15),
  );
  const service = new ModelConfigService(adapter, tester, log);
  const changeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(changeEmitter);

  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  // 初始化失败不阻塞命令注册，但会在首次使用时给出明确错误。
  let initializationError: unknown;
  const initialization = service
    .initialize()
    .then(() => {
      syncTree();
      readyResolve();
    })
    .catch((error: unknown) => {
      initializationError = error;
      log.error(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
      readyResolve();
    });

  const refresh = async (): Promise<void> => {
    await initialization;
    await service.reload();
    changeEmitter.fire();
  };

  const panelContext = { service, log, onDidChange: changeEmitter.event };

  const showInitializationError = (): void => {
    void vscode.window.showErrorMessage(
      `无法读取 Copilot 模型配置：${initializationError instanceof Error ? initializationError.message : String(initializationError)}`,
    );
  };

  const openPanel = (
    mode: 'open' | 'add' | 'copy',
    target: { ref?: ModelRef; group?: GroupRef } = {},
  ): void => {
    if (initializationError) {
      showInitializationError();
      return;
    }
    ModelPanel.show(context.extensionUri, panelContext, mode, target);
  };

  const treeProvider = new ModelTreeProvider();
  let treeView: vscode.TreeView<ModelTreeItem> | undefined;
  try {
    treeView = vscode.window.createTreeView('copilotModels.sidebar', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });
  } catch (error) {
    log.warn(`侧边栏视图不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  const syncTree = (): void => {
    treeProvider.update(service.currentSnapshot);
    if (treeView) {
      treeView.description = describeEmptyState(service.currentSnapshot);
    }
  };
  if (treeView) {
    context.subscriptions.push(treeView);
  }
  context.subscriptions.push(changeEmitter.event(() => syncTree()));

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotModels.open', () => openPanel('open')),
    vscode.commands.registerCommand('copilotModels.add', () => openPanel('add')),
    vscode.commands.registerCommand('copilotModels.openModel', (value?: unknown) => {
      const ref = modelRefOf(value);
      if (!ref) {
        openPanel('open');
        return;
      }
      openPanel('open', { ref });
    }),
    vscode.commands.registerCommand('copilotModels.copyModel', (value?: unknown) => {
      const ref = modelRefOf(value);
      if (!ref) {
        openPanel('open');
        return;
      }
      openPanel('copy', { ref });
    }),
    vscode.commands.registerCommand('copilotModels.openGroup', (value?: unknown) => {
      const group = groupRefOf(value);
      if (!group) {
        openPanel('open');
        return;
      }
      openPanel('open', { group });
    }),
    vscode.commands.registerCommand('copilotModels.deleteModel', async (value?: unknown) => {
      const ref = modelRefOf(value);
      if (!ref) {
        // 内联按钮传入的是树元素；解析失败说明条目已过期，必须提示而不是静默返回。
        void vscode.window.showWarningMessage('无法识别要删除的模型，请刷新侧边栏后重试。');
        return;
      }
      await initialization;
      const snapshot = service.currentSnapshot;
      if (!snapshot) {
        return;
      }
      const target = snapshot.groups
        .find((group) => group.vendor === ref.vendor && group.name === ref.groupName)
        ?.models.find((model) => model.id === ref.id);
      if (!target) {
        void vscode.window.showWarningMessage(`模型“${ref.id}”已不存在，请刷新侧边栏后重试。`);
        return;
      }
      const label = target.name || target.id;
      const confirm = vscode.workspace.getConfiguration('copilotModelManager').get<boolean>('confirmBeforeDelete', true);
      if (confirm) {
        const choice = await vscode.window.showWarningMessage(
          `确定删除模型“${label}”吗？此操作会修改 Copilot 配置。`,
          { modal: true },
          '删除',
        );
        if (choice !== '删除') {
          return;
        }
      }
      try {
        await service.deleteModel(ref, snapshot.fingerprint);
        changeEmitter.fire();
        void vscode.window.showInformationMessage(`已删除模型“${label}”。`);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('copilotModels.refresh', async () => {
      await refresh();
      void vscode.window.showInformationMessage('Copilot 模型配置已刷新。');
    }),
    vscode.commands.registerCommand('copilotModels.export', async () => {
      await initialization;
      const json = await service.export();
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: json });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand('copilotModels.importLegacy', async () => {
      await initialization;
      const snapshot = service.currentSnapshot;
      if (!snapshot || snapshot.legacyModels.length === 0) {
        void vscode.window.showInformationMessage('旧版设置中没有可导入的模型。');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `将从旧版设置导入 ${snapshot.legacyModels.length} 个模型到面板（不会删除旧设置）。`,
        { modal: true },
        '导入',
      );
      if (choice !== '导入') {
        return;
      }
      try {
        const result = await service.importLegacy(snapshot.fingerprint);
        changeEmitter.fire();
        void vscode.window.showInformationMessage(
          `已导入 ${result.count} 个模型到分组“${result.groupName}”${result.strippedCredentials ? '；旧设置中的明文密钥已被移除，请重新设置' : ''}。`,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('copilotModels.openConfigFile', async () => {
      await initialization;
      await service.openConfigFile();
    }),
    vscode.commands.registerCommand('copilotModels.openDashboard', async () => {
      await initialization;
      try {
        await service.openDashboard();
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('copilotModels.openBackups', async () => {
      await initialization;
      await service.openBackupFolder();
    }),
    vscode.commands.registerCommand('copilotModels.openLegacySetting', async () => {
      await initialization;
      await service.openLegacySetting();
    }),
  );

  const configPath = store.filePath;
  const configUri = vscode.Uri.file(configPath);
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(configPath)), path.basename(configPath)),
  );
  const onFileChange = async (): Promise<void> => {
    if (initializationError) {
      return;
    }
    await service.reload();
    changeEmitter.fire();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => void onFileChange()),
    watcher.onDidCreate(() => void onFileChange()),
    watcher.onDidDelete(() => void onFileChange()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.toString() === configUri.toString()) {
        void onFileChange();
      }
    }),
    adapter.onDidChangeLegacy(() => void onFileChange()),
  );

  return {
    version: String(context.extension.packageJSON.version ?? '0.0.0'),
    ready,
    getService: () => (initializationError ? undefined : service),
  };
}

export function deactivate(): void {
  ModelPanel.disposeCurrent();
}
