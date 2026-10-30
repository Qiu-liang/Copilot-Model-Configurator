import {
  API_TYPES,
  COMMON_EFFORT_LEVELS,
  DEFAULT_API_TYPE,
  DEFAULT_MODEL_VALUES,
  type ApiType,
  type ModelDraft,
  type ModelRecord,
  type ReasoningEffortFormat,
  type ValidationIssue,
  type VendorId,
} from './modelConfig.ts';

export interface ProviderCapabilities {
  /** provider 是否声明了模型级 apiType。 */
  supportsModelApiType: boolean;
  /** provider 是否声明了 defaultReasoningEffort。 */
  supportsDefaultReasoningEffort: boolean;
  /** provider 是否声明了 reasoningEffortFormat。 */
  supportsReasoningEffortFormat: boolean;
  /** provider 是否声明了 adaptiveThinking。 */
  supportsAdaptiveThinking: boolean;
}

export const FULL_CAPABILITIES: ProviderCapabilities = {
  supportsModelApiType: true,
  supportsDefaultReasoningEffort: false,
  supportsReasoningEffortFormat: true,
  supportsAdaptiveThinking: true,
};

const EFFORT_LEVEL_ALIASES: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

export function isVendorId(value: unknown): value is VendorId {
  return value === 'customendpoint' || value === 'customoai';
}

export function isApiType(value: unknown): value is ApiType {
  return typeof value === 'string' && (API_TYPES as readonly string[]).includes(value);
}

export function isEffortFormat(value: unknown): value is ReasoningEffortFormat {
  return isApiType(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function apiTypeFromUrl(url: string): ApiType {
  if (url.includes('/messages')) {
    return 'messages';
  }
  if (url.includes('/responses')) {
    return 'responses';
  }
  return 'chat-completions';
}

export function hasExplicitApiPath(url: string): boolean {
  return url.includes('/responses') || url.includes('/chat/completions') || url.includes('/messages');
}

export function resolveRequestUrl(url: string, apiType: ApiType): string {
  if (hasExplicitApiPath(url)) {
    return url;
  }
  let base = url;
  if (base.endsWith('/')) {
    base = base.slice(0, -1);
  }
  const apiPath = apiType === 'responses' ? '/responses' : apiType === 'messages' ? '/messages' : '/chat/completions';
  if (/\/v\d+$/.test(base)) {
    return `${base}${apiPath}`;
  }
  return `${base}/v1${apiPath}`;
}

export function normalizeEffortLevels(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const raw = asNonEmptyString(value);
    if (!raw) {
      continue;
    }
    const normalized = EFFORT_LEVEL_ALIASES[raw.toLowerCase()] ?? raw;
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function defaultEffortLevels(): string[] {
  return [...COMMON_EFFORT_LEVELS].slice(1, 4);
}

export function readContextWindow(raw: Record<string, unknown>): number {
  const explicit = asPositiveInt(raw['contextWindow']);
  if (explicit !== undefined) {
    return explicit;
  }
  const maxInput = asPositiveInt(raw['maxInputTokens']) ?? 0;
  const maxOutput = asPositiveInt(raw['maxOutputTokens']) ?? 0;
  return maxInput + maxOutput;
}

/**
 * 认证方式不保存在模型对象里，只能由所属分组是否已有凭据推断：
 * 分组没有凭据时，该分组的模型就是以无认证方式调用。
 */
export function parseRawModel(
  raw: unknown,
  vendor: VendorId,
  groupName: string,
  options: { groupHasCredential?: boolean; groupApiType?: ApiType } = {},
): ModelRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = asNonEmptyString(raw['id']);
  if (!id) {
    return undefined;
  }
  const name = asNonEmptyString(raw['name']) ?? id;
  const url = asNonEmptyString(raw['url']) ?? '';
  const contextWindow = readContextWindow(raw);
  const maxOutputTokens = asPositiveInt(raw['maxOutputTokens']) ?? DEFAULT_MODEL_VALUES.maxOutputTokens;
  const maxInputTokens =
    asPositiveInt(raw['maxInputTokens']) ??
    Math.max(1, (contextWindow || DEFAULT_MODEL_VALUES.contextWindow) - maxOutputTokens);
  const apiType = isApiType(raw['apiType'])
    ? raw['apiType']
    : (options.groupApiType ?? DEFAULT_API_TYPE);
  const supportsReasoningEffort = normalizeEffortLevels(raw['supportsReasoningEffort']);
  // `thinking` 与 `supportsReasoningEffort` 是相互独立的声明：Copilot 只按强度列表
  // 转发强度并在档位多于一个时显示选择器，因此任一存在都视为开启了思考。
  const thinking = asBoolean(raw['thinking'], false) || supportsReasoningEffort.length > 0;
  const reasoningEffortFormat = isEffortFormat(raw['reasoningEffortFormat']) ? raw['reasoningEffortFormat'] : undefined;
  const defaultReasoningEffort = asNonEmptyString(raw['defaultReasoningEffort']);

  return {
    vendor,
    groupName,
    id,
    name,
    url,
    apiType,
    contextWindow: contextWindow || maxInputTokens + maxOutputTokens,
    maxInputTokens,
    maxOutputTokens,
    toolCalling: asBoolean(raw['toolCalling'], true),
    vision: asBoolean(raw['vision'], false),
    thinking,
    streaming: asBoolean(raw['streaming'], true),
    supportsReasoningEffort: thinking ? supportsReasoningEffort : [],
    defaultReasoningEffort: thinking ? defaultReasoningEffort : undefined,
    reasoningEffortFormat: thinking ? reasoningEffortFormat : undefined,
    credentialMode: options.groupHasCredential === false ? 'none' : 'apiKey',
    raw: { ...raw },
  };
}

export function createEmptyDraft(vendor: VendorId, groupName: string): ModelDraft {
  const contextWindow = DEFAULT_MODEL_VALUES.contextWindow;
  const maxOutputTokens = DEFAULT_MODEL_VALUES.maxOutputTokens;
  return {
    vendor,
    groupName,
    id: '',
    name: '',
    url: '',
    apiType: DEFAULT_API_TYPE,
    contextWindow,
    maxInputTokens: contextWindow - maxOutputTokens,
    maxOutputTokens,
    toolCalling: true,
    vision: false,
    thinking: false,
    streaming: true,
    supportsReasoningEffort: [],
    credentialMode: 'apiKey',
    allowInsecureHttp: false,
  };
}

export function cloneDraft(record: ModelRecord): ModelDraft {
  return {
    vendor: record.vendor,
    groupName: record.groupName,
    id: record.id,
    name: record.name,
    url: record.url,
    apiType: record.apiType,
    contextWindow: record.contextWindow,
    maxInputTokens: record.maxInputTokens,
    maxOutputTokens: record.maxOutputTokens,
    toolCalling: record.toolCalling,
    vision: record.vision,
    thinking: record.thinking,
    streaming: record.streaming,
    supportsReasoningEffort: [...record.supportsReasoningEffort],
    defaultReasoningEffort: record.defaultReasoningEffort,
    reasoningEffortFormat: record.reasoningEffortFormat,
    credentialMode: record.credentialMode ?? 'apiKey',
    allowInsecureHttp: false,
  };
}

function nextCopyId(baseId: string, siblingIds: readonly string[]): string {
  const taken = new Set(siblingIds);
  const first = `${baseId}-copy`;
  if (!taken.has(first)) {
    return first;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}-copy-${index}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${baseId}-copy-${Date.now()}`;
}

/** 复制模型时生成草稿：新 ID 自动避让同组已有模型，名称标注副本；认证方式沿用原分组状态。 */
export function createCopyDraft(record: ModelRecord, siblingIds: readonly string[]): ModelDraft {
  const draft = cloneDraft(record);
  draft.id = nextCopyId(record.id, siblingIds);
  draft.name = `${record.name}（副本）`;
  draft.apiKey = undefined;
  return draft;
}

export function applyDraftToRaw(
  draft: ModelDraft,
  existingRaw: Record<string, unknown> | undefined,
  capabilities: ProviderCapabilities,
): Record<string, unknown> {
  const next: Record<string, unknown> = existingRaw ? { ...existingRaw } : {};

  next['id'] = draft.id.trim();
  next['name'] = draft.name.trim();
  next['toolCalling'] = draft.toolCalling;
  next['vision'] = draft.vision;
  next['maxInputTokens'] = draft.maxInputTokens;
  next['maxOutputTokens'] = draft.maxOutputTokens;
  next['contextWindow'] = draft.contextWindow;
  next['streaming'] = draft.streaming;
  // 模型对象不应携带明文密钥；历史遗留字段在保存时清除。
  delete next['apiKey'];
  // 地址与 API 类型由分组统一管理，模型级不再写入。
  delete next['apiType'];

  const efforts = normalizeEffortLevels(draft.supportsReasoningEffort);
  if (draft.thinking) {
    // 只保留原配置已有的原生 thinking 声明：仅靠强度档位工作的模型不新增该字段，
    // 避免把 Copilot 未声明的原生思考能力写进配置。没有强度时 thinking 是唯一声明。
    if (existingRaw?.['thinking'] === true || efforts.length === 0) {
      next['thinking'] = true;
    } else {
      delete next['thinking'];
    }
    if (efforts.length > 0) {
      next['supportsReasoningEffort'] = efforts;
    } else {
      delete next['supportsReasoningEffort'];
    }
    if (capabilities.supportsReasoningEffortFormat && draft.reasoningEffortFormat) {
      next['reasoningEffortFormat'] = draft.reasoningEffortFormat;
    } else {
      delete next['reasoningEffortFormat'];
    }
    if (
      capabilities.supportsDefaultReasoningEffort &&
      draft.defaultReasoningEffort &&
      efforts.some((level) => level.toLowerCase() === draft.defaultReasoningEffort?.toLowerCase())
    ) {
      next['defaultReasoningEffort'] = draft.defaultReasoningEffort;
    } else {
      delete next['defaultReasoningEffort'];
    }
  } else {
    delete next['thinking'];
    delete next['supportsReasoningEffort'];
    delete next['reasoningEffortFormat'];
    delete next['defaultReasoningEffort'];
  }

  return next;
}

export interface ValidationContext {
  /** 除当前编辑对象外，同一分组中已有的模型 ID。 */
  siblingIds: string[];
  /** 当前 Profile 中已存在的分组名（按 vendor 分组）。 */
  existingGroupNames: string[];
  capabilities: ProviderCapabilities;
  /** 目标分组是否已存在；未提供时跳过凭据决策校验。 */
  groupExists?: boolean;
  /** 目标分组是否已有可用凭据（只表示存在，不读取密钥本身）。 */
  groupHasCredential?: boolean;
  /** 分组已统一管理接口时提供；此时不再校验模型自身的地址字段。 */
  groupEndpoint?: { baseUrl: string; apiType: ApiType };
}

export function validateDraft(draft: ModelDraft, context: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!draft.groupName.trim()) {
    issues.push({ field: 'groupName', message: '请填写连接分组名称。' });
  } else if (draft.groupName.trim().length > 80) {
    issues.push({ field: 'groupName', message: '分组名称不能超过 80 个字符。' });
  }

  const id = draft.id.trim();
  if (!id) {
    issues.push({ field: 'id', message: '请填写模型 ID，它会原样发送给服务方。' });
  } else if (/\s/.test(id)) {
    issues.push({ field: 'id', message: '模型 ID 不能包含空白字符。' });
  } else if (context.siblingIds.some((existing) => existing === id)) {
    issues.push({ field: 'id', message: '同一分组中已存在这个模型 ID。' });
  }

  if (!draft.name.trim()) {
    issues.push({ field: 'name', message: '请填写显示名称。' });
  }

  const url = draft.url.trim();
  if (context.groupEndpoint) {
    // 地址由分组统一管理，模型保存时由服务层按分组接口重写。
  } else if (!url) {
    issues.push({ field: 'url', message: '请填写 API 地址。' });
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      issues.push({ field: 'url', message: 'API 地址不是有效的 URL。' });
    }
    if (parsed) {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        issues.push({ field: 'url', message: 'API 地址必须以 https:// 或 http:// 开头。' });
      } else if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname) && !draft.allowInsecureHttp) {
        issues.push({
          field: 'url',
          message: 'http 会明文传输 API Key。请改用 https，或在高级设置中确认使用不安全连接。',
        });
      }
      if (parsed.username || parsed.password) {
        issues.push({ field: 'url', message: '请不要把凭据写在 URL 中。' });
      }
    }
  }

  const { contextWindow, maxInputTokens, maxOutputTokens } = draft;
  for (const [field, value, label] of [
    ['contextWindow', contextWindow, '总上下文窗口'],
    ['maxInputTokens', maxInputTokens, '最大输入 Tokens'],
    ['maxOutputTokens', maxOutputTokens, '最大输出 Tokens'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      issues.push({ field, message: `${label}必须是大于 0 的整数。` });
    }
  }
  if (
    Number.isSafeInteger(contextWindow) &&
    Number.isSafeInteger(maxInputTokens) &&
    Number.isSafeInteger(maxOutputTokens) &&
    maxInputTokens + maxOutputTokens !== contextWindow
  ) {
    issues.push({
      field: 'contextWindow',
      message: '必须满足：总上下文窗口 = 最大输入 Tokens + 最大输出 Tokens。',
    });
  }
  if (maxInputTokens > contextWindow) {
    issues.push({ field: 'maxInputTokens', message: '最大输入 Tokens 不能超过总上下文窗口。' });
  }

  if (draft.thinking) {
    const efforts = normalizeEffortLevels(draft.supportsReasoningEffort);
    if (efforts.length === 0) {
      issues.push({
        field: 'supportsReasoningEffort',
        severity: 'warning',
        message: '未选择思考强度：只会写入原生 thinking 能力，Copilot 不会显示强度选择器。',
      });
    }
    if (draft.defaultReasoningEffort) {
      const matches = efforts.some((level) => level.toLowerCase() === draft.defaultReasoningEffort?.toLowerCase());
      if (!matches) {
        issues.push({ field: 'defaultReasoningEffort', message: '默认思考强度必须包含在支持的强度中。' });
      }
      if (!context.capabilities.supportsDefaultReasoningEffort) {
        issues.push({
          field: 'defaultReasoningEffort',
          severity: 'warning',
          message: '当前 Copilot 版本不支持在配置文件中指定默认强度，保存后请在模型选择器中设置。',
        });
      }
    }
    if (!context.capabilities.supportsReasoningEffortFormat && draft.reasoningEffortFormat) {
      issues.push({
        field: 'reasoningEffortFormat',
        severity: 'warning',
        message: '当前 Copilot 版本不支持自定义思考参数格式，将按 API 类型自动选择。',
      });
    }
  }

  const key = draft.apiKey?.trim() ?? '';
  if (draft.credentialMode === 'none') {
    if (key) {
      issues.push({ field: 'apiKey', message: '已选择“无需认证”，请清空 API Key。' });
    }
    if (context.groupHasCredential) {
      issues.push({
        field: 'credentialMode',
        message: '该分组已经有 API Key。如需无认证，请先在分组设置中清除分组凭据。',
      });
    }
  } else if (!key && context.groupHasCredential !== undefined) {
    if (context.groupHasCredential) {
      // 留空表示沿用原凭据。
    } else if (context.groupExists === false) {
      issues.push({
        field: 'apiKey',
        message: '新分组需要 API Key；本地服务请明确选择“无需认证”。',
      });
    } else {
      issues.push({
        field: 'apiKey',
        message: '该分组还没有 API Key：请输入一个，或明确选择“无需认证”。',
      });
    }
  }

  const effectiveApiType = context.groupEndpoint?.apiType ?? draft.apiType;
  const effectiveUrl = context.groupEndpoint?.baseUrl ?? draft.url;
  if (
    draft.vendor === 'customoai' &&
    draft.thinking &&
    effectiveApiType !== 'chat-completions' &&
    !hasExplicitApiPath(effectiveUrl)
  ) {
    issues.push({
      field: 'url',
      severity: 'warning',
      message: 'OpenAI Compatible（已弃用）提供方只会推导 Chat Completions 地址，请直接填写完整端点。',
    });
  }

  return issues;
}

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity !== 'warning');
}

export function autoInputTokens(contextWindow: number, maxOutputTokens: number): number | undefined {
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens)) {
    return undefined;
  }
  const value = contextWindow - maxOutputTokens;
  return value > 0 ? value : undefined;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(value);
}
