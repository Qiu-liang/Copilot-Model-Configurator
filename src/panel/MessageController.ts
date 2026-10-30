import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  isRequestFailure,
  parseWebviewRequest,
  RequestLedger,
  type ErrorCode,
  type ExtensionMessage,
  type RequestError,
  type RequestType,
  type WebviewRequest,
} from './protocol.ts';
import {
  ConfigUnavailableError,
  CredentialWriteError,
  ModelConfigService,
  SnapshotConflictError,
  ValidationFailure,
} from '../services/ModelConfigService.ts';
import { ConfigParseError } from '../models/configDocument.ts';
import { ConfigParseFailure } from '../adapters/ConfigFileStore.ts';
import { redactText } from '../services/redact.ts';

export interface ControllerHost {
  post(message: ExtensionMessage): Promise<void>;
  pushState(): Promise<void>;
  setDirty(dirty: boolean): void;
  onWebviewReady(): void;
  log: vscode.LogOutputChannel;
}

const BUSY_MESSAGES: Partial<Record<RequestType, string>> = {
  'config/save': '正在保存模型…',
  'config/delete': '正在删除模型…',
  'config/deleteGroup': '正在删除分组…',
  'config/importApply': '正在导入分组…',
  'legacy/import': '正在导入旧版设置…',
  'group/promptApiKey': '正在保存 API Key…',
  'group/clearApiKey': '正在清除分组凭据…',
  'group/create': '正在创建分组…',
  'group/save': '正在保存分组设置…',
};

const PUSH_STATE_ON_ERROR: readonly ErrorCode[] = ['conflict', 'credential', 'unavailable'];

export class MessageController {
  private readonly host: ControllerHost;
  private readonly service: ModelConfigService;
  private readonly ledger = new RequestLedger();
  private readonly confirmedTestTargets = new Set<string>();

  constructor(host: ControllerHost, service: ModelConfigService) {
    this.host = host;
    this.service = service;
  }

  async handle(raw: unknown): Promise<void> {
    const parsed = parseWebviewRequest(raw);
    if (isRequestFailure(parsed)) {
      this.host.log.warn(`拒绝消息：${parsed.error.code}`);
      if (parsed.requestId) {
        await this.respond(parsed.requestId, false, undefined, parsed.error);
      }
      return;
    }
    if (!this.ledger.accept(parsed.requestId)) {
      await this.respond(parsed.requestId, false, undefined, {
        code: 'duplicate',
        message: '重复的请求已被拒绝。',
      });
      return;
    }

    const busyMessage = BUSY_MESSAGES[parsed.type];
    if (busyMessage) {
      await this.host.post({ type: 'busy', payload: { busy: true, message: busyMessage } });
    }
    try {
      const data = await this.dispatch(parsed);
      await this.respond(parsed.requestId, true, data);
    } catch (error) {
      const requestError = this.toRequestError(error);
      if (requestError.code === 'validation' && requestError.issues) {
        await this.host.post({
          type: 'issues',
          requestId: parsed.requestId,
          payload: { issues: requestError.issues },
        });
      }
      if (PUSH_STATE_ON_ERROR.includes(requestError.code)) {
        await this.host.pushState().catch(() => undefined);
      }
      this.host.log.warn(`${parsed.type} 失败：${requestError.code}`);
      await this.respond(parsed.requestId, false, undefined, requestError);
    } finally {
      if (busyMessage) {
        await this.host.post({ type: 'busy', payload: { busy: false } });
      }
    }
  }

  private async dispatch(request: WebviewRequest): Promise<unknown> {
    switch (request.type) {
      case 'config/list':
      case 'ui/refresh': {
        await this.service.reload();
        await this.host.pushState();
        this.host.onWebviewReady();
        return {};
      }
      case 'config/save': {
        const { draft, expectedFingerprint, original } = request.payload;
        await this.service.saveDraft(draft, expectedFingerprint, original);
        await this.host.pushState();
        return {
          ref: {
            vendor: draft.vendor,
            groupName: draft.groupName.trim(),
            id: draft.id.trim(),
          },
        };
      }
      case 'config/delete': {
        const { ref, expectedFingerprint } = request.payload;
        if (await this.confirmDelete(`确定删除模型“${ref.id}”吗？此操作会修改 Copilot 配置。`, '删除')) {
          await this.service.deleteModel(ref, expectedFingerprint);
          await this.host.pushState();
        }
        return {};
      }
      case 'config/deleteGroup': {
        const { group, expectedFingerprint } = request.payload;
        const confirmed = await this.confirmDelete(
          `确定删除分组“${group.groupName}”吗？分组中的全部模型与凭据引用都会被删除；VS Code 密钥存储中的密钥不会由扩展清除。`,
          '删除分组',
        );
        if (confirmed) {
          await this.service.deleteGroup(group.vendor, group.groupName, expectedFingerprint);
          await this.host.pushState();
        }
        return {};
      }
      case 'group/create': {
        const { vendor, name, baseUrl, apiType, allowInsecureHttp, credentialMode, apiKey, expectedFingerprint } =
          request.payload;
        await this.service.createGroup(
          vendor,
          name,
          baseUrl,
          apiType,
          allowInsecureHttp,
          credentialMode === 'apiKey' ? { mode: 'apiKey', apiKey: apiKey ?? '' } : { mode: 'none' },
          expectedFingerprint,
        );
        await this.host.pushState();
        return { group: { vendor, groupName: name.trim() } };
      }
      case 'group/save': {
        const { group, baseUrl, apiType, allowInsecureHttp, expectedFingerprint } = request.payload;
        await this.service.saveGroupSettings(group, baseUrl, apiType, allowInsecureHttp, expectedFingerprint);
        await this.host.pushState();
        return {};
      }
      case 'group/promptApiKey': {
        const { group, expectedFingerprint } = request.payload;
        const existing = this.service.currentSnapshot?.groups.find(
          (entry) => entry.vendor === group.vendor && entry.name === group.groupName,
        );
        const apiKey = await vscode.window.showInputBox({
          title: `更新“${group.groupName}”的 API Key`,
          prompt: existing?.hasApiKey
            ? '输入新 Key 覆盖现有凭据；输入内容不会进入面板或日志。'
            : '输入该分组使用的 API Key。',
          password: true,
          ignoreFocusOut: true,
          placeHolder: 'API Key',
          validateInput: (value) => (value.trim() ? undefined : 'API Key 不能为空。'),
        });
        if (!apiKey) {
          throw new CanceledError();
        }
        await this.service.updateApiKey(group.vendor, group.groupName, apiKey, expectedFingerprint);
        await this.host.pushState();
        return {};
      }
      case 'group/clearApiKey': {
        const { group, expectedFingerprint } = request.payload;
        const choice = await vscode.window.showWarningMessage(
          `确定清除分组“${group.groupName}”的凭据引用吗？这不会删除 VS Code 密钥存储中的密钥，但该分组的模型将无法再认证。`,
          { modal: true },
          '清除凭据',
        );
        if (choice !== '清除凭据') {
          throw new CanceledError();
        }
        await this.service.clearApiKey(group.vendor, group.groupName, expectedFingerprint);
        await this.host.pushState();
        return {};
      }
      case 'connection/test': {
        const { draft } = request.payload;
        const target = `${draft.vendor}\u0000${draft.groupName}\u0000${draft.url}\u0000${draft.id}`;
        if (
          vscode.workspace.getConfiguration('copilotModelManager').get<boolean>('confirmTestRequest', true) &&
          !this.confirmedTestTargets.has(target)
        ) {
          const choice = await vscode.window.showWarningMessage(
            '连接测试会向你填写的第三方地址发送一条最小测试消息，可能产生少量费用。确定要发送吗？',
            { modal: true },
            '发送测试请求',
          );
          if (choice !== '发送测试请求') {
            throw new CanceledError('已取消连接测试。');
          }
          this.confirmedTestTargets.add(target);
        }
        return this.service.testDraft(draft);
      }
      case 'connection/cancel': {
        return { canceled: this.service.cancelTest() };
      }
      case 'config/export': {
        const json = await this.service.export();
        if (request.payload.copy) {
          await vscode.env.clipboard.writeText(json);
        }
        return { json, copied: Boolean(request.payload.copy) };
      }
      case 'config/exportSave': {
        const target = await vscode.window.showSaveDialog({
          title: '导出模型配置（不含 API Key）',
          filters: { JSON: ['json'] },
          saveLabel: '导出',
        });
        if (!target) {
          throw new CanceledError();
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.payload.json);
        } catch {
          throw new ConfigParseError('导出内容不是有效 JSON，已取消保存。');
        }
        await fs.writeFile(target.fsPath, `${JSON.stringify(parsed, undefined, 2)}\n`, 'utf8');
        return { path: target.fsPath };
      }
      case 'config/import': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.payload.json);
        } catch (error) {
          throw new ConfigParseError(
            `导入内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return this.service.previewImport(parsed);
      }
      case 'config/importApply': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.payload.json);
        } catch (error) {
          throw new ConfigParseError(
            `导入内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const result = await this.service.importGroups(parsed, request.payload.expectedFingerprint);
        await this.host.pushState();
        return { strippedCredentials: result.strippedCredentials };
      }
      case 'legacy/import': {
        const legacy = this.service.currentSnapshot?.legacyModels ?? [];
        if (legacy.length === 0) {
          throw new ConfigParseError('旧版设置中没有可导入的模型。');
        }
        const choice = await vscode.window.showWarningMessage(
          `将从旧版设置导入 ${legacy.length} 个模型到面板（不会删除旧设置）。导入后请在 Copilot 模型选择器中确认。`,
          { modal: true },
          '导入',
        );
        if (choice !== '导入') {
          throw new CanceledError();
        }
        const result = await this.service.importLegacy(request.payload.expectedFingerprint);
        await this.host.pushState();
        return {
          count: result.count,
          groupName: result.groupName,
          strippedCredentials: result.strippedCredentials,
        };
      }
      case 'legacy/openSetting': {
        await this.service.openLegacySetting();
        return {};
      }
      case 'panel/openOfficial': {
        await this.service.openDashboard();
        return {};
      }
      case 'panel/openConfigFile': {
        await this.service.openConfigFile();
        return {};
      }
      case 'panel/openBackups': {
        await this.service.openBackupFolder();
        return {};
      }
      case 'ui/dirty': {
        this.host.setDirty(request.payload.dirty);
        return {};
      }
    }
  }

  private async confirmDelete(message: string, label: string): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('copilotModelManager').get<boolean>('confirmBeforeDelete', true)) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, label);
    if (choice !== label) {
      throw new CanceledError();
    }
    return true;
  }

  private toRequestError(error: unknown): RequestError {
    if (error instanceof CanceledError) {
      return { code: 'canceled', message: error.message };
    }
    if (error instanceof ValidationFailure) {
      return {
        code: 'validation',
        message: '服务器拒绝了保存：请修正标出的问题。',
        issues: error.issues,
      };
    }
    if (error instanceof SnapshotConflictError) {
      return { code: 'conflict', message: error.message };
    }
    if (error instanceof CredentialWriteError) {
      return { code: 'credential', message: redactText(error.message) };
    }
    if (error instanceof ConfigUnavailableError) {
      return { code: 'unavailable', message: error.message };
    }
    if (error instanceof ConfigParseError) {
      return { code: 'config', message: redactText(error.message) };
    }
    if (error instanceof ConfigParseFailure) {
      return { code: 'config', message: redactText(error.message) };
    }
    const message = error instanceof Error ? error.message : String(error);
    this.host.log.warn(`未分类错误：${error instanceof Error ? error.name : 'Unknown'}`);
    return { code: 'unknown', message: redactText(message) };
  }

  private async respond(requestId: string, ok: boolean, data?: unknown, error?: RequestError): Promise<void> {
    await this.host.post({ type: 'response', requestId, ok, data, error });
  }
}

class CanceledError extends Error {
  constructor(message = '操作已取消。') {
    super(message);
    this.name = 'CanceledError';
  }
}
