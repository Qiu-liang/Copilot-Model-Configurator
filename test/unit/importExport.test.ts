import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImportPreview,
  legacyModelsToGroup,
  mergeImportedGroups,
  previewHasErrors,
  sanitizeImportedGroups,
} from '../../src/models/importExport.ts';
import { FULL_CAPABILITIES } from '../../src/models/draft.ts';
import { findGroup, groupModels } from '../../src/models/configDocument.ts';
import type { RawGroup } from '../../src/models/configDocument.ts';

const validModel = {
  id: 'm',
  name: 'M',
  url: 'https://x.test/v1/chat/completions',
  contextWindow: 1000,
  maxInputTokens: 900,
  maxOutputTokens: 100,
  toolCalling: true,
  vision: false,
  streaming: true,
};

test('导入清洗移除分组与模型级密钥', () => {
  const result = sanitizeImportedGroups(
    [
      {
        name: 'G',
        vendor: 'customendpoint',
        apiKey: '${input:secret}',
        models: [{ id: 'm', apiKey: 'plaintext' }],
      },
      { name: 'Other', vendor: 'openai', models: [{ id: 'x' }] },
    ],
    ['customendpoint', 'customoai'],
  );
  assert.equal(result.groups.length, 1);
  assert.equal(result.strippedCredentials, true);
  assert.equal('apiKey' in (result.groups[0] ?? {}), false);
  const model = groupModels(result.groups[0]!)[0];
  assert.equal(model ? 'apiKey' in model : true, false);
});

test('导入清洗忽略非目标提供方', () => {
  const result = sanitizeImportedGroups(
    [{ name: 'G', vendor: 'openai', models: [] }],
    ['customendpoint', 'customoai'],
  );
  assert.equal(result.groups.length, 0);
  assert.equal(result.strippedCredentials, false);
});

test('导入预览标记同名冲突与无效模型', () => {
  const valid = buildImportPreview(
    [{ name: 'G', vendor: 'customendpoint', models: [validModel] }],
    [{ name: 'G', vendor: 'customendpoint' }],
    () => FULL_CAPABILITIES,
  );
  assert.equal(valid.canApply, true);
  assert.equal(valid.groups[0]?.conflict, true);
  assert.equal(valid.totalModels, 1);
  assert.equal(previewHasErrors(valid), false);

  const invalid = buildImportPreview(
    [
      {
        name: 'Bad',
        vendor: 'customendpoint',
        models: [{ ...validModel, id: 'bad', contextWindow: 100, maxInputTokens: 900 }],
      },
    ],
    [],
    () => FULL_CAPABILITIES,
  );
  assert.equal(invalid.canApply, false);
  assert.ok(invalid.groups[0]?.issues.some((issue) => issue.field === 'contextWindow'));
});

test('导入预览拒绝缺少 id 的模型', () => {
  const preview = buildImportPreview(
    [{ name: 'G', vendor: 'customendpoint', models: [{ name: 'No id' }] }],
    [],
    () => FULL_CAPABILITIES,
  );
  assert.equal(preview.canApply, false);
  assert.ok(preview.groups[0]?.issues.some((issue) => issue.field === 'id'));
});

test('合并导入保留原凭据与 settings，并替换模型列表', () => {
  const existing: RawGroup[] = [
    {
      name: 'G',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.old}',
      settings: { model: { thinkingEffort: 'high' } },
      models: [{ id: 'old' }],
    },
  ];
  const incoming: RawGroup[] = [{ name: 'G', vendor: 'customendpoint', models: [{ id: 'new' }] }];
  const groups = mergeImportedGroups(existing, incoming, {
    preferredVendor: 'customendpoint',
    availableVendors: ['customendpoint', 'customoai'],
  });
  const group = findGroup(groups, 'customendpoint', 'G');
  assert.ok(group);
  assert.equal(group?.['apiKey'], '${input:chat.lm.secret.old}');
  assert.deepEqual(group?.['settings'], { model: { thinkingEffort: 'high' } });
  assert.deepEqual(groupModels(group!).map((model) => model['id']), ['new']);
});

test('合并导入在提供方不可用时落到首选提供方', () => {
  const groups = mergeImportedGroups(
    [],
    [{ name: 'G', vendor: 'customoai', models: [{ id: 'm' }] }],
    { preferredVendor: 'customendpoint', availableVendors: ['customendpoint'] },
  );
  assert.ok(findGroup(groups, 'customendpoint', 'G'));
  assert.equal(findGroup(groups, 'customoai', 'G'), undefined);
});

test('合并导入拒绝重复分组', () => {
  assert.throws(
    () =>
      mergeImportedGroups(
        [],
        [
          { name: 'G', vendor: 'customendpoint', models: [] },
          { name: 'G', vendor: 'customendpoint', models: [] },
        ],
        { preferredVendor: 'customendpoint', availableVendors: ['customendpoint'] },
      ),
    /重复分组/,
  );
});

test('旧版模型转换为分组时剥离密钥并去重', () => {
  const result = legacyModelsToGroup(
    [
      { id: 'a', raw: { id: 'a', name: 'A', url: 'https://x.test', apiKey: 'secret-value' } },
      { id: 'a', raw: { id: 'a', name: 'A duplicate' } },
      { id: 'b', raw: { name: 'B' } },
    ],
    'customendpoint',
    'Legacy',
  );
  assert.equal(result.strippedCredentials, true);
  assert.equal(result.group.vendor, 'customendpoint');
  const models = groupModels(result.group);
  assert.deepEqual(models.map((model) => model['id']), ['a', 'b']);
  assert.equal(models.some((model) => 'apiKey' in model), false);
});
