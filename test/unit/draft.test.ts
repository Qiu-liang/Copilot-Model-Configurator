import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDraftToRaw,
  autoInputTokens,
  cloneDraft,
  createCopyDraft,
  createEmptyDraft,
  defaultEffortLevels,
  formatTokenCount,
  normalizeEffortLevels,
  parseRawModel,
  resolveRequestUrl,
  validateDraft,
  hasErrors,
  FULL_CAPABILITIES,
  type ProviderCapabilities,
} from '../../src/models/draft.ts';
import type { ModelDraft } from '../../src/models/modelConfig.ts';

const CAPS: ProviderCapabilities = FULL_CAPABILITIES;

function validDraft(patch: Partial<ModelDraft> = {}): ModelDraft {
  return {
    ...createEmptyDraft('customendpoint', 'Test'),
    id: 'model-1',
    name: 'Model 1',
    url: 'https://api.example.com/v1/chat/completions',
    ...patch,
  };
}

test('空草稿具备一致的上下文数值', () => {
  const draft = createEmptyDraft('customendpoint', 'G');
  assert.equal(draft.maxInputTokens + draft.maxOutputTokens, draft.contextWindow);
  assert.equal(draft.thinking, false);
  assert.equal(draft.vision, false);
});

test('总窗口缺失时由输入与输出推导', () => {
  const model = parseRawModel(
    { id: 'm', name: 'M', url: 'https://x.test', maxInputTokens: 1000, maxOutputTokens: 200, toolCalling: true, vision: false },
    'customendpoint',
    'G',
  );
  assert.ok(model);
  assert.equal(model.contextWindow, 1200);
});

test('contextWindow 优先于输入加输出', () => {
  const model = parseRawModel(
    { id: 'm', maxInputTokens: 1000, maxOutputTokens: 200, contextWindow: 5000, toolCalling: true, vision: false },
    'customendpoint',
    'G',
  );
  assert.equal(model?.contextWindow, 5000);
});

test('未知字段在保存时被保留', () => {
  const existing = { id: 'm', name: 'M', url: 'https://x.test', editTools: ['apply-patch'], requestHeaders: { 'x-a': 'b' } };
  const next = applyDraftToRaw(validDraft({ id: 'm' }), existing, CAPS);
  assert.deepEqual(next['editTools'], ['apply-patch']);
  assert.deepEqual(next['requestHeaders'], { 'x-a': 'b' });
});

test('关闭思考会清理思考相关字段', () => {
  const existing = {
    id: 'm',
    thinking: true,
    supportsReasoningEffort: ['low'],
    reasoningEffortFormat: 'responses',
    defaultReasoningEffort: 'low',
  };
  const next = applyDraftToRaw(validDraft({ id: 'm', thinking: false }), existing, CAPS);
  assert.equal('thinking' in next, false);
  assert.equal('supportsReasoningEffort' in next, false);
  assert.equal('reasoningEffortFormat' in next, false);
  assert.equal('defaultReasoningEffort' in next, false);
});

test('仅有强度列表时读取为开启思考并保留档位', () => {
  const model = parseRawModel(
    { id: 'm', name: 'M', url: 'https://x.test', supportsReasoningEffort: ['low', 'high'] },
    'customendpoint',
    'G',
  );
  assert.ok(model);
  assert.equal(model.thinking, true);
  assert.deepEqual(model.supportsReasoningEffort, ['low', 'high']);
});

test('仅有 thinking 时读取为开启思考且档位为空', () => {
  const model = parseRawModel({ id: 'm', name: 'M', url: 'https://x.test', thinking: true }, 'customendpoint', 'G');
  assert.ok(model);
  assert.equal(model.thinking, true);
  assert.deepEqual(model.supportsReasoningEffort, []);
});

test('仅声明强度的模型原样保存时不新增 thinking 且保留档位', () => {
  const existing = { id: 'm', supportsReasoningEffort: ['low', 'high'] };
  const model = parseRawModel({ ...existing, name: 'M', url: 'https://x.test' }, 'customendpoint', 'G');
  assert.ok(model);
  const next = applyDraftToRaw(cloneDraft(model), existing, CAPS);
  assert.equal('thinking' in next, false);
  assert.deepEqual(next['supportsReasoningEffort'], ['low', 'high']);
});

test('已声明 thinking 的模型保存后仍保留该字段', () => {
  const existing = { id: 'm', thinking: true, supportsReasoningEffort: ['low'] };
  const model = parseRawModel({ ...existing, name: 'M', url: 'https://x.test' }, 'customendpoint', 'G');
  assert.ok(model);
  const next = applyDraftToRaw(cloneDraft(model), existing, CAPS);
  assert.equal(next['thinking'], true);
  assert.deepEqual(next['supportsReasoningEffort'], ['low']);
});

test('开启思考但没有强度时写入原生 thinking', () => {
  const next = applyDraftToRaw(validDraft({ thinking: true, supportsReasoningEffort: [] }), undefined, CAPS);
  assert.equal(next['thinking'], true);
  assert.equal('supportsReasoningEffort' in next, false);
});

test('customoai 不会写入 apiType', () => {
  const next = applyDraftToRaw(validDraft({ vendor: 'customoai', apiType: 'responses' }), { id: 'm', apiType: 'responses' }, CAPS);
  assert.equal('apiType' in next, false);
});

test('capabilities 关闭时不写 reasoningEffortFormat', () => {
  const caps: ProviderCapabilities = { ...CAPS, supportsReasoningEffortFormat: false };
  const next = applyDraftToRaw(
    validDraft({ thinking: true, supportsReasoningEffort: ['low'], reasoningEffortFormat: 'responses' }),
    undefined,
    caps,
  );
  assert.equal('reasoningEffortFormat' in next, false);
  assert.deepEqual(next['supportsReasoningEffort'], ['low']);
});

test('defaultReasoningEffort 仅在受支持且命中列表时写入', () => {
  const caps: ProviderCapabilities = { ...CAPS, supportsDefaultReasoningEffort: true };
  const accepted = applyDraftToRaw(
    validDraft({ thinking: true, supportsReasoningEffort: ['low', 'high'], defaultReasoningEffort: 'high' }),
    undefined,
    caps,
  );
  assert.equal(accepted['defaultReasoningEffort'], 'high');

  const rejected = applyDraftToRaw(
    validDraft({ thinking: true, supportsReasoningEffort: ['low'], defaultReasoningEffort: 'high' }),
    undefined,
    caps,
  );
  assert.equal('defaultReasoningEffort' in rejected, false);

  const unsupported = applyDraftToRaw(
    validDraft({ thinking: true, supportsReasoningEffort: ['high'], defaultReasoningEffort: 'high' }),
    undefined,
    FULL_CAPABILITIES,
  );
  assert.equal('defaultReasoningEffort' in unsupported, false);
});

test('思考强度去重保持顺序', () => {
  assert.deepEqual(normalizeEffortLevels(['low', 'LOW', ' high ', 'low', '', 3]), ['low', 'high']);
});

test('默认强度列表为非空子集', () => {
  const levels = defaultEffortLevels();
  assert.ok(levels.length >= 1);
  assert.ok(levels.every((level) => level === level.toLowerCase()));
});

test('URL 推导覆盖显式路径和基础地址', () => {
  assert.equal(resolveRequestUrl('https://x.test/v1/chat/completions', 'responses'), 'https://x.test/v1/chat/completions');
  assert.equal(resolveRequestUrl('https://x.test/v1', 'chat-completions'), 'https://x.test/v1/chat/completions');
  assert.equal(resolveRequestUrl('https://x.test', 'responses'), 'https://x.test/v1/responses');
  assert.equal(resolveRequestUrl('https://x.test/', 'messages'), 'https://x.test/v1/messages');
  assert.equal(resolveRequestUrl('https://x.test/v1/messages', 'chat-completions'), 'https://x.test/v1/messages');
});

test('有效草稿没有错误', () => {
  const issues = validateDraft(validDraft(), { siblingIds: [], existingGroupNames: [], capabilities: CAPS });
  assert.equal(hasErrors(issues), false, JSON.stringify(issues));
});

test('重复模型 ID 被拒绝', () => {
  const issues = validateDraft(validDraft({ id: 'dup' }), { siblingIds: ['dup'], existingGroupNames: [], capabilities: CAPS });
  assert.ok(hasErrors(issues));
  assert.ok(issues.some((issue) => issue.field === 'id'));
});

test('上下文三个数值必须自洽', () => {
  const issues = validateDraft(validDraft({ contextWindow: 1000, maxInputTokens: 900, maxOutputTokens: 200 }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.ok(issues.some((issue) => issue.field === 'contextWindow'));
});

test('非法数值被拒绝', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const issues = validateDraft(validDraft({ maxOutputTokens: bad }), {
      siblingIds: [],
      existingGroupNames: [],
      capabilities: CAPS,
    });
    assert.ok(hasErrors(issues), `expected error for ${bad}`);
  }
});

test('http 非本机地址需要显式确认', () => {
  const insecure = validDraft({ url: 'http://api.example.com/v1/chat/completions' });
  const rejected = validateDraft(insecure, { siblingIds: [], existingGroupNames: [], capabilities: CAPS });
  assert.ok(rejected.some((issue) => issue.field === 'url'));

  const allowed = validateDraft({ ...insecure, allowInsecureHttp: true }, {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.equal(hasErrors(allowed), false);

  const local = validateDraft(validDraft({ url: 'http://localhost:11434/v1/chat/completions' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.equal(hasErrors(local), false);
});

test('URL 中的凭据被拒绝', () => {
  const issues = validateDraft(validDraft({ url: 'https://user:pass@api.example.com/v1/chat/completions' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.ok(issues.some((issue) => issue.field === 'url'));
});

test('思考开启但无强度时只给出警告', () => {
  const issues = validateDraft(validDraft({ thinking: true, supportsReasoningEffort: [] }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.equal(hasErrors(issues), false);
  assert.ok(issues.some((issue) => issue.field === 'supportsReasoningEffort' && issue.severity === 'warning'));
});

test('默认强度不在支持列表时拒绝保存', () => {
  const issues = validateDraft(
    validDraft({ thinking: true, supportsReasoningEffort: ['low'], defaultReasoningEffort: 'high' }),
    { siblingIds: [], existingGroupNames: [], capabilities: CAPS },
  );
  assert.ok(issues.some((issue) => issue.field === 'defaultReasoningEffort' && issue.severity !== 'warning'));
});

test('不支持默认强度时只给出警告', () => {
  const issues = validateDraft(
    validDraft({ thinking: true, supportsReasoningEffort: ['high'], defaultReasoningEffort: 'high' }),
    { siblingIds: [], existingGroupNames: [], capabilities: FULL_CAPABILITIES },
  );
  assert.equal(hasErrors(issues), false);
  assert.ok(issues.some((issue) => issue.severity === 'warning'));
});

test('缺失分组名或显示名称会被拒绝', () => {
  const issues = validateDraft(validDraft({ groupName: '  ', name: '' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.ok(issues.some((issue) => issue.field === 'groupName'));
  assert.ok(issues.some((issue) => issue.field === 'name'));
});

test('模型 ID 中的空白被拒绝', () => {
  const issues = validateDraft(validDraft({ id: 'bad id' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
  });
  assert.ok(issues.some((issue) => issue.field === 'id'));
});

test('token 摘要格式化', () => {
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(128_000), '128K');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(Number.NaN), '—');
});

test('自动换算输入 Tokens 的边界', () => {
  assert.equal(autoInputTokens(1000, 200), 800);
  assert.equal(autoInputTokens(1000, 1000), undefined);
  assert.equal(autoInputTokens(Number.NaN, 100), undefined);
});

test('新建分组必须填写密钥或明确选择无需认证', () => {
  const withoutKey = validDraft({ groupName: 'New', credentialMode: 'apiKey' });
  const rejected = validateDraft(withoutKey, {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: false,
    groupHasCredential: false,
  });
  assert.ok(rejected.some((issue) => issue.field === 'apiKey'));

  const noAuth = validateDraft({ ...withoutKey, credentialMode: 'none' }, {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: false,
    groupHasCredential: false,
  });
  assert.equal(hasErrors(noAuth), false);

  const withKey = validateDraft({ ...withoutKey, apiKey: 'sk-test-1234' }, {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: false,
    groupHasCredential: false,
  });
  assert.equal(hasErrors(withKey), false);
});

test('已有凭据的分组允许留空沿用', () => {
  const issues = validateDraft(validDraft({ apiKey: undefined, credentialMode: 'apiKey' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: true,
    groupHasCredential: true,
  });
  assert.equal(hasErrors(issues), false);
});

test('已有凭据的分组不能直接切换为无需认证', () => {
  const issues = validateDraft(validDraft({ credentialMode: 'none' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: true,
    groupHasCredential: true,
  });
  assert.ok(issues.some((issue) => issue.field === 'credentialMode'));
});

test('无凭据分组留空时要求输入或选择无需认证', () => {
  const issues = validateDraft(validDraft({ apiKey: undefined, credentialMode: 'apiKey' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: true,
    groupHasCredential: false,
  });
  assert.ok(issues.some((issue) => issue.field === 'apiKey'));
});

test('选择无需认证时不能同时填写密钥', () => {
  const issues = validateDraft(validDraft({ credentialMode: 'none', apiKey: 'sk-test' }), {
    siblingIds: [],
    existingGroupNames: [],
    capabilities: CAPS,
    groupExists: false,
    groupHasCredential: false,
  });
  assert.ok(issues.some((issue) => issue.field === 'apiKey'));
});

test('复制草稿生成唯一 ID 与副本名称', () => {
  const record = parseRawModel(
    {
      id: 'm',
      name: 'Model',
      url: 'https://x.test',
      maxInputTokens: 900,
      maxOutputTokens: 100,
    },
    'customendpoint',
    'G',
  );
  assert.ok(record);
  const copy = createCopyDraft(record, ['m']);
  assert.equal(copy.id, 'm-copy');
  assert.equal(copy.name, 'Model（副本）');
  assert.equal(copy.apiKey, undefined);
  assert.equal(copy.credentialMode, 'apiKey');

  const second = createCopyDraft(record, ['m', 'm-copy']);
  assert.equal(second.id, 'm-copy-2');
});

test('分组无凭据时模型解析为无需认证', () => {
  const raw = { id: 'm', name: 'M', url: 'https://x.test', maxInputTokens: 900, maxOutputTokens: 100 };
  assert.equal(parseRawModel(raw, 'customendpoint', 'G', { groupHasCredential: false })?.credentialMode, 'none');
  assert.equal(parseRawModel(raw, 'customendpoint', 'G', { groupHasCredential: true })?.credentialMode, 'apiKey');
  assert.equal(parseRawModel(raw, 'customendpoint', 'G')?.credentialMode, 'apiKey');
});

test('编辑与复制无认证模型仍为无需认证且可直接保存', () => {
  const record = parseRawModel(
    { id: 'm', name: 'Model', url: 'https://x.test', maxInputTokens: 900, maxOutputTokens: 100 },
    'customendpoint',
    'Local',
    { groupHasCredential: false },
  );
  assert.ok(record);

  const edit = cloneDraft(record);
  assert.equal(edit.credentialMode, 'none');
  const editIssues = validateDraft(edit, {
    siblingIds: [],
    existingGroupNames: ['Local'],
    capabilities: CAPS,
    groupExists: true,
    groupHasCredential: false,
  });
  assert.equal(hasErrors(editIssues), false, JSON.stringify(editIssues));

  const copy = createCopyDraft(record, ['m']);
  assert.equal(copy.credentialMode, 'none');
  const copyIssues = validateDraft(copy, {
    siblingIds: ['m'],
    existingGroupNames: ['Local'],
    capabilities: CAPS,
    groupExists: true,
    groupHasCredential: false,
  });
  assert.equal(hasErrors(copyIssues), false, JSON.stringify(copyIssues));
});

test('保存时清除模型对象中的明文 apiKey', () => {
  const next = applyDraftToRaw(
    validDraft({ id: 'm' }),
    { id: 'm', name: 'M', url: 'https://x.test', apiKey: 'plaintext' },
    CAPS,
  );
  assert.equal('apiKey' in next, false);
});
