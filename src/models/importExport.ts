import {
  ConfigParseError,
  cloneGroups,
  groupModels,
  parseGroups,
  type LegacyModelInput,
  type RawGroup,
} from './configDocument.ts';
import { cloneDraft, hasErrors, parseRawModel, validateDraft, type ProviderCapabilities } from './draft.ts';
import { deriveBaseUrl, readGroupApiType } from './groupEndpoint.ts';
import type { ImportPreview, ImportPreviewGroup, ValidationIssue, VendorId } from './modelConfig.ts';
import { isVendorId } from './draft.ts';

export interface SanitizedImport {
  groups: RawGroup[];
  strippedCredentials: boolean;
}

/**
 * 导入内容只保留配置结构：分组与模型中的 apiKey 字段一律移除，
 * 凭据必须由用户在面板中重新设置。
 */
export function sanitizeImportedGroups(value: unknown, allowedVendors: readonly string[]): SanitizedImport {
  const parsed = parseGroups(value);
  let strippedCredentials = false;
  const allowed = new Set(allowedVendors);
  const groups: RawGroup[] = [];
  for (const group of parsed) {
    const vendor = group.vendor.trim();
    if (!allowed.has(vendor)) {
      continue;
    }
    const copy = structuredClone(group) as RawGroup;
    if (typeof copy['apiKey'] === 'string' && copy['apiKey'].length > 0) {
      strippedCredentials = true;
    }
    delete copy['apiKey'];
    copy['vendor'] = vendor;
    copy['name'] = group.name.trim();
    copy['models'] = groupModels(copy).map((model) => {
      if (typeof model['apiKey'] === 'string' && model['apiKey'].length > 0) {
        strippedCredentials = true;
      }
      delete model['apiKey'];
      return model;
    });
    groups.push(copy);
  }
  return { groups, strippedCredentials };
}

export function buildImportPreview(
  incoming: readonly RawGroup[],
  existingGroups: readonly { name: string; vendor: string }[],
  capabilitiesFor: (vendor: VendorId) => ProviderCapabilities,
): ImportPreview {
  const previewGroups: ImportPreviewGroup[] = [];
  let totalModels = 0;
  let canApply = true;

  for (const group of incoming) {
    const vendor = group.vendor;
    const issues: ValidationIssue[] = [];
    const models = groupModels(group);
    if (models.length === 0) {
      issues.push({ field: 'models', message: '分组没有任何模型。' });
    }
    const supportedVendor = isVendorId(vendor);
    if (!supportedVendor) {
      issues.push({ field: 'vendor', message: `不支持的提供方“${vendor}”。` });
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const raw of models) {
      if (!supportedVendor) {
        continue;
      }
      const record = parseRawModel(raw, vendor, group.name);
      if (!record) {
        issues.push({ field: 'id', message: '存在缺少有效 id 的模型，无法导入。' });
        continue;
      }
      if (seen.has(record.id)) {
        issues.push({ field: 'id', message: `模型 ID“${record.id}”在分组内重复。` });
        continue;
      }
      seen.add(record.id);
      ids.push(record.id);
      const draft = cloneDraft(record);
      const modelIssues = validateDraft(draft, {
        siblingIds: [...seen].filter((id) => id !== record.id),
        existingGroupNames: [],
        capabilities: capabilitiesFor(vendor),
        groupExists: true,
        groupHasCredential: true,
      });
      for (const issue of modelIssues) {
        if (issue.severity === 'warning') {
          continue;
        }
        issues.push({ ...issue, message: `模型“${record.id}”：${issue.message}` });
      }
    }
    const conflict = existingGroups.some((entry) => entry.vendor === vendor && entry.name === group.name);
    if (issues.some((issue) => issue.severity !== 'warning')) {
      canApply = false;
    }
    totalModels += models.length;
    previewGroups.push({ vendor, name: group.name, modelIds: ids, conflict, issues });
  }

  return {
    groups: previewGroups,
    totalModels,
    strippedCredentials: false,
    warnings: [],
    canApply,
  };
}

export interface MergeImportedOptions {
  preferredVendor: VendorId;
  availableVendors: readonly VendorId[];
}

function targetVendor(incoming: string, options: MergeImportedOptions): VendorId {
  if (isVendorId(incoming) && options.availableVendors.includes(incoming)) {
    return incoming;
  }
  return options.preferredVendor;
}

/**
 * 只合并导入的 customendpoint/customoai 分组：
 * 同名分组替换模型列表，但保留原有 apiKey 引用与 settings（导入内容不包含凭据）。
 */
export function mergeImportedGroups(
  existing: readonly RawGroup[],
  incoming: readonly RawGroup[],
  options: MergeImportedOptions,
): RawGroup[] {
  const next = cloneGroups(existing);
  const seen = new Set<string>();
  for (const group of incoming) {
    const vendor = targetVendor(group.vendor, options);
    const name = group.name.trim();
    const key = `${vendor}\u0000${name}`;
    if (seen.has(key)) {
      throw new ConfigParseError(`导入内容中有重复分组“${name}”。`);
    }
    seen.add(key);
    const imported = structuredClone(group) as RawGroup;
    imported.name = name;
    imported.vendor = vendor;
    delete imported['apiKey'];
    const index = next.findIndex((candidate) => candidate.vendor === vendor && candidate.name === name);
    if (index >= 0) {
      const previous = next[index];
      if (previous?.['apiKey'] !== undefined) {
        imported['apiKey'] = previous['apiKey'];
      }
      if (previous?.['settings'] !== undefined && imported['settings'] === undefined) {
        imported['settings'] = previous['settings'];
      }
      // 旧导出没有分组接口字段时，沿用原分组的统一配置。
      if (previous?.['baseUrl'] !== undefined && imported['baseUrl'] === undefined) {
        imported['baseUrl'] = previous['baseUrl'];
      }
      if (previous?.['apiType'] !== undefined && imported['apiType'] === undefined) {
        imported['apiType'] = previous['apiType'];
      }
      next[index] = imported;
    } else {
      next.push(imported);
    }
  }
  return next;
}

export interface LegacyGroupResult {
  group: RawGroup;
  strippedCredentials: boolean;
}

/** 旧版设置只读导入：剥离模型级明文密钥，ID 去重并保留未知字段。 */
export function legacyModelsToGroup(
  models: readonly LegacyModelInput[],
  vendor: VendorId,
  groupName: string,
): LegacyGroupResult {
  let strippedCredentials = false;
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of models) {
    const raw: Record<string, unknown> = { ...item.raw };
    if (typeof raw['apiKey'] === 'string' && raw['apiKey'].length > 0) {
      strippedCredentials = true;
    }
    delete raw['apiKey'];
    const id = typeof raw['id'] === 'string' && raw['id'].trim() ? raw['id'].trim() : item.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    raw['id'] = id;
    result.push(raw);
  }
  const group: RawGroup = { name: groupName, vendor, models: result };
  const baseUrl = deriveBaseUrl(result);
  if (baseUrl) {
    group['baseUrl'] = baseUrl;
  }
  const apiType = readGroupApiType(group);
  if (apiType) {
    group['apiType'] = apiType;
  }
  return {
    group,
    strippedCredentials,
  };
}

export function previewHasErrors(preview: ImportPreview): boolean {
  return preview.groups.some((group) => hasErrors(group.issues));
}
