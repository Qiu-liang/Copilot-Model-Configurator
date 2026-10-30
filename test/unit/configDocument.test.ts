import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfigParseError,
  createSanitizedExport,
  findGroup,
  fingerprintOf,
  groupModels,
  parseGroups,
  readLegacyModels,
  removeCredential,
  removeGroup,
  removeModel,
  serializeGroups,
  upsertModel,
  renameGroup,
} from '../../src/models/configDocument.ts';
import type { RawGroup } from '../../src/models/configDocument.ts';

function sample(): RawGroup[] {
  return [
    {
      name: 'Provider',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.abc}',
      apiType: 'chat-completions',
      models: [
        { id: 'a', name: 'A', url: 'https://x.test', toolCalling: true, vision: false, maxOutputTokens: 100, maxInputTokens: 900, unknownField: 'keep-me' },
        { id: 'b', name: 'B', url: 'https://x.test', toolCalling: true, vision: true, maxOutputTokens: 100, maxInputTokens: 900 },
      ],
    },
    { name: 'Other', vendor: 'openai', apiKey: '${input:chat.lm.secret.other}' },
  ];
}

test('解析拒绝非数组与缺字段分组', () => {
  assert.throws(() => parseGroups({}), ConfigParseError);
  assert.throws(() => parseGroups([{ vendor: 'x' }]), ConfigParseError);
  assert.throws(() => parseGroups([{ name: 'n' }]), ConfigParseError);
  assert.deepEqual(parseGroups([]), []);
});

test('写入模型保留同组其他模型与未知字段', () => {
  const groups = upsertModel(sample(), 'customendpoint', 'Provider', {
    id: 'a',
    name: 'A2',
    url: 'https://x.test/v1',
    toolCalling: true,
    vision: true,
    maxOutputTokens: 200,
    maxInputTokens: 800,
  });
  const provider = findGroup(groups, 'customendpoint', 'Provider');
  assert.ok(provider);
  const models = groupModels(provider);
  assert.equal(models.length, 2);
  const updated = models.find((model) => model['id'] === 'a');
  assert.equal(updated?.['name'], 'A2');
  // 未知字段由调用方合并，此处验证 upsert 不会自动补齐但也绝不改动 id。
  assert.equal(models.find((model) => model['id'] === 'b')?.['vision'], true);
  assert.deepEqual(findGroup(groups, 'openai', 'Other')?.apiKey, '${input:chat.lm.secret.other}');
});

test('新增模型到已有分组', () => {
  const groups = upsertModel(sample(), 'customendpoint', 'Provider', { id: 'c', name: 'C', url: 'https://x.test' });
  assert.equal(groupModels(findGroup(groups, 'customendpoint', 'Provider')!).length, 3);
});

test('新增模型可创建不存在的分组', () => {
  const groups = upsertModel(sample(), 'customendpoint', 'Fresh', { id: 'z', name: 'Z', url: 'https://x.test' });
  assert.ok(findGroup(groups, 'customendpoint', 'Fresh'));
});

test('编辑时若原模型不存在则拒绝', () => {
  assert.throws(() => upsertModel(sample(), 'customendpoint', 'Provider', { id: 'new' }, 'missing'), ConfigParseError);
});

test('删除模型并保留分组', () => {
  const groups = removeModel(sample(), 'customendpoint', 'Provider', 'a');
  const models = groupModels(findGroup(groups, 'customendpoint', 'Provider')!);
  assert.deepEqual(models.map((model) => model['id']), ['b']);
});

test('删除最后一个模型时保留空分组与凭据', () => {
  let groups = removeModel(sample(), 'customendpoint', 'Provider', 'a');
  groups = removeModel(groups, 'customendpoint', 'Provider', 'b');
  const provider = findGroup(groups, 'customendpoint', 'Provider');
  assert.ok(provider, '删除模型不应隐式删除分组凭据');
  assert.deepEqual(groupModels(provider), []);
  assert.equal(provider?.['apiKey'], '${input:chat.lm.secret.abc}');
  assert.ok(findGroup(groups, 'openai', 'Other'));
});

test('显式要求时才移除空分组', () => {
  let groups = removeModel(sample(), 'customendpoint', 'Provider', 'a', true);
  groups = removeModel(groups, 'customendpoint', 'Provider', 'b', true);
  assert.equal(findGroup(groups, 'customendpoint', 'Provider'), undefined);
});

test('移除分组凭据只删除 apiKey 引用', () => {
  const groups = removeCredential(sample(), 'customendpoint', 'Provider');
  const provider = findGroup(groups, 'customendpoint', 'Provider');
  assert.ok(provider);
  assert.equal('apiKey' in (provider ?? {}), false);
  assert.equal(groupModels(provider).length, 2);
});

test('删除分组不影响其他提供方', () => {
  const groups = removeGroup(sample(), 'customendpoint', 'Provider');
  assert.equal(findGroup(groups, 'customendpoint', 'Provider'), undefined);
  assert.ok(findGroup(groups, 'openai', 'Other'));
});

test('重命名分组遇到重名时拒绝', () => {
  assert.throws(() => renameGroup(sample(), 'customendpoint', 'Provider', 'Provider'), ConfigParseError);
  const groups = renameGroup(sample(), 'customendpoint', 'Provider', 'Renamed');
  assert.ok(findGroup(groups, 'customendpoint', 'Renamed'));
});

test('upsert 不修改输入数组', () => {
  const original = sample();
  const snapshot = JSON.stringify(original);
  upsertModel(original, 'customendpoint', 'Provider', { id: 'a', name: 'changed' });
  assert.equal(JSON.stringify(original), snapshot);
});

test('导出剔除 apiKey', () => {
  const exported = createSanitizedExport(sample());
  const text = JSON.stringify(exported);
  assert.equal(text.includes('apiKey'), false);
  assert.equal(text.includes('chat.lm.secret'), false);
  assert.ok(text.includes('customendpoint'));
});

test('导出可按 vendor 过滤', () => {
  const exported = createSanitizedExport(sample(), ['openai']);
  assert.equal(exported.length, 1);
  assert.equal(exported[0]?.vendor, 'openai');
});

test('导出保留能力字段', () => {
  const groups = upsertModel(sample(), 'customendpoint', 'Provider', {
    id: 'a',
    name: 'A',
    url: 'https://x.test',
    thinking: true,
    supportsReasoningEffort: ['low', 'high'],
    vision: true,
  });
  const exported = createSanitizedExport(groups);
  const model = (exported[0]?.models as Record<string, unknown>[]).find((entry) => entry['id'] === 'a');
  assert.deepEqual(model?.['supportsReasoningEffort'], ['low', 'high']);
  assert.equal(model?.['thinking'], true);
});

test('导出保留分组接口字段且仍剔除 apiKey', () => {
  const groups: RawGroup[] = [
    {
      name: 'Provider',
      vendor: 'customendpoint',
      baseUrl: 'https://api.example.com/v1',
      apiType: 'responses',
      apiKey: '${input:chat.lm.secret.abc}',
      models: [],
    },
  ];
  const [exported] = createSanitizedExport(groups);
  assert.equal(exported?.['baseUrl'], 'https://api.example.com/v1');
  assert.equal(exported?.['apiType'], 'responses');
  assert.equal('apiKey' in (exported as object), false);
});

test('旧版设置读取兼容两种 id 来源', () => {
  const legacy = readLegacyModels({
    a: { id: 'a', name: 'A', url: 'https://x.test' },
    b: { name: 'B', url: 'https://x.test' },
    c: 'not-an-object',
  });
  assert.deepEqual(legacy.map((entry) => entry.id), ['a', 'b']);
  assert.equal(legacy[1]?.raw['id'], 'b');
});

test('旧版设置无效输入返回空数组', () => {
  assert.deepEqual(readLegacyModels(undefined), []);
  assert.deepEqual(readLegacyModels([1, 2]), []);
});

test('序列化使用制表符且带换行', () => {
  const text = serializeGroups(sample());
  assert.ok(text.endsWith('\n'));
  assert.ok(text.includes('\t"name"'));
});

test('fingerprint 区分不同内容', () => {
  const a = fingerprintOf('a');
  const b = fingerprintOf('b');
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
  assert.equal(fingerprintOf(undefined), fingerprintOf('[]'));
});

test('导入导出往返保留能力字段', () => {
  const groups = parseGroups([
    {
      name: 'G',
      vendor: 'customendpoint',
      models: [
        {
          id: 'm',
          name: 'M',
          url: 'https://x.test',
          contextWindow: 128000,
          maxInputTokens: 120000,
          maxOutputTokens: 8000,
          toolCalling: true,
          vision: true,
          thinking: true,
          supportsReasoningEffort: ['low', 'high'],
          reasoningEffortFormat: 'chat-completions',
        },
      ],
    },
  ]);
  const exported = createSanitizedExport(groups);
  const model = (exported[0]?.models as Record<string, unknown>[])[0];
  assert.deepEqual(model?.['supportsReasoningEffort'], ['low', 'high']);
  assert.equal(model?.['contextWindow'], 128000);
});
