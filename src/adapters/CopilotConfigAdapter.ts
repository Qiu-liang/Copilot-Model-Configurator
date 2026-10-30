import * as vscode from 'vscode';
import type { AdapterReadResult } from './ConfigFileStore.ts';
import { ConfigFileStore } from './ConfigFileStore.ts';
import { CurrentGroupAdapter, CredentialWriteError } from './CurrentGroupAdapter.ts';
import { LegacySettingsAdapter } from './LegacySettingsAdapter.ts';
import { ProviderRegistry, type ModelCapabilities } from './ProviderRegistry.ts';
import type { LegacyModelInput } from '../models/configDocument.ts';
import { VENDOR_LABELS, type VendorId, type VendorInfo } from '../models/modelConfig.ts';
import type { RawGroup } from '../models/configDocument.ts';

const MANAGE_COMMAND = 'workbench.action.chat.manage';

export interface AdapterCapabilities {
  hasMigrateCommand: boolean;
  credentialWriteEnabled: boolean;
  dashboardAvailable: boolean;
  preferredVendor: VendorId;
  vendors: VendorId[];
  vendorInfo: VendorInfo[];
  copilotVersion?: string;
  providerMessage?: string;
}

/**
 * Copilot 配置的唯一读写边界：分组文件、凭据命令、旧版设置与提供方能力
 * 都集中在这里。业务层不直接接触文件或内部命令。
 */
export class CopilotConfigAdapter {
  readonly current: CurrentGroupAdapter;
  readonly legacy: LegacySettingsAdapter;
  readonly registry: ProviderRegistry;

  private migrateProbe: boolean | undefined;
  private dashboardProbe: boolean | undefined;

  constructor(store: ConfigFileStore, log: vscode.LogOutputChannel) {
    this.current = new CurrentGroupAdapter(store, {
      log,
      backupCount: () => vscode.workspace.getConfiguration('copilotModelManager').get<number>('backupCount', 10),
    });
    this.legacy = new LegacySettingsAdapter();
    this.registry = new ProviderRegistry();
  }

  async initialize(): Promise<void> {
    await this.registry.initialize();
    await this.refreshCommandProbes();
  }

  get filePath(): string {
    return this.current.filePath;
  }

  get backupDirectory(): string {
    return this.current.backupDirectory;
  }

  get copilotVersion(): string | undefined {
    return this.registry.version;
  }

  async read(): Promise<AdapterReadResult> {
    return this.current.read();
  }

  async writeGroups(raw: AdapterReadResult, groups: readonly RawGroup[]): Promise<void> {
    await this.current.writeGroups(raw, groups);
  }

  async writeWithCredential(
    raw: AdapterReadResult,
    groups: readonly RawGroup[],
    vendor: VendorId,
    groupName: string,
    apiKey: string,
  ): Promise<void> {
    await this.current.writeWithCredential(raw, groups, vendor, groupName, apiKey);
  }

  hasMigrateCommand(): boolean {
    return this.migrateProbe ?? false;
  }

  async refreshCommandProbes(): Promise<void> {
    this.migrateProbe = await this.current.hasMigrateCommand();
    try {
      const commands = await vscode.commands.getCommands(true);
      this.dashboardProbe = commands.includes(MANAGE_COMMAND);
    } catch {
      this.dashboardProbe = false;
    }
  }

  capabilities(): AdapterCapabilities {
    const descriptors = this.registry.list();
    const providerVendors = this.registry.availableVendors();
    const vendors: VendorId[] =
      providerVendors.length > 0 ? providerVendors : ['customendpoint', 'customoai'];
    const vendorInfo = vendors.map((vendor) => this.vendorInfo(vendor));
    return {
      hasMigrateCommand: this.migrateProbe ?? false,
      credentialWriteEnabled: (this.migrateProbe ?? false) && Boolean(vscode.extensions.getExtension('GitHub.copilot-chat')),
      dashboardAvailable: this.dashboardProbe ?? false,
      preferredVendor: this.registry.preferredVendor(),
      vendors,
      vendorInfo,
      copilotVersion: this.registry.version,
      providerMessage:
        descriptors.length === 0
          ? '未检测到 GitHub Copilot Chat 扩展。配置仍可编辑，但模型选择器要安装 Copilot 后才会出现。'
          : undefined,
    };
  }

  vendorInfo(vendor: VendorId): VendorInfo {
    const descriptor = this.registry.get(vendor);
    if (descriptor) {
      return {
        vendor,
        label: descriptor.displayName || VENDOR_LABELS[vendor],
        deprecated: descriptor.deprecated,
        available: descriptor.supported,
        supportsModelApiType: descriptor.modelCapabilities.supportsApiType,
        supportsReasoningEffortFormat: descriptor.modelCapabilities.supportsReasoningEffortFormat,
        supportsDefaultReasoningEffort: descriptor.modelCapabilities.supportsDefaultReasoningEffort,
      };
    }
    return {
      vendor,
      label: VENDOR_LABELS[vendor],
      deprecated: vendor === 'customoai',
      available: false,
      supportsModelApiType: vendor === 'customendpoint',
      supportsReasoningEffortFormat: vendor === 'customendpoint',
      supportsDefaultReasoningEffort: false,
    };
  }

  modelCapabilities(vendor: VendorId): ModelCapabilities {
    const info = this.vendorInfo(vendor);
    return {
      supportsApiType: info.supportsModelApiType,
      supportsReasoningEffort: true,
      supportsReasoningEffortFormat: info.supportsReasoningEffortFormat,
      supportsThinking: true,
      supportsDefaultReasoningEffort: info.supportsDefaultReasoningEffort,
    };
  }

  readLegacyModels(): LegacyModelInput[] {
    return this.legacy.read();
  }

  onDidChangeLegacy(listener: () => void): vscode.Disposable {
    return this.legacy.onDidChange(listener);
  }

  async openConfigFile(): Promise<void> {
    await this.current.openConfigFile();
  }

  async openBackupFolder(): Promise<void> {
    await this.current.openBackupFolder();
  }

  async openLegacySetting(): Promise<void> {
    await this.legacy.openSetting();
  }

  async openOfficialManagement(): Promise<void> {
    if (this.dashboardProbe === undefined) {
      await this.refreshCommandProbes();
    }
    if (!this.dashboardProbe) {
      throw new Error('当前 VS Code 版本没有提供 Copilot 模型管理界面。');
    }
    await vscode.commands.executeCommand(MANAGE_COMMAND);
  }

  async hasUnsavedConfigChanges(): Promise<boolean> {
    return this.current.hasUnsavedConfigChanges();
  }

  overrideProviderCapabilitiesForTesting(vendor: VendorId, capabilities: Partial<ModelCapabilities>): void {
    this.registry.overrideForTesting(vendor, capabilities);
  }
}

export { CredentialWriteError };
