import * as vscode from 'vscode';
import type { VendorId } from '../models/modelConfig.ts';
import { isApiType } from '../models/draft.ts';
import type { ApiType } from '../models/modelConfig.ts';

export interface ProviderDescriptor {
  vendor: VendorId;
  displayName: string;
  deprecated: boolean;
  supported: boolean;
  capabilities: ModelCapabilities;
  modelCapabilities: ModelCapabilities;
}

export interface ModelCapabilities {
  supportsApiType: boolean;
  supportsReasoningEffort: boolean;
  supportsReasoningEffortFormat: boolean;
  supportsThinking: boolean;
  supportsDefaultReasoningEffort: boolean;
}

const EMPTY_CAPABILITIES: ModelCapabilities = {
  supportsApiType: false,
  supportsReasoningEffort: false,
  supportsReasoningEffortFormat: false,
  supportsThinking: false,
  supportsDefaultReasoningEffort: false,
};

interface LanguageModelProviderContribution {
  vendor?: unknown;
  displayName?: unknown;
  configuration?: {
    properties?: Record<string, { items?: { properties?: Record<string, unknown> } }>;
  };
}

interface ExtensionPackageJson {
  version?: string;
  contributes?: {
    languageModelChatProviders?: LanguageModelProviderContribution[];
  };
}

/**
 * 读取当前安装的 Copilot 扩展声明的语言模型提供方 Schema，
 * 用于在 UI 中只展示目标版本真正支持的字段。
 */
export class ProviderRegistry {
  private descriptors: ProviderDescriptor[] = [];
  private copilotVersion: string | undefined;

  async initialize(): Promise<void> {
    this.descriptors = [];
    this.copilotVersion = undefined;
    const extension = vscode.extensions.getExtension('GitHub.copilot-chat');
    if (!extension) {
      return;
    }
    this.copilotVersion = extension.packageJSON?.version;
    const contributes = (extension.packageJSON as ExtensionPackageJson | undefined)?.contributes;
    const providers = contributes?.languageModelChatProviders ?? [];
    for (const provider of providers) {
      const vendor = provider.vendor;
      if (vendor !== 'customendpoint' && vendor !== 'customoai') {
        continue;
      }
      this.descriptors.push(describeProvider(vendor, provider));
    }
  }

  get version(): string | undefined {
    return this.copilotVersion;
  }

  list(): ProviderDescriptor[] {
    return this.descriptors;
  }

  availableVendors(): VendorId[] {
    return this.descriptors.map((descriptor) => descriptor.vendor);
  }

  get(vendor: VendorId): ProviderDescriptor | undefined {
    return this.descriptors.find((descriptor) => descriptor.vendor === vendor);
  }

  /** 仅用于测试：注入或覆盖提供方能力，不改变生产路径。 */
  overrideForTesting(vendor: VendorId, capabilities: Partial<ModelCapabilities>): void {
    const index = this.descriptors.findIndex((descriptor) => descriptor.vendor === vendor);
    const current: ProviderDescriptor = this.descriptors[index] ?? {
      vendor,
      displayName: vendor,
      deprecated: vendor === 'customoai',
      supported: true,
      capabilities: EMPTY_CAPABILITIES,
      modelCapabilities: EMPTY_CAPABILITIES,
    };
    const next: ProviderDescriptor = {
      ...current,
      modelCapabilities: { ...current.modelCapabilities, ...capabilities },
    };
    if (index >= 0) {
      this.descriptors[index] = next;
    } else {
      this.descriptors.push(next);
    }
  }

  /** 默认写入目标：优先 customendpoint，其次 customoai。 */
  preferredVendor(): VendorId {
    if (this.get('customendpoint')) {
      return 'customendpoint';
    }
    if (this.get('customoai')) {
      return 'customoai';
    }
    return 'customendpoint';
  }
}

function describeProvider(vendor: VendorId, provider: LanguageModelProviderContribution): ProviderDescriptor {
  const configuration = provider.configuration?.properties ?? {};
  const modelProperties = configuration['models']?.items?.properties ?? {};
  const deprecated = vendor === 'customoai';
  const groupCapabilities: ModelCapabilities = {
    ...EMPTY_CAPABILITIES,
    supportsApiType: Boolean(configuration['apiType']),
  };
  const modelCapabilities: ModelCapabilities = {
    supportsApiType: Boolean(modelProperties['apiType']),
    supportsReasoningEffort: Boolean(modelProperties['supportsReasoningEffort']),
    supportsReasoningEffortFormat: Boolean(modelProperties['reasoningEffortFormat']),
    supportsThinking: Boolean(modelProperties['thinking']),
    supportsDefaultReasoningEffort: Boolean(modelProperties['defaultReasoningEffort']),
  };
  return {
    vendor,
    displayName: typeof provider.displayName === 'string' ? provider.displayName : vendor,
    deprecated,
    supported: Boolean(modelProperties['id']) && Boolean(modelProperties['url']),
    capabilities: groupCapabilities,
    modelCapabilities,
  };
}

export function defaultApiTypeFor(vendor: VendorId, descriptor: ProviderDescriptor | undefined): ApiType | undefined {
  if (vendor === 'customoai') {
    return 'chat-completions';
  }
  return descriptor?.capabilities.supportsApiType ? 'chat-completions' : undefined;
}

export function isSupportedApiType(value: unknown): value is ApiType {
  return isApiType(value);
}
