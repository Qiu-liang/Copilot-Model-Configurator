import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEffortLevels, resolveRequestUrl, validateDraft, hasErrors, FULL_CAPABILITIES } from '../../src/models/draft.ts';
import { parseGroups, createSanitizedExport, upsertModel } from '../../src/models/configDocument.ts';
import { createEmptyDraft } from '../../src/models/draft.ts';
import type { ModelDraft } from '../../src/models/modelConfig.ts';

function draft(patch: Partial<ModelDraft> = {}): ModelDraft {
  return {
    ...createEmptyDraft('customendpoint', 'G'),
    id: 'm',
    name: 'M',
    url: 'https://x.test/v1/chat/completions',
    ...patch,
  };
}

test('导入的 reasoningEffortFormat 仅在支持时保留', () => {
  const groups = parseGroups([
    {
      name: 'G',
      vendor: 'customendpoint',
      models: [{ id: 'm', reasoningEffortFormat: 'responses' }],
    },
  ]);
  assert.equal((groups[0]?.models as Record<string, unknown>[])[0]?.['reasoningEffortFormat'], 'responses');
});

test('导出不包含 settings', () => {
  const groups = parseGroups([
    { name: 'G', vendor: 'customendpoint', settings: { m: { thinkingEffort: 'high' } }, models: [{ id: 'm' }] },
  ]);
  const exported = createSanitizedExport(groups);
  assert.equal('settings' in (exported[0] ?? {}), false);
});

test('跨分组同名模型允许存在', () => {
  let groups = upsertModel([], 'customendpoint', 'A', { id: 'same', name: 'A' });
  groups = upsertModel(groups, 'customendpoint', 'B', { id: 'same', name: 'B' });
  assert.equal(groups.length, 2);
});

test('同一分组内新增重复 ID 会覆盖而非追加', () => {
  let groups = upsertModel([], 'customendpoint', 'A', { id: 'same', name: 'first' });
  groups = upsertModel(groups, 'customendpoint', 'A', { id: 'same', name: 'second' });
  const models = groups[0]?.models as Record<string, unknown>[];
  assert.equal(models.length, 1);
  assert.equal(models[0]?.['name'], 'second');
});

test('思考强度支持自定义并去重', () => {
  assert.deepEqual(normalizeEffortLevels(['auto', 'Auto', 'low']), ['auto', 'low']);
});

test('Messages API 与基础地址组合', () => {
  assert.equal(resolveRequestUrl('http://127.0.0.1:11434', 'messages'), 'http://127.0.0.1:11434/v1/messages');
});

test('IPv6 本机地址视为本地', () => {
  const issues = validateDraft(draft({ url: 'http://[::1]:8080/v1/chat/completions' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: FULL_CAPABILITIES,
  });
  assert.equal(hasErrors(issues), false, JSON.stringify(issues));
});

test('0.0.0.0 不是本机回环，因此仍要求确认', () => {
  const issues = validateDraft(draft({ url: 'http://0.0.0.0:8080/v1/chat/completions' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: FULL_CAPABILITIES,
  });
  assert.ok(hasErrors(issues));
});

test('分组名过长会被拒绝', () => {
  const issues = validateDraft(draft({ groupName: 'x'.repeat(81) }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: FULL_CAPABILITIES,
  });
  assert.ok(hasErrors(issues));
});
