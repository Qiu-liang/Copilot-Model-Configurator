import assert from 'node:assert/strict';
import test from 'node:test';
import { redactForLog, redactText, redactUrl } from '../../src/services/redact.ts';

test('已知密钥被替换', () => {
  assert.equal(redactText('key is abc-secret-123', ['abc-secret-123']), 'key is ***');
});

test('常见 token 形式被替换', () => {
  const result = redactText('Authorization: Bearer abcdefghijklmnop and sk-1234567890abcdef');
  assert.equal(result.includes('abcdefghijklmnop'), false);
  assert.equal(result.includes('sk-1234567890abcdef'), false);
  assert.ok(result.includes('***'));
});

test('查询参数中的敏感字段被替换', () => {
  const result = redactText('https://x.test/v1?api_key=hidden-value&other=1');
  assert.equal(result.includes('hidden-value'), false);
  assert.ok(result.includes('api_key=***'));
});

test('日志脱敏移除查询字符串', () => {
  const result = redactForLog('请求 https://x.test/path?token=secret-value 失败');
  assert.equal(result.includes('secret-value'), false);
  assert.equal(result.includes('?'), false);
  assert.ok(result.includes('https://x.test/path'));
});

test('URL 脱敏仅保留 origin 与 path', () => {
  assert.equal(redactUrl('https://user:pass@x.test/v1?key=1'), 'https://x.test/v1');
  assert.equal(redactUrl('not-a-url'), 'not-a-url');
});
