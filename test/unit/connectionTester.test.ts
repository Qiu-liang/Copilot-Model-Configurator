import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { ConnectionTester, expectedRequestUrl } from '../../src/services/ConnectionTester.ts';
import type { ModelDraft } from '../../src/models/modelConfig.ts';

const originalFetch = globalThis.fetch;

function draft(patch: Partial<ModelDraft> = {}): ModelDraft {
  return {
    vendor: 'customendpoint',
    groupName: 'G',
    id: 'model-1',
    name: 'Model 1',
    url: 'https://api.example.com/v1/chat/completions',
    apiType: 'chat-completions',
    contextWindow: 1000,
    maxInputTokens: 900,
    maxOutputTokens: 100,
    toolCalling: true,
    vision: false,
    thinking: false,
    streaming: true,
    supportsReasoningEffort: [],
    ...patch,
  };
}

interface Captured {
  url?: string;
  init?: RequestInit;
}

let captured: Captured;

beforeEach(() => {
  captured = {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    captured.url = url;
    captured.init = init;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

const tester = new ConnectionTester(() => 5);

test('成功请求返回 ok 与耗时', async () => {
  stubFetch(() => new Response('{"ok":true}', { status: 200 }));
  const result = await tester.test(draft({ apiKey: 'sk-secret' }));
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.message.includes('sk-secret'), false);
});

test('Bearer 认证头用于 chat-completions', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  await tester.test(draft({ apiKey: '  sk-abc  ' }));
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer sk-abc');
  assert.equal(headers['content-type'], 'application/json');
});

test('Messages 使用 x-api-key 与 anthropic-version', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  await tester.test(draft({ apiType: 'messages', url: 'https://api.example.com/v1/messages', apiKey: 'key-1' }));
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'key-1');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal('authorization' in headers, false);
});

test('Responses 请求体包含 input', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  await tester.test(draft({ apiType: 'responses', url: 'https://api.example.com/v1/responses' }));
  const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
  assert.equal(body['model'], 'model-1');
  assert.ok('input' in body);
  assert.equal(body['stream'], false);
});

test('401 映射为认证失败且消息中的密钥被脱敏', async () => {
  stubFetch(() => new Response(JSON.stringify({ error: { message: 'bad key sk-leaked12345678' } }), { status: 401 }));
  const result = await tester.test(draft({ apiKey: 'sk-leaked12345678' }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'auth');
  assert.equal(result.message.includes('sk-leaked12345678'), false);
  assert.ok(result.message.includes('***'));
});

test('404、429、500 分别映射', async () => {
  for (const [status, kind] of [
    [404, 'not-found'],
    [429, 'rate-limit'],
    [500, 'server'],
  ] as const) {
    stubFetch(() => new Response('{}', { status }));
    const result = await tester.test(draft());
    assert.equal(result.kind, kind, `status ${status}`);
  }
});

test('网络错误归类为 unknown 且不泄露密钥', async () => {
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED with sk-abcdefghijkl');
  }) as typeof fetch;
  const result = await tester.test(draft({ apiKey: 'sk-abcdefghijkl' }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unknown');
  assert.equal(result.message.includes('sk-abcdefghijkl'), false);
});

test('DNS 错误归类', async () => {
  globalThis.fetch = (async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { cause: { code: 'ENOTFOUND' } });
  }) as typeof fetch;
  const result = await tester.test(draft());
  assert.equal(result.kind, 'dns');
});

test('超时归类', async () => {
  const quick = new ConnectionTester(() => 0.01);
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
  const result = await quick.test(draft());
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'timeout');
});

test('请求体上限受控且不发送 stream true', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  await tester.test(draft());
  const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
  assert.equal(body['stream'], false);
  assert.equal(body['max_tokens'], 16);
});

test('显式端点不被追加路径', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  await tester.test(draft({ url: 'https://api.example.com/custom/chat/completions' }));
  assert.equal(captured.url, 'https://api.example.com/custom/chat/completions');
});

test('expectedRequestUrl 与运行时推导一致', () => {
  assert.equal(expectedRequestUrl('https://x.test', 'chat-completions'), 'https://x.test/v1/chat/completions');
  assert.equal(expectedRequestUrl('https://x.test/v1/responses', 'chat-completions'), 'https://x.test/v1/responses');
});

test('缺少已保存凭据时给出配置提示', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  const result = await tester.test(draft(), { requiresExistingCredential: true, hasStoredCredential: false });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
  assert.ok(result.message.includes('API Key'));
  assert.equal(captured.url, undefined, '不应发送网络请求');
});

test('存在已保存凭据但未重新输入时不发送请求', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  const result = await tester.test(draft(), { requiresExistingCredential: true, hasStoredCredential: true });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'config');
  assert.equal(captured.url, undefined);
});

test('重定向不被跟随并归类为 redirect', async () => {
  stubFetch(() => new Response('', { status: 302, headers: { location: 'https://other.test' } }));
  const result = await tester.test(draft());
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'redirect');
});

test('用户取消测试返回 canceled', async () => {
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
  const pendingTest = tester.test(draft());
  assert.equal(tester.cancel(), true);
  const result = await pendingTest;
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'canceled');
});

test('新测试会取消旧测试', async () => {
  let rejectFirst: ((error: Error) => void) | undefined;
  let call = 0;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    call += 1;
    if (call === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = reject;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
  const first = tester.test(draft({ id: 'first' }));
  const second = tester.test(draft({ id: 'second' }));
  assert.ok(rejectFirst);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.kind, 'canceled');
  assert.equal(secondResult.ok, true);
});
