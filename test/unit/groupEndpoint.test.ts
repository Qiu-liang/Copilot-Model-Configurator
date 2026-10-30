import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawGroup } from '../../src/models/configDocument.ts';
import {
  applyGroupEndpoint,
  applyGroupEndpointToModel,
  deriveBaseUrl,
  normalizeBaseUrl,
  readGroupApiType,
  readGroupBaseUrl,
  validateGroupEndpoint,
} from '../../src/models/groupEndpoint.ts';
import { hasErrors } from '../../src/models/draft.ts';

test('基地址去掉末尾斜杠与具体 API 路径', () => {
  assert.equal(normalizeBaseUrl(' https://api.example.com/v1/chat/completions/ '), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/responses'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/messages/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl(''), '');
});

test('旧分组从首个模型 URL 推导基地址与类型', () => {
  const group: RawGroup = {
    name: 'G',
    vendor: 'customendpoint',
    models: [{ id: 'a', url: 'https://x.test/v1/chat/completions' }],
  };
  assert.equal(readGroupBaseUrl(group), 'https://x.test/v1');
  assert.equal(readGroupApiType(group), 'chat-completions');
});

test('分组字段优先于模型推导', () => {
  const group: RawGroup = {
    name: 'G',
    vendor: 'customendpoint',
    baseUrl: 'https://y.test/api',
    apiType: 'responses',
    models: [{ id: 'a', url: 'https://x.test/v1/chat/completions', apiType: 'chat-completions' }],
  };
  assert.equal(readGroupBaseUrl(group), 'https://y.test/api');
  assert.equal(readGroupApiType(group), 'responses');
});

test('批量应用重写全部模型地址并移除模型级类型', () => {
  const group: RawGroup = {
    name: 'G',
    vendor: 'customendpoint',
    apiKey: '${input:chat.lm.secret.keep}',
    models: [
      { id: 'a', url: 'https://x.test/v1/chat/completions', apiType: 'chat-completions', vision: true },
      { id: 'b', url: 'https://x.test/v1/responses' },
    ],
  };
  applyGroupEndpoint(group, 'https://api.example.com/v1/chat/completions', 'responses');
  assert.equal(group['baseUrl'], 'https://api.example.com/v1');
  assert.equal(group['apiType'], 'responses');
  assert.equal(group['apiKey'], '${input:chat.lm.secret.keep}');
  const models = group['models'] as Record<string, unknown>[];
  assert.equal(models[0]?.['url'], 'https://api.example.com/v1/responses');
  assert.equal(models[1]?.['url'], 'https://api.example.com/v1/responses');
  assert.equal('apiType' in (models[0] as object), false);
  assert.equal(models[0]?.['vision'], true);
});

test('单模型应用只改目标模型', () => {
  const model: Record<string, unknown> = { id: 'a', url: 'https://x.test/v1/chat/completions', apiType: 'chat-completions' };
  applyGroupEndpointToModel(model, 'https://api.example.com', 'messages');
  assert.equal(model['url'], 'https://api.example.com/v1/messages');
  assert.equal('apiType' in model, false);
});

test('空分组无法推导地址', () => {
  assert.equal(deriveBaseUrl([]), undefined);
  const group: RawGroup = { name: 'G', vendor: 'customendpoint', models: [] };
  assert.equal(readGroupBaseUrl(group), undefined);
  assert.equal(readGroupApiType(group), undefined);
});

test('分组地址校验拒绝空值、非法协议与内嵌凭据', () => {
  assert.ok(validateGroupEndpoint('', 'chat-completions').some((issue) => issue.field === 'baseUrl'));
  assert.ok(validateGroupEndpoint('ftp://x.test', 'chat-completions').some((issue) => issue.field === 'baseUrl'));
  assert.ok(
    validateGroupEndpoint('https://user:pass@x.test', 'chat-completions').some((issue) => issue.field === 'baseUrl'),
  );
});

test('非本机 http 需要显式确认，本机地址放行', () => {
  assert.ok(validateGroupEndpoint('http://192.168.1.2:8080', 'chat-completions').some((issue) => issue.field === 'baseUrl'));
  assert.equal(hasErrors(validateGroupEndpoint('http://192.168.1.2:8080', 'chat-completions', true)), false);
  assert.equal(hasErrors(validateGroupEndpoint('http://localhost:11434', 'chat-completions')), false);
});
