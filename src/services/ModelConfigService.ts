import * as vscode from 'vscode';
import {
  ConfigParseError,
  createSanitizedExport,
  findGroup,
  fingerprintOf,
  groupHasApiKey,
  groupModels,
  parseGroups,
  removeCredential,
  removeGroup as removeGroupFromDocument,
  removeModel as removeModelFromDocument,
  upsertModel,
  type RawGroup,
} from '../models/configDocument.ts';
import { applyDraftToRaw, isVendorId, parseRawModel, validateDraft, type ProviderCapabilities } from '../models/draft.ts';
import {
  buildImportPreview,
  legacyModelsToGroup,
  mergeImportedGroups,
  previewHasErrors,
  sanitizeImportedGroups,
} from '../models/importExport.ts';
import {
  LEGACY_GROUP_NAME,
  VENDOR_LABELS,
  type ConfigSnapshot,
  type ConnectionTestResult,
  type ImportPreview,
  type ModelDraft,
  type ModelRecord,
  type ModelRef,
  type ProviderGroup,
  type ValidationIssue,
  type VendorId,
  type VendorInfo,
} from '../models/modelConfig.ts';
import { asMessage } from '../adapters/ConfigFileStore.ts';
import { CredentialWriteError, type CopilotConfigAdapter } from '../adapters/CopilotConfigAdapter.ts';
import { ConnectionTester } from './ConnectionTester.ts';

export class SnapshotConflictError extends Error {
  constructor(message = '配置文件已在外部修改，请刷新后重试。') {
    super(message);
    this.name = 'SnapshotConflictError';
  }
}

export class ConfigUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigUnavailableError';
  }
}

export class ValidationFailure extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('；'));
    this.issues = issues;
    this.name = 'ValidationFailure';
  }
}

export { CredentialWriteError };

export interface LegacyImportResult {
  snapshot: ConfigSnapshot;
  count: number;
  groupName: string;
  strippedCredentials: boolean;
}

export class ModelConfigService {
  private readonly adapter: CopilotConfigAdapter;
  private readonly tester: ConnectionTester;
  private readonly log: vscode.LogOutputChannel;

  private snapshot: ConfigSnapshot | undefined;
  private rawGroups: RawGroup[] = [];
  private configError: string | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(adapter: CopilotConfigAdapter, tester: ConnectionTester, log: vscode.LogOutputChannel) {
    this.adapter = adapter;
    this.tester = tester;
    this.log = log;
  }

  async initialize(): Promise<void> {
    await this.adapter.initialize();
    await this.reload();
  }

  async reload(): Promise<ConfigSnapshot> {
    let exists = false;
    let text: string | undefined;
    try {
      const read = await this.adapter.read();
      this.rawGroups = read.groups;
      exists = read.exists;
      text = read.text;
      this.configError = undefined;
    } catch (error) {
      this.rawGroups = [];
      this.configError = asMessage(error);
      this.log.error(`读取模型配置失败：${this.configError}`);
    }
    this.snapshot = await this.buildSnapshot(text, exists, this.configError);
    return this.snapshot;
  }

  get currentSnapshot(): ConfigSnapshot | undefined {
    return this.snapshot;
  }

  get configFilePath(): string {
    return this.adapter.filePath;
  }

  get legacyGroupName(): string {
    return LEGACY_GROUP_NAME;
  }

  /** 供集成测试注入目标 Copilot 版本的能力声明；生产路径始终读取扩展清单。 */
  overrideCapabilitiesForTesting(vendor: VendorId, capabilities: Parameters<CopilotConfigAdapter['overrideProviderCapabilitiesForTesting']>[1]): void {
    this.adapter.overrideProviderCapabilitiesForTesting(vendor, capabilities);
  }

  providerCapabilities(vendor: VendorId): ProviderCapabilities {
    const capabilities = this.adapter.modelCapabilities(vendor);
    return {
      supportsModelApiType: capabilities.supportsApiType,
      supportsDefaultReasoningEffort: capabilities.supportsDefaultReasoningEffort,
      supportsReasoningEffortFormat: capabilities.supportsReasoningEffortFormat,
      supportsAdaptiveThinking: capabilities.supportsThinking,
    };
  }

  /** 兼容旧调用：返回默认提供方能力与仪表盘可用性。 */
  async capabilities(): Promise<{
    capabilities: ProviderCapabilities;
    dashboardAvailable: boolean;
    preferredVendor: VendorId;
  }> {
    if (!this.snapshot) {
      await this.reload();
    }
    const preferredVendor = this.adapter.registry.preferredVendor();
    return {
      capabilities: this.providerCapabilities(preferredVendor),
      dashboardAvailable: this.snapshot?.dashboardAvailable ?? false,
      preferredVendor,
    };
  }

  async saveDraft(draft: ModelDraft, expectedFingerprint: string, original?: ModelRef): Promise<ConfigSnapshot> {
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);

      const vendor = this.resolveVendor(draft.vendor);
      const groupName = draft.groupName.trim();
      const existingGroup = findGroup(raw.groups, vendor, groupName);
      const siblingIds = existingGroup
        ? groupModels(existingGroup)
            .map((model) => (typeof model['id'] === 'string' ? model['id'] : ''))
            .filter((id) => id.length > 0 && id !== original?.id)
        : [];

      const issues = validateDraft(draft, {
        siblingIds,
        existingGroupNames: raw.groups.filter((group) => group.vendor === vendor).map((group) => group.name),
        capabilities: this.providerCapabilities(vendor),
        groupExists: Boolean(existingGroup),
        groupHasCredential: existingGroup ? groupHasApiKey(existingGroup) : false,
      });
      const errors = issues.filter((issue) => issue.severity !== 'warning');
      if (errors.length > 0) {
        throw new ValidationFailure(errors);
      }

      if (original && (original.groupName !== groupName || original.vendor !== vendor)) {
        throw new ValidationFailure([
          { field: 'groupName', message: '不能在编辑时更换连接分组；请新建模型后删除原条目。' },
        ]);
      }

      const originalRaw = original
        ? groupModels(existingGroup ?? { name: groupName, vendor }).find((model) => model['id'] === original.id)
        : undefined;
      if (original && !originalRaw) {
        throw new SnapshotConflictError(`分组“${original.groupName}”中的模型“${original.id}”已不存在，请刷新后重试。`);
      }

      const nextModel = applyDraftToRaw(draft, originalRaw, this.providerCapabilities(vendor));
      const groups = upsertModel(raw.groups, vendor, groupName, nextModel, original?.id);

      const secret = draft.apiKey?.trim();
      if (secret) {
        await this.adapter.writeWithCredential(raw, groups, vendor, groupName, secret);
      } else {
        await this.adapter.writeGroups(raw, groups);
      }
      return this.reload();
    });
  }

  async deleteModel(ref: ModelRef, expectedFingerprint: string): Promise<ConfigSnapshot> {
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);
      const vendor = this.resolveVendor(ref.vendor);
      const groups = removeModelFromDocument(raw.groups, vendor, ref.groupName, ref.id);
      await this.adapter.writeGroups(raw, groups);
      return this.reload();
    });
  }

  async deleteGroup(vendorInput: VendorId, groupName: string, expectedFingerprint: string): Promise<ConfigSnapshot> {
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);
      const vendor = this.resolveVendor(vendorInput);
      const groups = removeGroupFromDocument(raw.groups, vendor, groupName);
      await this.adapter.writeGroups(raw, groups);
      return this.reload();
    });
  }

  async updateApiKey(
    vendorInput: VendorId,
    groupName: string,
    apiKey: string,
    expectedFingerprint: string,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const vendor = this.resolveVendor(vendorInput);
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);
      if (!findGroup(raw.groups, vendor, groupName)) {
        throw new ConfigParseError(`找不到分组“${groupName}”。`);
      }
      const trimmed = apiKey.trim();
      if (!trimmed) {
        throw new ConfigParseError('API Key 不能为空。');
      }
      await this.adapter.writeWithCredential(raw, raw.groups, vendor, groupName, trimmed);
      await this.reload();
    });
  }

  /** 只移除配置中的凭据引用；VS Code 密钥存储里的密钥不会被扩展删除。 */
  async clearApiKey(vendorInput: VendorId, groupName: string, expectedFingerprint: string): Promise<ConfigSnapshot> {
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);
      const vendor = this.resolveVendor(vendorInput);
      const groups = removeCredential(raw.groups, vendor, groupName);
      await this.adapter.writeGroups(raw, groups);
      this.log.info(`已移除分组“${groupName}”的凭据引用。`);
      return this.reload();
    });
  }

  async testDraft(draft: ModelDraft): Promise<ConnectionTestResult> {
    // 编辑时凭据框留空代表“沿用原分组密钥”，测试需要读取实际存储的密钥。
    if (!draft.apiKey?.trim() && draft.groupName.trim()) {
      const group = findGroup(this.rawGroups, draft.vendor, draft.groupName.trim());
      if (groupHasApiKey(group)) {
        return this.tester.test(draft, { requiresExistingCredential: true, hasStoredCredential: true });
      }
    }
    return this.tester.test(draft);
  }

  cancelTest(): boolean {
    return this.tester.cancel();
  }

  async export(vendorFilter?: VendorId[]): Promise<string> {
    return `${JSON.stringify(createSanitizedExport(this.rawGroups, vendorFilter), undefined, 2)}\n`;
  }

  async previewImport(parsed: unknown): Promise<ImportPreview> {
    const { groups: incoming, strippedCredentials } = sanitizeImportedGroups(normalizeImportRoot(parsed), [
      'customendpoint',
      'customoai',
    ]);
    if (incoming.length === 0) {
      throw new ConfigParseError('没有找到可导入的 customendpoint/customoai 分组。');
    }
    const snapshot = this.snapshot ?? (await this.reload());
    const preview = buildImportPreview(
      incoming,
      snapshot.groups.map((group) => ({ name: group.name, vendor: group.vendor })),
      (vendor) => this.providerCapabilities(vendor),
    );
    preview.strippedCredentials = strippedCredentials;
    return preview;
  }

  async importGroups(
    parsed: unknown,
    expectedFingerprint: string,
    _vendorInput?: VendorId,
  ): Promise<{ snapshot: ConfigSnapshot; strippedCredentials: boolean }> {
    const { groups: incoming, strippedCredentials } = sanitizeImportedGroups(normalizeImportRoot(parsed), [
      'customendpoint',
      'customoai',
    ]);
    if (incoming.length === 0) {
      throw new ConfigParseError('没有找到可导入的 customendpoint/customoai 分组。');
    }
    const validation = buildImportPreview(incoming, [], (vendor) => this.providerCapabilities(vendor));
    if (previewHasErrors(validation)) {
      const messages = validation.groups
        .flatMap((group) =>
          group.issues
            .filter((issue) => issue.severity !== 'warning')
            .map((issue) => `${group.name}：${issue.message}`),
        )
        .slice(0, 6);
      throw new ConfigParseError(`导入内容未通过校验：${messages.join('；')}`);
    }
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);
      const capabilities = this.adapter.capabilities();
      const groups = mergeImportedGroups(raw.groups, incoming, {
        preferredVendor: capabilities.preferredVendor,
        availableVendors: capabilities.vendors,
      });
      await this.adapter.writeGroups(raw, groups);
      return { snapshot: await this.reload(), strippedCredentials };
    });
  }

  async importLegacy(expectedFingerprint: string): Promise<LegacyImportResult> {
    const legacy = this.adapter.readLegacyModels();
    if (legacy.length === 0) {
      throw new ConfigParseError('旧版设置中没有可导入的模型。');
    }
    return this.enqueueWrite(async () => {
      this.assertAvailable();
      const raw = await this.adapter.read();
      this.assertFingerprint(raw.text, expectedFingerprint);
      const capabilities = this.adapter.capabilities();
      const vendor = capabilities.preferredVendor;
      const converted = legacyModelsToGroup(legacy, vendor, LEGACY_GROUP_NAME);
      const groups = mergeImportedGroups(raw.groups, [converted.group], {
        preferredVendor: vendor,
        availableVendors: capabilities.vendors,
      });
      await this.adapter.writeGroups(raw, groups);
      const importedCount = groupModels(converted.group).length;
      this.log.info(`已从旧版设置导入 ${importedCount} 个模型。`);
      return {
        snapshot: await this.reload(),
        count: importedCount,
        groupName: LEGACY_GROUP_NAME,
        strippedCredentials: converted.strippedCredentials,
      };
    });
  }

  async openLegacySetting(): Promise<void> {
    await this.adapter.openLegacySetting();
  }

  async openDashboard(): Promise<void> {
    await this.adapter.openOfficialManagement();
  }

  async openConfigFile(): Promise<void> {
    await this.adapter.openConfigFile();
  }

  async openBackupFolder(): Promise<void> {
    await this.adapter.openBackupFolder();
  }

  async hasUnsavedConfigChanges(): Promise<boolean> {
    return this.adapter.hasUnsavedConfigChanges();
  }

  private async buildSnapshot(
    text: string | undefined,
    exists: boolean,
    error: string | undefined,
  ): Promise<ConfigSnapshot> {
    const capabilities = this.adapter.capabilities();
    const groups: ProviderGroup[] = [];
    if (!error) {
      for (const group of this.rawGroups) {
        if (!isVendorId(group.vendor)) {
          continue;
        }
        const groupHasCredential = groupHasApiKey(group);
        const models = groupModels(group)
          .map((model) =>
            parseRawModel(model, group.vendor as VendorId, group.name, { groupHasCredential }),
          )
          .filter((model): model is ModelRecord => Boolean(model));
        const apiType = group['apiType'];
        groups.push({
          name: group.name,
          vendor: group.vendor,
          models,
          hasApiKey: groupHasCredential,
          apiType: apiType === 'chat-completions' || apiType === 'responses' || apiType === 'messages' ? apiType : undefined,
          raw: { ...group },
        });
      }
    }

    let legacyModels: ModelRecord[] = [];
    if (!error) {
      try {
        legacyModels = this.adapter
          .readLegacyModels()
          .map((item) => parseRawModel(item.raw, 'customoai', LEGACY_GROUP_NAME))
          .filter((model): model is ModelRecord => Boolean(model));
      } catch {
        legacyModels = [];
      }
    }

    let source: ConfigSnapshot['source'] = 'file';
    if (groups.length === 0 && !exists && !error) {
      source = legacyModels.length > 0 ? 'settings-legacy' : 'settings-empty';
    }

    const vendorInfo: VendorInfo[] = [...capabilities.vendorInfo];
    for (const group of groups) {
      if (!vendorInfo.some((info) => info.vendor === group.vendor)) {
        vendorInfo.push(this.adapter.vendorInfo(group.vendor));
      }
    }
    for (const vendor of capabilities.vendors) {
      if (!vendorInfo.some((info) => info.vendor === vendor)) {
        vendorInfo.push({
          vendor,
          label: VENDOR_LABELS[vendor],
          deprecated: vendor === 'customoai',
          available: false,
          supportsModelApiType: vendor === 'customendpoint',
          supportsReasoningEffortFormat: vendor === 'customendpoint',
          supportsDefaultReasoningEffort: false,
        });
      }
    }

    return {
      groups,
      legacyModels,
      source,
      adapterAvailable: !error,
      adapterMessage: error
        ? `${error} 面板不会写入任何配置，请先修复或使用官方模型管理。`
        : capabilities.providerMessage,
      fingerprint: error ? 'unavailable' : fingerprintOf(text),
      configFilePath: this.adapter.filePath,
      vendors: capabilities.vendors,
      vendorInfo,
      preferredVendor: capabilities.preferredVendor,
      dashboardAvailable: capabilities.dashboardAvailable,
      writeEnabled: !error,
      credentialWriteEnabled: capabilities.credentialWriteEnabled && !error,
      hasMigrateCommand: capabilities.hasMigrateCommand,
      copilotVersion: capabilities.copilotVersion,
      vscodeVersion: vscode.version,
    };
  }

  private assertFingerprint(text: string | undefined, expected: string): void {
    if (fingerprintOf(text) !== expected) {
      throw new SnapshotConflictError();
    }
  }

  private assertAvailable(): void {
    if (this.configError) {
      throw new ConfigUnavailableError(`配置文件无法解析，请先修复后重试：${this.configError}`);
    }
  }

  private resolveVendor(vendor: VendorId): VendorId {
    if (!isVendorId(vendor)) {
      throw new ConfigParseError('未知的模型提供方。');
    }
    const providers = this.adapter.registry.list();
    if (providers.length > 0 && !this.adapter.registry.get(vendor)) {
      throw new Error(`当前 Copilot 版本不提供 ${VENDOR_LABELS[vendor]} 提供方。`);
    }
    return vendor;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

export function describeVendor(vendor: string): string {
  return isVendorId(vendor) ? VENDOR_LABELS[vendor] : vendor;
}

function normalizeImportRoot(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    return [parsed];
  }
  return parsed;
}

export { parseGroups };
