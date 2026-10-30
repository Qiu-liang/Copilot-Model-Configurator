import type {
  ConfigSnapshot,
  ConnectionTestResult,
  GroupRef,
  ImportPreview,
  ModelDraft,
  ModelRef,
  ValidationIssue,
} from '../models/modelConfig.ts';
import { isApiType, isVendorId, normalizeEffortLevels } from '../models/draft.ts';

export type ToastLevel = 'info' | 'warn' | 'error';

export type ErrorCode =
  | 'validation'
  | 'conflict'
  | 'credential'
  | 'unavailable'
  | 'config'
  | 'duplicate'
  | 'unsupported'
  | 'canceled'
  | 'unknown';

export interface RequestError {
  code: ErrorCode;
  message: string;
  field?: string;
  issues?: ValidationIssue[];
}

export type ExtensionMessage =
  | { type: 'state'; payload: { snapshot: ConfigSnapshot } }
  | { type: 'busy'; payload: { busy: boolean; message?: string } }
  | { type: 'toast'; payload: { level: ToastLevel; message: string } }
  | { type: 'issues'; requestId: string; payload: { issues: ValidationIssue[] } }
  | { type: 'select'; payload: { ref?: ModelRef; group?: GroupRef } }
  | { type: 'start-create'; payload: { draft?: ModelDraft } }
  | { type: 'start-copy'; payload: { ref: ModelRef } }
  | {
      type: 'response';
      requestId: string;
      ok: boolean;
      data?: unknown;
      error?: RequestError;
    };

export interface RequestPayloads {
  'config/list': Record<string, never>;
  'config/save': { draft: ModelDraft; expectedFingerprint: string; original?: ModelRef };
  'config/delete': { ref: ModelRef; expectedFingerprint: string };
  'config/deleteGroup': { group: GroupRef; expectedFingerprint: string };
  'config/export': { copy?: boolean };
  'config/exportSave': { json: string };
  'config/import': { json: string };
  'config/importApply': { json: string; expectedFingerprint: string };
  'legacy/import': { expectedFingerprint: string };
  'legacy/openSetting': Record<string, never>;
  'connection/test': { draft: ModelDraft };
  'connection/cancel': Record<string, never>;
  'group/promptApiKey': { group: GroupRef };
  'group/clearApiKey': { group: GroupRef; expectedFingerprint: string };
  'panel/openOfficial': Record<string, never>;
  'panel/openConfigFile': Record<string, never>;
  'panel/openBackups': Record<string, never>;
  'ui/dirty': { dirty: boolean };
  'ui/refresh': Record<string, never>;
}

export type RequestType = keyof RequestPayloads;

export type WebviewRequest = {
  [K in RequestType]: { type: K; requestId: string; payload: RequestPayloads[K] };
}[RequestType];

export interface ParsedRequestFailure {
  error: RequestError;
  requestId: string;
}

const REQUEST_TYPES: readonly RequestType[] = [
  'config/list',
  'config/save',
  'config/delete',
  'config/deleteGroup',
  'config/export',
  'config/exportSave',
  'config/import',
  'config/importApply',
  'legacy/import',
  'legacy/openSetting',
  'connection/test',
  'connection/cancel',
  'group/promptApiKey',
  'group/clearApiKey',
  'panel/openOfficial',
  'panel/openConfigFile',
  'panel/openBackups',
  'ui/dirty',
  'ui/refresh',
];

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_JSON_LENGTH = 2_000_000;

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === 'string' && (REQUEST_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseModelDraft(value: unknown): ModelDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isVendorId(value['vendor']) || !isApiType(value['apiType'])) {
    return undefined;
  }
  const groupName =
    typeof value['groupName'] === 'string' && value['groupName'].length <= 200 ? value['groupName'] : undefined;
  const name = typeof value['name'] === 'string' && value['name'].length <= 500 ? value['name'] : undefined;
  const url = optionalText(value['url'], 4_000);
  const id = optionalText(value['id'], 500);
  const contextWindow = integer(value['contextWindow']);
  const maxInputTokens = integer(value['maxInputTokens']);
  const maxOutputTokens = integer(value['maxOutputTokens']);
  const toolCalling = bool(value['toolCalling']);
  const vision = bool(value['vision']);
  const thinking = bool(value['thinking']);
  const streaming = bool(value['streaming']);
  if (
    groupName === undefined ||
    name === undefined ||
    url === undefined ||
    id === undefined ||
    contextWindow === undefined ||
    maxInputTokens === undefined ||
    maxOutputTokens === undefined ||
    toolCalling === undefined ||
    vision === undefined ||
    thinking === undefined ||
    streaming === undefined ||
    !Array.isArray(value['supportsReasoningEffort'])
  ) {
    return undefined;
  }
  const apiKey = optionalText(value['apiKey'], 16_384);
  if (value['apiKey'] !== undefined && apiKey === undefined) {
    return undefined;
  }
  const defaultReasoningEffort = optionalText(value['defaultReasoningEffort'], 100);
  const reasoningEffortFormat = value['reasoningEffortFormat'] === undefined
    ? undefined
    : isApiType(value['reasoningEffortFormat'])
      ? value['reasoningEffortFormat']
      : null;
  if (reasoningEffortFormat === null) {
    return undefined;
  }
  const credentialMode =
    value['credentialMode'] === undefined
      ? 'apiKey'
      : value['credentialMode'] === 'apiKey' || value['credentialMode'] === 'none'
        ? value['credentialMode']
        : null;
  if (credentialMode === null) {
    return undefined;
  }
  return {
    vendor: value['vendor'],
    groupName,
    id: id.trim(),
    name: name.trim(),
    url: url.trim(),
    apiType: value['apiType'],
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    toolCalling,
    vision,
    thinking,
    streaming,
    supportsReasoningEffort: normalizeEffortLevels(value['supportsReasoningEffort']).slice(0, 20),
    defaultReasoningEffort,
    reasoningEffortFormat,
    apiKey,
    credentialMode,
    allowInsecureHttp: bool(value['allowInsecureHttp']) ?? false,
  };
}

export function parseModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value) || !isVendorId(value['vendor'])) {
    return undefined;
  }
  const groupName = text(value['groupName'], 200);
  const id = text(value['id'], 500);
  if (!groupName || !id) {
    return undefined;
  }
  return { vendor: value['vendor'], groupName, id };
}

export function parseGroupRef(value: unknown): GroupRef | undefined {
  if (!isRecord(value) || !isVendorId(value['vendor'])) {
    return undefined;
  }
  const groupName = text(value['groupName'], 200);
  if (!groupName) {
    return undefined;
  }
  return { vendor: value['vendor'], groupName };
}

function parseFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function parseJsonText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_JSON_LENGTH ? value : undefined;
}

function payloadObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return {};
  }
  return isRecord(value) ? value : undefined;
}

function invalid(message: string, field?: string): ParsedRequestFailure['error'] {
  return { code: 'validation', message, field };
}

export function parseWebviewRequest(value: unknown): WebviewRequest | ParsedRequestFailure {
  const requestId = isRecord(value) && typeof value['requestId'] === 'string' ? value['requestId'] : '';
  if (!isRecord(value)) {
    return { requestId, error: invalid('消息格式无效。') };
  }
  const type = value['type'];
  if (!isRequestType(type)) {
    return { requestId, error: { code: 'unsupported', message: '未知的消息类型，已拒绝。' } };
  }
  if (!REQUEST_ID.test(requestId)) {
    return { requestId, error: invalid('requestId 无效。') };
  }
  const payload = payloadObject(value['payload']);
  if (!payload) {
    return { requestId, error: invalid('payload 必须是对象。') };
  }

  switch (type) {
    case 'config/list':
    case 'legacy/openSetting':
    case 'connection/cancel':
    case 'panel/openOfficial':
    case 'panel/openConfigFile':
    case 'panel/openBackups':
    case 'ui/refresh':
      return { type, requestId, payload: {} } as WebviewRequest;
    case 'config/save': {
      const draft = parseModelDraft(payload['draft']);
      const expectedFingerprint = parseFingerprint(payload['expectedFingerprint']);
      const original = payload['original'] === undefined ? undefined : parseModelRef(payload['original']);
      if (!draft) {
        return { requestId, error: invalid('模型配置数据无效。') };
      }
      if (!expectedFingerprint) {
        return { requestId, error: invalid('缺少配置快照标识。') };
      }
      if (payload['original'] !== undefined && !original) {
        return { requestId, error: invalid('原始模型引用无效。') };
      }
      return { type, requestId, payload: { draft, expectedFingerprint, original } };
    }
    case 'config/delete': {
      const ref = parseModelRef(payload['ref']);
      const expectedFingerprint = parseFingerprint(payload['expectedFingerprint']);
      if (!ref || !expectedFingerprint) {
        return { requestId, error: invalid('删除请求参数无效。') };
      }
      return { type, requestId, payload: { ref, expectedFingerprint } };
    }
    case 'config/deleteGroup':
    case 'group/clearApiKey': {
      const group = parseGroupRef(payload['group']);
      const expectedFingerprint = parseFingerprint(payload['expectedFingerprint']);
      if (!group || !expectedFingerprint) {
        return { requestId, error: invalid('分组操作参数无效。') };
      }
      return { type, requestId, payload: { group, expectedFingerprint } };
    }
    case 'group/promptApiKey': {
      const group = parseGroupRef(payload['group']);
      if (!group) {
        return { requestId, error: invalid('分组操作参数无效。') };
      }
      return { type, requestId, payload: { group } };
    }
    case 'config/export':
      return { type, requestId, payload: { copy: bool(payload['copy']) ?? false } };
    case 'config/exportSave': {
      const json = parseJsonText(payload['json']);
      if (!json) {
        return { requestId, error: invalid('导出内容无效。') };
      }
      return { type, requestId, payload: { json } };
    }
    case 'config/import': {
      const json = parseJsonText(payload['json']);
      if (!json) {
        return { requestId, error: invalid('导入内容为空或过大。') };
      }
      return { type, requestId, payload: { json } };
    }
    case 'config/importApply': {
      const json = parseJsonText(payload['json']);
      const expectedFingerprint = parseFingerprint(payload['expectedFingerprint']);
      if (!json || !expectedFingerprint) {
        return { requestId, error: invalid('导入请求参数无效。') };
      }
      return { type, requestId, payload: { json, expectedFingerprint } };
    }
    case 'legacy/import': {
      const expectedFingerprint = parseFingerprint(payload['expectedFingerprint']);
      if (!expectedFingerprint) {
        return { requestId, error: invalid('导入请求参数无效。') };
      }
      return { type, requestId, payload: { expectedFingerprint } };
    }
    case 'connection/test': {
      const draft = parseModelDraft(payload['draft']);
      if (!draft) {
        return { requestId, error: invalid('测试参数无效。') };
      }
      return { type, requestId, payload: { draft } };
    }
    case 'ui/dirty': {
      const dirty = bool(payload['dirty']);
      if (dirty === undefined) {
        return { requestId, error: invalid('脏状态参数无效。') };
      }
      return { type, requestId, payload: { dirty } };
    }
  }
}

export function isRequestFailure(value: WebviewRequest | ParsedRequestFailure): value is ParsedRequestFailure {
  return 'error' in value;
}

/** 后端验证的一次性请求标识，用于拒绝重复保存/删除等重放。 */
export class RequestLedger {
  private readonly seen = new Map<string, number>();
  private readonly limit: number;

  constructor(limit = 300) {
    this.limit = limit;
  }

  accept(requestId: string): boolean {
    if (this.seen.has(requestId)) {
      return false;
    }
    this.seen.set(requestId, Date.now());
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next();
      if (oldest.done) {
        break;
      }
      this.seen.delete(oldest.value);
    }
    return true;
  }
}

export type { ConfigSnapshot, ConnectionTestResult, ImportPreview };
