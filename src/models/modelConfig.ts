export type VendorId = 'customendpoint' | 'customoai';

export type ApiType = 'chat-completions' | 'responses' | 'messages';

export type ReasoningEffortFormat = ApiType;

/** 凭据使用方式：apiKey 表示输入/沿用密钥，none 表示本地服务明确无需认证。 */
export type CredentialMode = 'apiKey' | 'none';

export const DEFAULT_API_TYPE: ApiType = 'chat-completions';

export const API_TYPES: readonly ApiType[] = ['chat-completions', 'responses', 'messages'];

export const VENDOR_LABELS: Record<VendorId, string> = {
  customendpoint: 'Custom Endpoint',
  customoai: 'OpenAI Compatible（已弃用）',
};

export const COMMON_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const LEGACY_SETTING = 'github.copilot.chat.customOAIModels';

export const LEGACY_GROUP_NAME = 'OpenAI Compatible（旧版设置）';

export interface ModelDraft {
  vendor: VendorId;
  groupName: string;
  id: string;
  name: string;
  url: string;
  apiType: ApiType;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  vision: boolean;
  thinking: boolean;
  streaming: boolean;
  supportsReasoningEffort: string[];
  defaultReasoningEffort?: string;
  reasoningEffortFormat?: ReasoningEffortFormat;
  apiKey?: string;
  credentialMode?: CredentialMode;
  /** 表单专用：允许向非本机 http 地址发送凭据。不落盘。 */
  allowInsecureHttp?: boolean;
}

export interface ModelRecord extends ModelDraft {
  /** 原始配置对象，用于保留面板不认识的字段。 */
  raw: Record<string, unknown>;
}

export interface ProviderGroup {
  name: string;
  vendor: VendorId;
  models: ModelRecord[];
  /** 分组级凭据是否存在（永远不回传密钥本身）。 */
  hasApiKey: boolean;
  apiType?: ApiType;
  raw: Record<string, unknown>;
}

export type ConfigSource = 'file' | 'settings-legacy' | 'settings-empty';

export interface VendorInfo {
  vendor: VendorId;
  label: string;
  deprecated: boolean;
  available: boolean;
  supportsModelApiType: boolean;
  supportsReasoningEffortFormat: boolean;
  supportsDefaultReasoningEffort: boolean;
}

export interface ConfigSnapshot {
  groups: ProviderGroup[];
  legacyModels: ModelRecord[];
  source: ConfigSource;
  adapterAvailable: boolean;
  adapterMessage?: string;
  fingerprint: string;
  configFilePath?: string;
  vendors: VendorId[];
  vendorInfo: VendorInfo[];
  preferredVendor: VendorId;
  dashboardAvailable: boolean;
  writeEnabled: boolean;
  credentialWriteEnabled: boolean;
  hasMigrateCommand: boolean;
  copilotVersion?: string;
  vscodeVersion: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity?: 'error' | 'warning';
}

export type ConnectionErrorKind =
  | 'dns'
  | 'timeout'
  | 'tls'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'server'
  | 'redirect'
  | 'response'
  | 'config'
  | 'canceled'
  | 'unknown';

export interface ConnectionTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
  kind?: ConnectionErrorKind;
}

export interface ModelRef {
  vendor: VendorId;
  groupName: string;
  id: string;
}

export interface GroupRef {
  vendor: VendorId;
  groupName: string;
}

export interface ImportPreviewGroup {
  vendor: string;
  name: string;
  modelIds: string[];
  conflict: boolean;
  issues: ValidationIssue[];
}

export interface ImportPreview {
  groups: ImportPreviewGroup[];
  totalModels: number;
  strippedCredentials: boolean;
  warnings: ValidationIssue[];
  canApply: boolean;
}

export const DEFAULT_MODEL_VALUES = {
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
} as const;
