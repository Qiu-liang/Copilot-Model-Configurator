import type { RawGroup } from './configDocument.ts';
import { apiTypeFromUrl, isApiType, isLocalHost, resolveRequestUrl } from './draft.ts';
import type { ApiType, ValidationIssue } from './modelConfig.ts';

/** 分组级接口地址。Copilot 忽略该字段，由面板用它派生每个模型的 `url`。 */
export const GROUP_BASE_URL_KEY = 'baseUrl';

const API_PATH_SUFFIX = /\/(?:chat\/completions|responses|messages)$/i;

function trimTrailingSlash(value: string): string {
  let result = value;
  while (result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 直接读取分组内的模型对象（保持引用），供批量写入使用。 */
function modelEntries(group: RawGroup): Record<string, unknown>[] {
  const models = group['models'];
  return Array.isArray(models) ? models.filter(isRecord) : [];
}

/**
 * 把用户输入归一化为“基地址”：去掉末尾斜杠与具体的 API 路径，
 * 这样切换 API 类型时可以由 `resolveRequestUrl` 重新拼接。
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimTrailingSlash(trimTrailingSlash(trimmed).replace(API_PATH_SUFFIX, ''));
}

export function deriveBaseUrl(models: readonly Record<string, unknown>[]): string | undefined {
  for (const model of models) {
    const url = model['url'];
    if (typeof url === 'string' && url.trim()) {
      return normalizeBaseUrl(url);
    }
  }
  return undefined;
}

/** 分组地址优先取显式 `baseUrl`；旧配置从模型 URL 推导，保证读取可用。 */
export function readGroupBaseUrl(group: RawGroup): string | undefined {
  const stored = group[GROUP_BASE_URL_KEY];
  if (typeof stored === 'string' && stored.trim()) {
    return normalizeBaseUrl(stored);
  }
  return deriveBaseUrl(modelEntries(group));
}

/** 分组 API 类型优先取分组字段；旧配置回退到模型级声明或 URL 路径。 */
export function readGroupApiType(group: RawGroup): ApiType | undefined {
  const stored = group['apiType'];
  if (isApiType(stored)) {
    return stored;
  }
  for (const model of modelEntries(group)) {
    if (isApiType(model['apiType'])) {
      return model['apiType'];
    }
    const url = model['url'];
    if (typeof url === 'string' && url.trim()) {
      return apiTypeFromUrl(url);
    }
  }
  return undefined;
}

export function applyGroupEndpointToModel(
  model: Record<string, unknown>,
  baseUrl: string,
  apiType: ApiType,
): void {
  model['url'] = resolveRequestUrl(normalizeBaseUrl(baseUrl), apiType);
  delete model['apiType'];
}

/** 统一写入分组接口，并重写全部模型的 url、移除模型级 apiType。 */
export function applyGroupEndpoint(group: RawGroup, baseUrl: string, apiType: ApiType): void {
  const base = normalizeBaseUrl(baseUrl);
  group[GROUP_BASE_URL_KEY] = base;
  group['apiType'] = apiType;
  for (const model of modelEntries(group)) {
    applyGroupEndpointToModel(model, base, apiType);
  }
}

export function validateGroupEndpoint(
  baseUrlInput: string,
  apiType: ApiType,
  allowInsecureHttp = false,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const baseUrl = normalizeBaseUrl(baseUrlInput);
  if (!baseUrl) {
    issues.push({ field: 'baseUrl', message: '请填写分组 API 地址。' });
    return issues;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(baseUrl);
  } catch {
    issues.push({ field: 'baseUrl', message: '分组 API 地址不是有效的 URL。' });
  }
  if (parsed) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      issues.push({ field: 'baseUrl', message: '分组 API 地址必须以 https:// 或 http:// 开头。' });
    } else if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname) && !allowInsecureHttp) {
      issues.push({
        field: 'baseUrl',
        message: 'http 会明文传输 API Key。请改用 https，或在分组设置中确认使用不安全连接。',
      });
    }
    if (parsed.username || parsed.password) {
      issues.push({ field: 'baseUrl', message: '请不要把凭据写在 URL 中。' });
    }
  }
  if (!isApiType(apiType)) {
    issues.push({ field: 'apiType', message: '未知的 API 类型。' });
  }
  return issues;
}
