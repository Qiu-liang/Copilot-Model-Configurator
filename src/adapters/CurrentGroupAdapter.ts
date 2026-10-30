import * as vscode from 'vscode';
import {
  ConfigParseError,
  findGroup,
  groupModels,
  removeGroup as removeGroupFromDocument,
  serializeGroups,
  type RawGroup,
} from '../models/configDocument.ts';
import { ConfigFileStore, asMessage, type AdapterReadResult } from './ConfigFileStore.ts';
import { redactText } from '../services/redact.ts';

const MIGRATE_COMMAND = 'lm.migrateLanguageModelsProviderGroup';

export class CredentialWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialWriteError';
  }
}

export interface CurrentGroupAdapterOptions {
  log: vscode.LogOutputChannel;
  backupCount: () => number;
}

/**
 * 当前 VS Code Profile 的语言模型分组的唯一读写实现。
 *
 * 普通保存直接原子写配置文件，以最大程度保留未知字段；
 * 新 API Key 必须由 VS Code 核心加密保存，因此调用内部 migrate 命令重建分组。
 */
export class CurrentGroupAdapter {
  private readonly store: ConfigFileStore;
  private readonly options: CurrentGroupAdapterOptions;

  constructor(store: ConfigFileStore, options: CurrentGroupAdapterOptions) {
    this.store = store;
    this.options = options;
  }

  get filePath(): string {
    return this.store.filePath;
  }

  get backupDirectory(): string {
    return this.store.backupDirectory();
  }

  async read(): Promise<AdapterReadResult> {
    return this.store.read();
  }

  async writeGroups(raw: AdapterReadResult, groups: readonly RawGroup[]): Promise<void> {
    if (await this.hasUnsavedConfigChanges()) {
      throw new Error('chatLanguageModels.json 在编辑器中有未保存的修改，请先保存或撤销后再操作。');
    }
    if (raw.exists) {
      const keep = this.options.backupCount();
      if (keep > 0) {
        const before = raw.text ?? serializeGroups(raw.groups);
        const backup = await this.store.createBackup(before, keep);
        if (backup) {
          this.options.log.info(`已备份配置到 ${backup}`);
        }
      }
    }
    const result = await this.store.write(groups);
    this.options.log.info(`已写入 ${groups.length} 个分组（${result.bytesWritten} bytes）。`);
  }

  /**
   * 有新的 API Key 时必须交给 VS Code 处理，因为只有它能写入核心密钥存储：
   * 先保留模型配置写出分组、移除目标分组，再通过官方 migrate 命令重建分组。
   * 重建失败则恢复原分组，避免丢失配置。
   */
  async writeWithCredential(
    raw: AdapterReadResult,
    groups: readonly RawGroup[],
    vendor: string,
    groupName: string,
    apiKey: string,
  ): Promise<void> {
    const target = findGroup(groups, vendor, groupName);
    if (!target) {
      throw new ConfigParseError(`找不到分组“${groupName}”。`);
    }

    // 命令不存在时必须在任何写入前失败，避免“模型已存但密钥丢失”的半成品状态。
    await this.assertCredentialWritable();

    const payload: Record<string, unknown> = {
      vendor,
      name: groupName,
      ...toProviderPayload(target),
      models: groupModels(target),
      apiKey,
    };
    if (target['settings'] !== undefined) {
      payload['settings'] = target['settings'];
    }

    // 1) 先落盘模型改动，仍保留旧密钥引用；即使随后密钥写入失败，模型配置也不会丢。
    await this.writeGroups(raw, groups);

    if (!findGroup(raw.groups, vendor, groupName)) {
      try {
        await this.runMigrate(payload);
        await this.verifyCredential(groups, vendor, groupName, apiKey);
        return;
      } catch (error) {
        const message = redactText(asMessage(error), [apiKey]);
        throw new CredentialWriteError(
          `模型配置已保存，但 API Key 未能写入：${message}。可在官方模型管理中更新该分组的 Key。`,
        );
      }
    }

    // 2) 目标分组已存在：VS Code 的分组注册会拒绝重名，需临时移除后再重建。
    // 移除前同样走 writeGroups，确保“临时移除”状态也有备份可恢复。
    const fresh = await this.store.read();
    const withoutGroup = removeGroupFromDocument(fresh.groups, vendor, groupName);
    await this.writeGroups(fresh, withoutGroup);
    try {
      await this.runMigrate(payload);
      await this.verifyCredential(groups, vendor, groupName, apiKey);
    } catch (error) {
      // 3) 失败时恢复“模型已更新、仍用旧密钥”的状态。
      await this.store.write(groups);
      const message = redactText(asMessage(error), [apiKey]);
      this.options.log.warn(`凭据写入失败，已恢复分组“${groupName}”并使用原密钥引用：${message}`);
      throw new CredentialWriteError(
        `模型配置已保存，但 API Key 未能写入：${message}。可在官方模型管理中更新该分组的 Key。`,
      );
    }
  }

  async hasMigrateCommand(): Promise<boolean> {
    try {
      const commands = await vscode.commands.getCommands(true);
      return commands.includes(MIGRATE_COMMAND);
    } catch {
      return false;
    }
  }

  async assertCredentialWritable(): Promise<void> {
    if (!(await this.hasMigrateCommand())) {
      throw new CredentialWriteError(
        '当前 VS Code 版本不支持通过命令保存 API Key。模型配置未写入，请在官方模型管理中设置该分组的 Key。',
      );
    }
    const copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!copilot) {
      throw new CredentialWriteError(
        '未安装 GitHub Copilot Chat，无法保存 API Key。模型配置未写入；请安装并启用 Copilot 后重试。',
      );
    }
    if (!copilot.isActive) {
      try {
        await copilot.activate();
      } catch (error) {
        throw new CredentialWriteError(
          `GitHub Copilot Chat 无法激活，API Key 未保存：${asMessage(error)}。模型配置未写入。`,
        );
      }
    }
  }

  async hasUnsavedConfigChanges(): Promise<boolean> {
    const uri = vscode.Uri.file(this.store.filePath).toString();
    return vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri && document.isDirty);
  }

  async openConfigFile(): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.store.filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openBackupFolder(): Promise<void> {
    const dir = this.store.backupDirectory();
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  }

  private async runMigrate(payload: Record<string, unknown>): Promise<void> {
    // 文件监听是异步的：刚删除的旧分组可能仍在 VS Code 内存中。
    // 遇到“分组已存在”时短暂等待后重试，而不是直接失败。
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await vscode.commands.executeCommand(MIGRATE_COMMAND, payload);
        return;
      } catch (error) {
        lastError = error;
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
        await delay(200 + 100 * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async verifyCredential(
    expectedGroups: readonly RawGroup[],
    vendor: string,
    groupName: string,
    apiKey: string,
  ): Promise<void> {
    const written = await this.store.read();
    const group = findGroup(written.groups, vendor, groupName);
    if (!group) {
      throw new Error(`分组“${groupName}”在凭据写入后不存在。`);
    }
    const stored = group['apiKey'];
    if (typeof stored === 'string' && stored.trim() === apiKey.trim()) {
      throw new Error('密钥以明文形式出现在配置文件中，已中止。');
    }
    const expected = findGroup(expectedGroups, vendor, groupName);
    const writtenIds = groupModels(group)
      .map((model) => (typeof model['id'] === 'string' ? model['id'] : ''))
      .filter((id) => id.length > 0)
      .sort();
    const expectedIds = (expected ? groupModels(expected) : [])
      .map((model) => (typeof model['id'] === 'string' ? model['id'] : ''))
      .filter((id) => id.length > 0)
      .sort();
    if (writtenIds.length !== expectedIds.length || writtenIds.some((id, index) => id !== expectedIds[index])) {
      throw new Error('分组模型与预期不一致。');
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists/i.test(asMessage(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toProviderPayload(group: RawGroup): Record<string, unknown> {
  const {
    models: _models,
    range: _range,
    modelsRange: _modelsRange,
    settings: _settings,
    name: _name,
    vendor: _vendor,
    ...rest
  } = group;
  return rest;
}
