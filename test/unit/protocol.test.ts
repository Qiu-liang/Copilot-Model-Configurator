import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRequestFailure,
  parseModelDraft,
  parseWebviewRequest,
  RequestLedger,
} from '../../src/panel/protocol.ts';

const draft = {
  vendor: 'customendpoint',
  groupName: 'G',
  id: 'm',
  name: 'M',
  url: 'https://x.test/v1/chat/completions',
  apiType: 'chat-completions',
  contextWindow: 1000,
  maxInputTokens: 900,
  maxOutputTokens: 100,
  toolCalling: true,
  vision: false,
  thinking: false,
  streaming: true,
  supportsReasoningEffort: [],
  credentialMode: 'apiKey',
};

test('合法保存请求被解析', () => {
  const parsed = parseWebviewRequest({
    type: 'config/save',
    requestId: 'r-1',
    payload: { draft, expectedFingerprint: 'f'.repeat(64), original: { vendor: 'customendpoint', groupName: 'G', id: 'm' } },
  });
  assert.equal(isRequestFailure(parsed), false);
  if (!isRequestFailure(parsed) && parsed.type === 'config/save') {
    assert.equal(parsed.payload.draft.id, 'm');
    assert.equal(parsed.payload.original?.id, 'm');
  }
});

test('未知消息类型被拒绝', () => {
  const parsed = parseWebviewRequest({ type: 'config/destroy', requestId: 'r-1', payload: {} });
  assert.equal(isRequestFailure(parsed), true);
  if (isRequestFailure(parsed)) {
    assert.equal(parsed.error.code, 'unsupported');
  }
});

test('非法 requestId 被拒绝', () => {
  const parsed = parseWebviewRequest({ type: 'config/list', requestId: 'bad id', payload: {} });
  assert.equal(isRequestFailure(parsed), true);
  if (isRequestFailure(parsed)) {
    assert.equal(parsed.requestId, 'bad id');
    assert.equal(parsed.error.code, 'validation');
  }
});

test('保存请求缺少 payload 被拒绝', () => {
  const parsed = parseWebviewRequest({ type: 'config/save', requestId: 'r-2' });
  assert.equal(isRequestFailure(parsed), true);
});

test('不完整的模型草稿被拒绝', () => {
  const parsed = parseWebviewRequest({
    type: 'config/save',
    requestId: 'r-3',
    payload: { draft: { ...draft, vendor: 'unknown' }, expectedFingerprint: 'f'.repeat(64) },
  });
  assert.equal(isRequestFailure(parsed), true);
});

test('未知凭据模式被拒绝', () => {
  assert.equal(parseModelDraft({ ...draft, credentialMode: 'magic' }), undefined);
  const parsed = parseModelDraft({ ...draft, credentialMode: 'none' });
  assert.equal(parsed?.credentialMode, 'none');
});

test('模型草稿会被去空白与规范化', () => {
  const parsed = parseModelDraft({
    ...draft,
    id: '  model-1 ',
    name: ' Name ',
    url: ' https://x.test ',
    supportsReasoningEffort: ['low', 'LOW', ' high '],
  });
  assert.equal(parsed?.id, 'model-1');
  assert.equal(parsed?.name, 'Name');
  assert.equal(parsed?.url, 'https://x.test');
  assert.deepEqual(parsed?.supportsReasoningEffort, ['low', 'high']);
});

test('无 payload 的请求接受空对象', () => {
  const parsed = parseWebviewRequest({ type: 'config/list', requestId: 'r-4', payload: {} });
  assert.equal(isRequestFailure(parsed), false);
  const withoutPayload = parseWebviewRequest({ type: 'config/list', requestId: 'r-5' });
  assert.equal(isRequestFailure(withoutPayload), false);
});

test('更新分组密钥必须携带快照标识', () => {
  const missing = parseWebviewRequest({
    type: 'group/promptApiKey',
    requestId: 'r-6',
    payload: { group: { vendor: 'customendpoint', groupName: 'G' } },
  });
  assert.equal(isRequestFailure(missing), true);
  if (isRequestFailure(missing)) {
    assert.equal(missing.error.code, 'validation');
  }

  const parsed = parseWebviewRequest({
    type: 'group/promptApiKey',
    requestId: 'r-7',
    payload: { group: { vendor: 'customendpoint', groupName: 'G' }, expectedFingerprint: 'f'.repeat(64) },
  });
  assert.equal(isRequestFailure(parsed), false);
  if (!isRequestFailure(parsed) && parsed.type === 'group/promptApiKey') {
    assert.equal(parsed.payload.group.groupName, 'G');
    assert.equal(parsed.payload.expectedFingerprint.length, 64);
  }
});

test('请求账本拒绝重复标识', () => {
  const ledger = new RequestLedger();
  assert.equal(ledger.accept('a'), true);
  assert.equal(ledger.accept('a'), false);
  assert.equal(ledger.accept('b'), true);
});

test('请求账本按上限淘汰旧标识', () => {
  const ledger = new RequestLedger(2);
  assert.equal(ledger.accept('a'), true);
  assert.equal(ledger.accept('b'), true);
  assert.equal(ledger.accept('c'), true);
  assert.equal(ledger.accept('a'), true, '最旧标识已被淘汰');
});
