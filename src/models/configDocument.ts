import { createHash } from 'node:crypto';

export interface RawGroup {
  name: string;
  vendor: string;
  [key: string]: unknown;
}

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseGroups(value: unknown): RawGroup[] {
  if (!Array.isArray(value)) {
    throw new ConfigParseError('配置文件根节点必须是数组。');
  }
  const groups: RawGroup[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new ConfigParseError(`第 ${index + 1} 个分组不是对象。`);
    }
    const name = entry['name'];
    const vendor = entry['vendor'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ConfigParseError(`第 ${index + 1} 个分组缺少有效的 name。`);
    }
    if (typeof vendor !== 'string' || vendor.trim().length === 0) {
      throw new ConfigParseError(`第 ${index + 1} 个分组缺少有效的 vendor。`);
    }
    groups.push({ ...entry, name, vendor });
  });
  return groups;
}

export function cloneGroups(groups: readonly RawGroup[]): RawGroup[] {
  return structuredClone(groups) as RawGroup[];
}

export function groupModels(group: RawGroup): Record<string, unknown>[] {
  const models = group['models'];
  if (!Array.isArray(models)) {
    return [];
  }
  return models.filter(isRecord).map((model) => ({ ...model }));
}

export function findGroup(groups: readonly RawGroup[], vendor: string, name: string): RawGroup | undefined {
  return groups.find((group) => group.vendor === vendor && group.name === name);
}

export function groupHasApiKey(group: RawGroup | undefined): boolean {
  if (!group) {
    return false;
  }
  const apiKey = group['apiKey'];
  return typeof apiKey === 'string' && apiKey.length > 0;
}

export function upsertModel(
  groups: readonly RawGroup[],
  vendor: string,
  groupName: string,
  model: Record<string, unknown>,
  originalId?: string,
): RawGroup[] {
  const next = cloneGroups(groups);
  let group = findGroup(next, vendor, groupName);
  if (!group) {
    if (originalId !== undefined) {
      throw new ConfigParseError(`找不到分组“${groupName}”。`);
    }
    group = { name: groupName, vendor, models: [] };
    next.push(group);
  }
  const models = groupModels(group);
  const targetId = typeof model['id'] === 'string' ? model['id'] : '';
  const lookupId = originalId ?? targetId;
  const index = models.findIndex((candidate) => candidate['id'] === lookupId);
  if (index >= 0) {
    models[index] = model;
  } else {
    if (originalId !== undefined) {
      throw new ConfigParseError(`分组“${groupName}”中找不到模型“${originalId}”。`);
    }
    models.push(model);
  }
  group['models'] = models;
  return next;
}

export function removeModel(
  groups: readonly RawGroup[],
  vendor: string,
  groupName: string,
  modelId: string,
  dropEmptyGroup = false,
): RawGroup[] {
  const next = cloneGroups(groups);
  const group = findGroup(next, vendor, groupName);
  if (!group) {
    throw new ConfigParseError(`找不到分组“${groupName}”。`);
  }
  const models = groupModels(group).filter((model) => model['id'] !== modelId);
  if (models.length === 0 && dropEmptyGroup) {
    return next.filter((candidate) => !(candidate.vendor === vendor && candidate.name === groupName));
  }
  group['models'] = models;
  return next;
}

/** 移除分组级凭据引用；不会声称删除 VS Code 密钥存储中的实际密钥。 */
export function removeCredential(groups: readonly RawGroup[], vendor: string, groupName: string): RawGroup[] {
  const next = cloneGroups(groups);
  const group = findGroup(next, vendor, groupName);
  if (!group) {
    throw new ConfigParseError(`找不到分组“${groupName}”。`);
  }
  delete group['apiKey'];
  return next;
}

export function removeGroup(groups: readonly RawGroup[], vendor: string, groupName: string): RawGroup[] {
  return cloneGroups(groups).filter((group) => !(group.vendor === vendor && group.name === groupName));
}

export function renameGroup(groups: readonly RawGroup[], vendor: string, from: string, to: string): RawGroup[] {
  const next = cloneGroups(groups);
  const group = findGroup(next, vendor, from);
  if (!group) {
    throw new ConfigParseError(`找不到分组“${from}”。`);
  }
  if (findGroup(next, vendor, to)) {
    throw new ConfigParseError(`分组“${to}”已存在。`);
  }
  group.name = to;
  return next;
}

export interface LegacyModelInput {
  id: string;
  raw: Record<string, unknown>;
}

export function readLegacyModels(value: unknown): LegacyModelInput[] {
  if (!isRecord(value)) {
    return [];
  }
  const result: LegacyModelInput[] = [];
  for (const [id, config] of Object.entries(value)) {
    if (!isRecord(config)) {
      continue;
    }
    result.push({ id, raw: { ...config, id: typeof config['id'] === 'string' ? config['id'] : id } });
  }
  return result;
}

const EXPORTABLE_GROUP_FIELDS = ['name', 'vendor', 'apiType'] as const;
const EXPORTABLE_MODEL_FIELDS = [
  'id',
  'name',
  'url',
  'apiType',
  'contextWindow',
  'maxInputTokens',
  'maxOutputTokens',
  'toolCalling',
  'vision',
  'thinking',
  'streaming',
  'supportsReasoningEffort',
  'defaultReasoningEffort',
  'reasoningEffortFormat',
  'zeroDataRetentionEnabled',
  'statefulResponses',
  'adaptiveThinking',
  'minThinkingBudget',
  'maxThinkingBudget',
  'editTools',
  'modelOptions',
] as const;

export function createSanitizedExport(groups: readonly RawGroup[], vendorFilter?: readonly string[]): RawGroup[] {
  const allowed = vendorFilter ? new Set(vendorFilter) : undefined;
  return groups
    .filter((group) => !allowed || allowed.has(group.vendor))
    .map((group) => {
      const result: Record<string, unknown> = {};
      for (const field of EXPORTABLE_GROUP_FIELDS) {
        if (group[field] !== undefined) {
          result[field] = group[field];
        }
      }
      result['name'] = group.name;
      result['vendor'] = group.vendor;
      result['models'] = groupModels(group).map((model) => {
        const exported: Record<string, unknown> = {};
        for (const field of EXPORTABLE_MODEL_FIELDS) {
          if (model[field] !== undefined) {
            exported[field] = model[field];
          }
        }
        return exported;
      });
      return result as RawGroup;
    });
}

export function fingerprintOf(text: string | undefined): string {
  return createHash('sha256').update(text ?? '[]', 'utf8').digest('hex');
}

export function serializeGroups(groups: readonly RawGroup[]): string {
  return `${JSON.stringify(groups, undefined, '\t')}\n`;
}

export function containsSecretLikeValue(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) {
    return text;
  }
  return text.split(secret).join('***');
}
