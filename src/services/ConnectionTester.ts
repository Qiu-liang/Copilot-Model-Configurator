import type { ConnectionErrorKind, ConnectionTestResult, ModelDraft } from '../models/modelConfig.ts';
import { hasExplicitApiPath, resolveRequestUrl } from '../models/draft.ts';
import { redactText } from './redact.ts';

const TEST_PROMPT = 'Reply with the single word: ok';

interface TestControl {
  controller: AbortController;
  canceled: boolean;
  timedOut: boolean;
}

export interface CredentialState {
  requiresExistingCredential?: boolean;
  hasStoredCredential?: boolean;
}

export class ConnectionTester {
  private readonly timeoutSeconds: () => number;
  private active: TestControl | undefined;

  constructor(timeoutSeconds: () => number) {
    this.timeoutSeconds = timeoutSeconds;
  }

  /** 开始新测试前取消旧测试；用户取消返回 true。 */
  cancel(): boolean {
    const active = this.active;
    if (!active) {
      return false;
    }
    active.canceled = true;
    active.controller.abort();
    this.active = undefined;
    return true;
  }

  async test(draft: ModelDraft, credentialState: CredentialState = {}): Promise<ConnectionTestResult> {
    this.cancel();
    const started = Date.now();
    if (credentialState.requiresExistingCredential && !credentialState.hasStoredCredential) {
      return failure('config', 0, '该分组还没有保存 API Key。请先填写并保存 Key，或在测试时临时输入。');
    }
    if (credentialState.hasStoredCredential && !draft.apiKey?.trim()) {
      return failure(
        'config',
        0,
        '已保存的 Key 不会回传到面板，因此无法直接测试。请重新输入 Key 进行测试，或只保存配置。',
      );
    }
    let url: string;
    try {
      url = resolveRequestUrl(draft.url.trim(), draft.apiType);
    } catch (error) {
      return failure('config', 0, `无法构造请求地址：${asMessage(error)}`);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return failure('config', Date.now() - started, 'API 地址无效。');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return failure('config', Date.now() - started, '只支持 http 或 https 地址。');
    }

    const control: TestControl = { controller: new AbortController(), canceled: false, timedOut: false };
    this.active = control;
    const timeoutMs = Math.max(3, this.timeoutSeconds()) * 1000;
    const timer = setTimeout(() => {
      control.timedOut = true;
      control.controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: control.controller.signal,
        headers: this.headers(draft),
        body: JSON.stringify(this.body(draft)),
      });
    } catch (error) {
      const latency = Date.now() - started;
      if (control.canceled) {
        return failure('canceled', latency, '测试已取消。');
      }
      if (control.timedOut) {
        return failure('timeout', latency, `请求在 ${timeoutMs / 1000} 秒后超时。`);
      }
      if (isDnsError(error)) {
        return failure('dns', latency, '无法解析主机名，请检查 URL 或网络。');
      }
      if (isTlsError(error)) {
        return failure('tls', latency, 'TLS 握手失败，可能是证书或代理问题。');
      }
      return failure('unknown', latency, `连接失败：${redactText(asMessage(error), [draft.apiKey])}`);
    } finally {
      clearTimeout(timer);
      if (this.active === control) {
        this.active = undefined;
      }
    }

    if (control.canceled) {
      return failure('canceled', Date.now() - started, '测试已取消。');
    }
    const latency = Date.now() - started;
    const text = await readLimited(response, 8_192);
    if (control.canceled) {
      return failure('canceled', Date.now() - started, '测试已取消。');
    }
    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        latencyMs: latency,
        message: `请求成功（HTTP ${response.status}，${latency} ms）。仅验证最小请求，不代表视觉、工具或思考强度已通过验证。`,
      };
    }

    const kind = classifyStatus(response.status);
    return {
      ok: false,
      status: response.status,
      latencyMs: latency,
      kind,
      message: `${statusMessage(kind)}（HTTP ${response.status}）。${extractUpstreamMessage(text, draft.apiKey)}`.trim(),
    };
  }

  private headers(draft: ModelDraft): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = draft.apiKey?.trim();
    if (key) {
      if (draft.apiType === 'messages') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['authorization'] = `Bearer ${key}`;
      }
    }
    return headers;
  }

  private body(draft: ModelDraft): Record<string, unknown> {
    if (draft.apiType === 'responses') {
      return {
        model: draft.id.trim(),
        input: TEST_PROMPT,
        max_output_tokens: 16,
        stream: false,
      };
    }
    if (draft.apiType === 'messages') {
      return {
        model: draft.id.trim(),
        max_tokens: 16,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      };
    }
    return {
      model: draft.id.trim(),
      messages: [{ role: 'user', content: TEST_PROMPT }],
      max_tokens: 16,
      stream: false,
    };
  }
}

function failure(kind: ConnectionErrorKind, latencyMs: number, message: string): ConnectionTestResult {
  return { ok: false, kind, latencyMs, message };
}

function classifyStatus(status: number): ConnectionErrorKind {
  if (status >= 300 && status < 400) {
    return 'redirect';
  }
  if (status === 401) {
    return 'auth';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 429) {
    return 'rate-limit';
  }
  if (status >= 500) {
    return 'server';
  }
  return 'response';
}

function statusMessage(kind: ConnectionErrorKind): string {
  switch (kind) {
    case 'auth':
      return '认证失败，请检查 API Key';
    case 'forbidden':
      return '服务方拒绝了访问';
    case 'not-found':
      return '端点或模型不存在，请检查 URL 和模型 ID';
    case 'rate-limit':
      return '请求被限流';
    case 'server':
      return '服务方内部错误';
    case 'redirect':
      return '请求被重定向，请直接填写最终的完整端点';
    default:
      return '请求未成功';
  }
}

function extractUpstreamMessage(raw: string, secret: string | undefined): string {
  if (!raw.trim()) {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string') {
        return `服务方返回：${redactText(error, [secret]).slice(0, 300)}`;
      }
      if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
        return `服务方返回：${redactText((error as { message: string }).message, [secret]).slice(0, 300)}`;
      }
      if (typeof (parsed as { message?: unknown }).message === 'string') {
        return `服务方返回：${redactText((parsed as { message: string }).message, [secret]).slice(0, 300)}`;
      }
    }
  } catch {
    // 非 JSON 响应只保留截断后的文本。
  }
  return `服务方返回：${redactText(raw.slice(0, 200), [secret])}`;
}

function isDnsError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

function isTlsError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return (
    typeof code === 'string' &&
    (code.startsWith('CERT_') || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  );
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, limit).toString('utf8');
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function expectedRequestUrl(url: string, apiType: ModelDraft['apiType']): string {
  return hasExplicitApiPath(url) ? url : resolveRequestUrl(url, apiType);
}
