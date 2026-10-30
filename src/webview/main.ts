import type {
  ConfigSnapshot,
  ConnectionTestResult,
  GroupRef,
  ImportPreview,
  ModelDraft,
  ModelRecord,
  ModelRef,
  ProviderGroup,
  ValidationIssue,
  VendorId,
  VendorInfo,
} from '../models/modelConfig.ts';
import { COMMON_EFFORT_LEVELS, LEGACY_GROUP_NAME } from '../models/modelConfig.ts';
import {
  applyDraftToRaw,
  autoInputTokens,
  cloneDraft,
  createCopyDraft,
  createEmptyDraft,
  defaultEffortLevels,
  formatTokenCount,
  hasErrors,
  normalizeEffortLevels,
  resolveRequestUrl,
  validateDraft,
  type ProviderCapabilities,
} from '../models/draft.ts';
import type {
  ExtensionMessage,
  RequestError,
  RequestPayloads,
  RequestType,
  WebviewRequest,
} from '../panel/protocol.ts';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type Selection =
  | { kind: 'none' }
  | { kind: 'group'; group: GroupRef }
  | { kind: 'model'; ref: ModelRef };

interface FormState {
  mode: 'create' | 'edit' | 'copy';
  original?: ModelRef;
  draft: ModelDraft;
  issues: ValidationIssue[];
  dirty: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: ConnectionTestResult;
  baseFingerprint: string;
  nameTouched: boolean;
  inputTouched: boolean;
  urlTouched: boolean;
  groupMode: 'existing' | 'new';
  customEffortsText: string;
  stale: boolean;
}

type DialogState =
  | { kind: 'import'; step: 'input'; text: string; error?: string; busy: boolean; fingerprint: string }
  | {
      kind: 'import';
      step: 'preview';
      text: string;
      preview: ImportPreview;
      error?: string;
      busy: boolean;
      fingerprint: string;
    }
  | { kind: 'export'; json: string; busy: boolean }
  | { kind: 'discard'; message: string; onConfirm: () => void };

interface AppState {
  snapshot?: ConfigSnapshot;
  selection: Selection;
  form?: FormState;
  busy: boolean;
  busyMessage?: string;
  lastError?: string;
  dialog?: DialogState;
  loaded: boolean;
}

type PendingPurpose =
  | 'list'
  | 'refresh'
  | 'save'
  | 'delete'
  | 'deleteGroup'
  | 'test'
  | 'cancelTest'
  | 'export'
  | 'exportCopy'
  | 'exportSave'
  | 'import'
  | 'importApply'
  | 'legacy'
  | 'groupKey'
  | 'clearKey'
  | 'dirty'
  | 'open';

interface PendingEntry {
  purpose: PendingPurpose;
  ref?: ModelRef;
  group?: GroupRef;
  text?: string;
  label?: string;
}

const vscode = acquireVsCodeApi();
const appRoot = document.getElementById('app');
const toastRoot = document.getElementById('toast-region');
if (!appRoot || !toastRoot) {
  throw new Error('缺少 #app 或 #toast-region 节点');
}
const app: HTMLElement = appRoot;
const toastRegion: HTMLElement = toastRoot;

const state: AppState = {
  selection: { kind: 'none' },
  busy: true,
  loaded: false,
};

const pending = new Map<string, PendingEntry>();
let requestCounter = 0;
let lastDirtySignaled = false;
let focusBeforeDialog: string | undefined;

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }
  switch (message.type) {
    case 'state':
      applySnapshot(message.payload.snapshot);
      break;
    case 'busy':
      state.busy = message.payload.busy;
      state.busyMessage = message.payload.message;
      if (message.payload.busy && message.payload.message) {
        showToast('info', message.payload.message, 2200);
      }
      render();
      break;
    case 'toast':
      showToast(message.payload.level, message.payload.message);
      break;
    case 'issues':
      if (state.form) {
        state.form.issues = message.payload.issues;
        state.form.saving = false;
        state.form.dirty = true;
        render();
      }
      break;
    case 'select':
      if (message.payload.ref) {
        startEdit(message.payload.ref);
      } else if (message.payload.group) {
        selectGroup(message.payload.group);
      }
      break;
    case 'start-create':
      startCreate(message.payload.draft);
      break;
    case 'start-copy':
      startCopy(message.payload.ref);
      break;
    case 'response':
      handleResponse(message);
      break;
  }
});

/* ------------------------------------------------------------------ */
/* 请求与响应                                                          */
/* ------------------------------------------------------------------ */

function send<T extends RequestType>(
  type: T,
  payload: RequestPayloads[T],
  purpose: PendingPurpose,
  extra: Partial<PendingEntry> = {},
): string {
  requestCounter += 1;
  const requestId = `r-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
  pending.set(requestId, { purpose, ...extra });
  const request: WebviewRequest = { type, requestId, payload } as WebviewRequest;
  vscode.postMessage(request);
  return requestId;
}

function handleResponse(message: Extract<ExtensionMessage, { type: 'response' }>): void {
  const entry = pending.get(message.requestId);
  pending.delete(message.requestId);
  const purpose = entry?.purpose;
  if (!message.ok) {
    handleRequestError(message.error ?? { code: 'unknown', message: '操作失败。' }, purpose);
    return;
  }

  state.lastError = undefined;
  const data = message.data as Record<string, unknown> | undefined;
  switch (purpose) {
    case 'save': {
      const ref = data?.['ref'] as ModelRef | undefined;
      if (state.form) {
        state.form.saving = false;
        state.form.dirty = false;
      }
      showToast('info', '模型已保存。');
      if (ref) {
        startEdit(ref, true);
      } else {
        render();
      }
      break;
    }
    case 'delete':
      state.form = undefined;
      state.selection = { kind: 'none' };
      showToast('info', '模型已删除。');
      render();
      break;
    case 'deleteGroup':
      state.form = undefined;
      state.selection = { kind: 'none' };
      showToast('info', '分组已删除。');
      render();
      break;
    case 'test': {
      if (state.form) {
        state.form.testing = false;
        state.form.testResult = data as unknown as ConnectionTestResult | undefined;
      }
      render();
      break;
    }
    case 'cancelTest':
      if (state.form) {
        state.form.testing = false;
      }
      render();
      break;
    case 'export':
      state.dialog = {
        kind: 'export',
        json: String(data?.['json'] ?? ''),
        busy: false,
      };
      render();
      break;
    case 'exportCopy':
      if (state.dialog?.kind === 'export') {
        state.dialog.busy = false;
      }
      showToast('info', '已复制到剪贴板（不含 API Key）。');
      render();
      break;
    case 'exportSave':
      state.dialog = undefined;
      showToast('info', `已导出到 ${String(data?.['path'] ?? '文件')}。`);
      render();
      break;
    case 'import': {
      const preview = data as unknown as ImportPreview;
      const fingerprint =
        state.dialog?.kind === 'import' ? state.dialog.fingerprint : (state.snapshot?.fingerprint ?? '');
      state.dialog = {
        kind: 'import',
        step: 'preview',
        text: entry?.text ?? '',
        preview,
        busy: false,
        fingerprint,
      };
      render();
      break;
    }
    case 'importApply': {
      state.dialog = undefined;
      state.selection = { kind: 'none' };
      const stripped = Boolean(data?.['strippedCredentials']);
      showToast(
        stripped ? 'warn' : 'info',
        stripped
          ? '导入完成。文件中的 API Key 已被移除，请为相关分组重新设置密钥。'
          : '导入完成，请在 Copilot 模型选择器中确认。',
        5200,
      );
      render();
      break;
    }
    case 'legacy': {
      const count = Number(data?.['count'] ?? 0);
      const groupName = String(data?.['groupName'] ?? LEGACY_GROUP_NAME);
      const stripped = Boolean(data?.['strippedCredentials']);
      showToast(
        stripped ? 'warn' : 'info',
        `已从旧版设置导入 ${count} 个模型到分组“${groupName}”。${stripped ? '旧设置中的明文密钥已被移除，请重新设置。' : ''}`,
        5200,
      );
      render();
      break;
    }
    case 'groupKey':
      if (state.form && state.snapshot) {
        state.form.baseFingerprint = state.snapshot.fingerprint;
        state.form.stale = false;
        state.form.issues = validateForm(state.form);
      }
      showToast('info', 'API Key 已更新。');
      render();
      break;
    case 'clearKey':
      if (state.form && state.snapshot) {
        state.form.baseFingerprint = state.snapshot.fingerprint;
        state.form.stale = false;
        state.form.issues = validateForm(state.form);
      }
      showToast('info', '已移除分组凭据引用。');
      render();
      break;
    case 'refresh':
      showToast('info', '配置已刷新。');
      render();
      break;
    case 'dirty':
    case 'open':
      break;
    default:
      render();
      break;
  }
  updateDirtySignal();
}

function handleRequestError(error: RequestError, purpose: PendingPurpose | undefined): void {
  resetPendingUi(purpose);
  if (error.code === 'canceled') {
    showToast('info', error.message);
    render();
    return;
  }
  if (error.code === 'validation') {
    if (state.form) {
      if (error.issues) {
        state.form.issues = error.issues;
      }
      state.form.saving = false;
      state.form.dirty = true;
    }
    showToast('error', error.message);
    render();
    return;
  }
  if (error.code === 'conflict' && state.form) {
    state.form.stale = true;
    state.form.saving = false;
  }
  if (error.code === 'credential' && state.form && state.snapshot) {
    // 服务层可能已写入模型但凭据失败；改用最新快照，允许用户重试密钥写入。
    state.form.baseFingerprint = state.snapshot.fingerprint;
    state.form.stale = false;
    state.form.saving = false;
  }
  if (state.dialog?.kind === 'import') {
    state.dialog.error = error.message;
    state.dialog.busy = false;
  } else if (state.dialog?.kind === 'export') {
    state.dialog = undefined;
  }
  state.lastError = error.message;
  showToast('error', error.message, 6200);
  render();
}

function resetPendingUi(purpose: PendingPurpose | undefined): void {
  if (!purpose) {
    return;
  }
  if (purpose === 'save' && state.form) {
    state.form.saving = false;
  }
  if (purpose === 'test' && state.form) {
    state.form.testing = false;
  }
  if (
    purpose === 'import' ||
    purpose === 'importApply' ||
    purpose === 'export' ||
    purpose === 'exportCopy' ||
    purpose === 'exportSave'
  ) {
    if (state.dialog && state.dialog.kind !== 'discard') {
      state.dialog = { ...state.dialog, busy: false };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 快照与表单状态                                                      */
/* ------------------------------------------------------------------ */

function applySnapshot(snapshot: ConfigSnapshot): void {
  state.snapshot = snapshot;
  state.loaded = true;
  state.busy = false;

  if (state.selection.kind === 'model' && !findModel(state.selection.ref)) {
    if (!state.form) {
      state.selection = { kind: 'none' };
    }
  }
  if (state.selection.kind === 'group' && !findGroup(state.selection.group.vendor, state.selection.group.groupName)) {
    if (!state.form) {
      state.selection = { kind: 'none' };
    }
  }

  const form = state.form;
  if (form) {
    if (form.mode === 'edit' && form.original) {
      const found = findModel(form.original);
      if (!found) {
        form.stale = true;
      } else if (!form.dirty) {
        form.draft = cloneDraft(found.model);
        form.customEffortsText = customEffortsFrom(form.draft);
        form.issues = validateForm(form);
      }
    }
    if (!form.dirty) {
      form.baseFingerprint = snapshot.fingerprint;
    }
    if (form.dirty && !form.saving && form.baseFingerprint !== snapshot.fingerprint) {
      form.stale = true;
    }
    if (!form.stale) {
      form.issues = validateForm(form);
    }
  }
  render();
}

function findGroup(vendor: VendorId, groupName: string): ProviderGroup | undefined {
  return state.snapshot?.groups.find((group) => group.vendor === vendor && group.name === groupName);
}

function findModel(ref: ModelRef): { group: ProviderGroup; model: ModelRecord } | undefined {
  const group = findGroup(ref.vendor, ref.groupName);
  const model = group?.models.find((entry) => entry.id === ref.id);
  return group && model ? { group, model } : undefined;
}

function vendorInfo(vendor: VendorId): VendorInfo | undefined {
  return state.snapshot?.vendorInfo.find((info) => info.vendor === vendor);
}

function vendorLabel(vendor: VendorId): string {
  return vendorInfo(vendor)?.label ?? vendor;
}

function capabilitiesFor(vendor: VendorId): ProviderCapabilities {
  const info = vendorInfo(vendor);
  return {
    supportsModelApiType: info?.supportsModelApiType ?? vendor === 'customendpoint',
    supportsDefaultReasoningEffort: info?.supportsDefaultReasoningEffort ?? false,
    supportsReasoningEffortFormat: info?.supportsReasoningEffortFormat ?? vendor === 'customendpoint',
    supportsAdaptiveThinking: false,
  };
}

function siblingIdsFor(form: FormState): string[] {
  const group = findGroup(form.draft.vendor, form.draft.groupName.trim());
  if (!group) {
    return [];
  }
  return group.models.map((model) => model.id).filter((id) => id !== form.original?.id);
}

function validateForm(form: FormState): ValidationIssue[] {
  const group = findGroup(form.draft.vendor, form.draft.groupName.trim());
  const issues = validateDraft(form.draft, {
    siblingIds: siblingIdsFor(form),
    existingGroupNames: (state.snapshot?.groups ?? [])
      .filter((entry) => entry.vendor === form.draft.vendor)
      .map((entry) => entry.name),
    capabilities: capabilitiesFor(form.draft.vendor),
    groupExists: Boolean(group),
    groupHasCredential: group?.hasApiKey ?? false,
  });
  if (form.mode !== 'edit' && form.groupMode === 'new' && form.draft.groupName.trim()) {
    const exists = (state.snapshot?.groups ?? []).some(
      (entry) => entry.vendor === form.draft.vendor && entry.name === form.draft.groupName.trim(),
    );
    if (exists) {
      issues.push({ field: 'groupName', message: '同名分组已存在，请从分组列表中选择它，而不是新建。' });
    }
  }
  return issues;
}

/** URL 校验按文档在失焦或提交后展示，避免输入过程中不断报错。 */
function visibleIssues(form: FormState): ValidationIssue[] {
  return form.issues.filter(
    (issue) => issue.field !== 'url' || form.urlTouched || issue.severity === 'warning',
  );
}

function customEffortsFrom(draft: ModelDraft): string {
  return draft.supportsReasoningEffort
    .filter((level) => !(COMMON_EFFORT_LEVELS as readonly string[]).includes(level.toLowerCase()))
    .join(', ');
}

function createForm(
  mode: FormState['mode'],
  draft: ModelDraft,
  options: {
    original?: ModelRef;
    groupMode: 'existing' | 'new';
    nameTouched: boolean;
    inputTouched: boolean;
  },
): FormState {
  const auto = autoInputTokens(draft.contextWindow, draft.maxOutputTokens);
  const inputTouched = options.inputTouched && auto !== undefined && draft.maxInputTokens !== auto;
  return {
    mode,
    original: options.original,
    draft,
    issues: [],
    dirty: false,
    saving: false,
    testing: false,
    baseFingerprint: state.snapshot?.fingerprint ?? '',
    nameTouched: options.nameTouched,
    inputTouched,
    urlTouched: false,
    groupMode: options.groupMode,
    customEffortsText: customEffortsFrom(draft),
    stale: false,
  };
}

function startCreate(prefill?: ModelDraft): void {
  withDiscardGuard(() => {
    const snapshot = state.snapshot;
    if (!snapshot) {
      return;
    }
    let draft: ModelDraft;
    let groupMode: 'existing' | 'new';
    if (prefill) {
      const targetGroup = findGroup(prefill.vendor, prefill.groupName.trim());
      draft = {
        ...prefill,
        apiKey: undefined,
        // 认证方式跟随目标分组：分组没有凭据时即为无认证。
        credentialMode: targetGroup && !targetGroup.hasApiKey ? 'none' : 'apiKey',
      };
      groupMode = targetGroup ? 'existing' : 'new';
    } else {
      const lastGroup = snapshot.groups.at(-1);
      if (lastGroup) {
        draft = createEmptyDraft(lastGroup.vendor, lastGroup.name);
        groupMode = 'existing';
      } else {
        draft = createEmptyDraft(snapshot.preferredVendor, '');
        draft.groupName = uniqueGroupName(snapshot.preferredVendor, 'My Provider');
        groupMode = 'new';
      }
    }
    state.form = createForm('create', draft, {
      groupMode,
      nameTouched: false,
      inputTouched: false,
    });
    state.selection = { kind: 'none' };
    state.lastError = undefined;
    render();
    focusField('id');
  });
}

function startCopy(ref: ModelRef): void {
  withDiscardGuard(() => {
    const found = findModel(ref);
    if (!found) {
      showToast('error', '找不到要复制的模型，请刷新后重试。');
      return;
    }
    const siblingIds = found.group.models.map((model) => model.id);
    const draft = createCopyDraft(found.model, siblingIds);
    state.form = createForm('copy', draft, {
      groupMode: 'existing',
      nameTouched: true,
      inputTouched: true,
    });
    state.selection = { kind: 'model', ref };
    state.lastError = undefined;
    render();
    focusField('id');
  });
}

function startEdit(ref: ModelRef, skipGuard = false): void {
  const action = (): void => {
    const found = findModel(ref);
    if (!found) {
      showToast('error', '该模型已不存在，请刷新后重试。');
      state.form = undefined;
      state.selection = { kind: 'none' };
      render();
      return;
    }
    state.form = createForm('edit', cloneDraft(found.model), {
      original: ref,
      groupMode: 'existing',
      nameTouched: true,
      inputTouched: true,
    });
    state.selection = { kind: 'model', ref };
    state.lastError = undefined;
    render();
  };
  if (skipGuard) {
    action();
    return;
  }
  withDiscardGuard(action);
}

function selectGroup(group: GroupRef): void {
  withDiscardGuard(() => {
    if (!findGroup(group.vendor, group.groupName)) {
      showToast('error', '该分组已不存在，请刷新后重试。');
      return;
    }
    state.form = undefined;
    state.selection = { kind: 'group', group };
    state.lastError = undefined;
    render();
  });
}

function selectModel(group: ProviderGroup, model: ModelRecord): void {
  startEdit({ vendor: group.vendor, groupName: group.name, id: model.id });
}

function withDiscardGuard(action: () => void): void {
  const run = (): void => {
    if (state.form?.testing) {
      send('connection/cancel', {}, 'cancelTest');
    }
    action();
  };
  if (!state.form?.dirty) {
    run();
    return;
  }
  openDialog({
    kind: 'discard',
    message: '当前表单有未保存的修改，继续将放弃这些修改。',
    onConfirm: () => {
      closeDialog();
      run();
    },
  });
}

function closeForm(): void {
  withDiscardGuard(() => {
    state.form = undefined;
    state.selection = { kind: 'none' };
    state.lastError = undefined;
    render();
  });
}

/* ------------------------------------------------------------------ */
/* 表单编辑                                                            */
/* ------------------------------------------------------------------ */

function updateDraft(
  patch: Partial<ModelDraft>,
  options: { render?: boolean; markNameTouched?: boolean; markInputTouched?: boolean } = {},
): void {
  const form = state.form;
  if (!form) {
    return;
  }
  const previous = form.draft;
  const next: ModelDraft = { ...form.draft, ...patch };

  const vendorChanged = patch.vendor !== undefined && patch.vendor !== form.draft.vendor;
  const nameChanged =
    patch.groupName !== undefined && patch.groupName.trim() !== form.draft.groupName.trim();
  if (vendorChanged || nameChanged) {
    // 切换分组/提供方后，之前输入的密钥与“无需认证”选择都不再适用。
    next.apiKey = undefined;
    next.credentialMode = 'apiKey';
  }

  if (options.markNameTouched) {
    form.nameTouched = true;
  }
  if (patch.id !== undefined && !form.nameTouched) {
    const nameIsSynced = previous.name.trim().length === 0 || previous.name === previous.id;
    if (nameIsSynced) {
      next.name = patch.id;
    }
  }

  const contextChanged = patch.contextWindow !== undefined || patch.maxOutputTokens !== undefined;
  if (contextChanged && !form.inputTouched) {
    const auto = autoInputTokens(next.contextWindow, next.maxOutputTokens);
    if (auto !== undefined) {
      next.maxInputTokens = auto;
    }
  }
  if (patch.maxInputTokens !== undefined && options.markInputTouched !== false) {
    form.inputTouched = true;
  }

  form.draft = next;
  form.dirty = true;
  form.testResult = undefined;
  form.issues = validateForm(form);
  updateDirtySignal();

  if (options.render) {
    render();
  } else {
    refreshValidation();
    refreshDerived();
    updateFooter();
  }
}

function saveForm(): void {
  const form = state.form;
  const snapshot = state.snapshot;
  if (!form || !snapshot || form.saving) {
    return;
  }
  if (!snapshot.writeEnabled) {
    showToast('error', '当前配置不可写，请先修复配置文件或使用官方模型管理。');
    return;
  }
  if (!snapshot.credentialWriteEnabled && form.draft.apiKey?.trim()) {
    showToast('error', '当前 VS Code/Copilot 版本无法保存 API Key；请移除密钥、使用官方模型管理，或先保存无密钥配置。');
    return;
  }
  form.urlTouched = true;
  form.issues = validateForm(form);
  if (hasErrors(form.issues)) {
    render();
    focusFirstError(form);
    showToast('error', '请先修正表单中的问题，再保存。');
    return;
  }
  form.saving = true;
  form.dirty = true;
  const draft = cleanDraft(form.draft);
  render();
  send(
    'config/save',
    {
      draft,
      expectedFingerprint: form.baseFingerprint,
      original: form.original,
    },
    'save',
  );
}

function testForm(): void {
  const form = state.form;
  const snapshot = state.snapshot;
  if (!form || !snapshot) {
    return;
  }
  if (form.testing) {
    form.testing = false;
    render();
    send('connection/cancel', {}, 'cancelTest');
    return;
  }
  if (!form.draft.url.trim() || !form.draft.id.trim()) {
    showToast('warn', '请先填写模型 ID 和 API 地址。');
    return;
  }
  form.urlTouched = true;
  const issues = validateForm(form);
  form.issues = issues;
  if (issues.some((issue) => issue.field === 'url' && issue.severity !== 'warning')) {
    render();
    showToast('error', '请先修正 API 地址，再测试连接。');
    return;
  }
  form.testing = true;
  form.testResult = undefined;
  render();
  send('connection/test', { draft: cleanDraft(form.draft) }, 'test');
}

function cleanDraft(draft: ModelDraft): ModelDraft {
  return {
    ...draft,
    groupName: draft.groupName.trim(),
    id: draft.id.trim(),
    name: draft.name.trim(),
    url: draft.url.trim(),
    supportsReasoningEffort: normalizeEffortLevels(draft.supportsReasoningEffort),
    apiKey: draft.apiKey?.trim() ? draft.apiKey.trim() : undefined,
    credentialMode: draft.credentialMode ?? 'apiKey',
  };
}

function updateDirtySignal(): void {
  const dirty = Boolean(state.form?.dirty);
  if (dirty === lastDirtySignaled) {
    return;
  }
  lastDirtySignaled = dirty;
  send('ui/dirty', { dirty }, 'dirty');
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function render(): void {
  if (!state.snapshot) {
    app.setAttribute('aria-busy', 'true');
    if (state.lastError) {
      app.replaceChildren(renderFatal(state.lastError));
    } else {
      app.replaceChildren(renderSkeleton());
    }
    return;
  }
  app.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  const focus = state.dialog ? undefined : captureFocus();
  const content = document.querySelector<HTMLElement>('.content');
  const scrollTop = content?.scrollTop ?? 0;

  app.dataset.view = state.form || state.selection.kind !== 'none' ? 'detail' : 'list';
  app.replaceChildren(renderTopbar(), renderLayout());
  if (state.form) {
    app.append(renderFooter());
  }
  if (state.dialog) {
    app.append(renderDialog(state.dialog));
  }
  updateSummaryContainers();
  updateFooter();
  updateDirtySignal();

  if (state.dialog) {
    focusDialog();
  } else {
    restoreFocus(focus);
  }
  const latestContent = document.querySelector<HTMLElement>('.content');
  if (latestContent) {
    latestContent.scrollTop = scrollTop;
  }
}

function renderSkeleton(): HTMLElement {
  const wrapper = el('div', { class: 'skeleton-layout' });
  const left = el('div', {});
  for (let index = 0; index < 4; index += 1) {
    left.append(el('div', { class: 'skeleton card' }));
  }
  const right = el('div', {});
  right.append(el('div', { class: 'skeleton hero' }), el('div', { class: 'skeleton hero' }));
  wrapper.append(left, right);
  const status = el('div', { class: 'loading', role: 'status' }, '正在读取 Copilot 模型配置…');
  const container = el('div', {});
  container.append(wrapper, status);
  return container;
}

function renderFatal(message: string): HTMLElement {
  const wrapper = el('div', {});
  const box = el('div', { class: 'empty' });
  box.append(
    el('h2', {}, '无法读取 Copilot 模型配置'),
    el('p', {}, message),
    button('重试', () => {
      state.lastError = undefined;
      render();
      send('config/list', {}, 'list');
    }, { class: 'primary' }),
  );
  wrapper.append(box);
  return wrapper;
}

function renderTopbar(): HTMLElement {
  const snapshot = state.snapshot;
  const topbar = el('header', { class: 'topbar' });
  const title = el('h1', {});
  title.append(document.createTextNode('Copilot 模型管理'));
  const subtitle = el(
    'span',
    { class: 'subtitle' },
    `VS Code ${snapshot?.vscodeVersion ?? ''}${snapshot?.copilotVersion ? ` · Copilot ${snapshot.copilotVersion}` : ''} · 当前 Profile`,
  );
  title.append(subtitle);
  topbar.append(title);

  const actions = el('div', { class: 'topbar-actions' });
  actions.append(
    button('新增模型', () => startCreate(), { class: 'primary', disabled: !snapshot?.writeEnabled }),
    button('刷新', () => send('ui/refresh', {}, 'refresh')),
  );
  actions.append(renderMoreMenu());
  topbar.append(actions);
  return topbar;
}

function renderMoreMenu(): HTMLElement {
  const details = el('details', { class: 'more-menu' });
  const summary = el('summary', { 'aria-label': '更多操作' }, '更多');
  details.append(summary);
  const panel = el('div', { class: 'menu-panel', role: 'menu' });
  const add = (label: string, action: () => void, options: { enabled?: boolean } = {}): void => {
    const item = button(label, () => {
      details.open = false;
      action();
    }, { disabled: options.enabled === false });
    item.setAttribute('role', 'menuitem');
    panel.append(item);
  };
  add('导入 JSON…', () => openImportDialog(), { enabled: Boolean(state.snapshot?.writeEnabled) });
  add('导出（不含密钥）…', () => openExportDialog());
  add('导入旧版设置', () => importLegacy(), {
    enabled: (state.snapshot?.legacyModels.length ?? 0) > 0 && Boolean(state.snapshot?.writeEnabled),
  });
  panel.append(document.createElement('hr'));
  add('打开 chatLanguageModels.json', () => send('panel/openConfigFile', {}, 'open'));
  add('打开备份目录', () => send('panel/openBackups', {}, 'open'));
  add('打开旧版设置', () => send('legacy/openSetting', {}, 'open'));
  if (state.snapshot?.dashboardAvailable) {
    add('打开官方模型管理', () => send('panel/openOfficial', {}, 'open'));
  }
  details.append(panel);
  return details;
}

function renderLayout(): HTMLElement {
  const layout = el('div', { class: 'layout' });
  layout.append(renderSidebar(), renderContent());
  return layout;
}

function renderSidebar(): HTMLElement {
  const sidebar = el('nav', { class: 'sidebar', 'aria-label': '模型列表' });
  const groups = state.snapshot?.groups ?? [];
  const legacy = state.snapshot?.legacyModels ?? [];

  const heading = el('div', { class: 'sidebar-heading' });
  heading.append(el('span', {}, `连接分组 · ${groups.length}`));
  sidebar.append(heading);

  if (groups.length === 0) {
    const empty = el('div', { class: 'empty' });
    empty.append(
      el('p', {}, '还没有第三方模型配置。'),
      button('添加第一个模型', () => startCreate(), {
        class: 'primary',
        disabled: !state.snapshot?.writeEnabled,
      }),
    );
    sidebar.append(empty);
  }

  for (const group of groups) {
    sidebar.append(renderGroupSection(group));
  }

  if (legacy.length > 0) {
    sidebar.append(renderLegacyCard(legacy));
  }
  return sidebar;
}

function renderGroupSection(group: ProviderGroup): HTMLElement {
  const section = el('div', { class: 'group' });
  const head = el('div', { class: 'group-head' });
  const info = vendorInfo(group.vendor);
  const selected = state.selection.kind === 'group' && state.selection.group.vendor === group.vendor && state.selection.group.groupName === group.name;
  const title = button('', () => selectGroup({ vendor: group.vendor, groupName: group.name }), {
    class: 'group-title' + (selected ? ' selected' : ''),
  });
  title.setAttribute('aria-label', `打开分组设置：${group.name}`);
  title.append(el('span', { class: 'name' }, group.name));
  title.append(el('span', { class: 'badge' }, info?.label ?? group.vendor));
  if (group.hasApiKey) {
    title.append(el('span', { class: 'badge on' }, '已存凭据'));
  } else {
    title.append(el('span', { class: 'badge warn' }, '无凭据'));
  }
  head.append(title);
  section.append(head);

  for (const model of group.models) {
    section.append(renderModelCard(group, model));
  }
  if (group.models.length === 0) {
    section.append(el('div', { class: 'hint' }, '分组中还没有模型。'));
  }
  return section;
}

function renderModelCard(group: ProviderGroup, model: ModelRecord): HTMLElement {
  const ref: ModelRef = { vendor: group.vendor, groupName: group.name, id: model.id };
  const selected = state.selection.kind === 'model' && sameRef(state.selection.ref, ref);
  const card = el('div', { class: 'model-card' + (selected ? ' selected' : '') });
  const main = button('', () => selectModel(group, model), { class: 'model-main' });
  main.setAttribute('aria-current', selected ? 'true' : 'false');
  main.setAttribute('aria-label', `编辑模型 ${model.name}（${model.id}）`);
  const title = el('span', { class: 'title', title: model.name }, model.name);
  const meta = el('span', { class: 'meta', title: model.id }, `${model.id} · ${formatTokenCount(model.contextWindow)} 上下文`);
  const badges = el('span', { class: 'badges' });
  badges.append(el('span', { class: 'badge' }, apiTypeLabel(model.apiType)));
  if (model.vision) {
    badges.append(el('span', { class: 'badge on' }, '视觉'));
  }
  if (model.thinking) {
    badges.append(
      el('span', { class: 'badge on' }, `思考 ${model.supportsReasoningEffort.join('/') || '默认'}`),
    );
  }
  if (!model.toolCalling) {
    badges.append(el('span', { class: 'badge' }, '无工具调用'));
  }
  if (!model.streaming) {
    badges.append(el('span', { class: 'badge' }, '非流式'));
  }
  main.append(title, meta, badges);
  card.append(main);

  const actions = el('div', { class: 'model-actions' });
  actions.append(
    button('复制', () => startCopy(ref), {
      class: 'icon-button',
      'aria-label': `复制模型 ${model.name}`,
      title: '复制模型',
    }),
    button('删除', () => deleteModel(ref, model.name), {
      class: 'icon-button danger',
      'aria-label': `删除模型 ${model.name}`,
      title: '删除模型',
    }),
  );
  card.append(actions);
  return card;
}

function renderLegacyCard(models: readonly ModelRecord[]): HTMLElement {
  const card = el('div', { class: 'legacy-card' });
  card.append(el('strong', {}, `旧版设置 · ${models.length} 个模型`));
  const list = el('ul', {});
  for (const model of models.slice(0, 6)) {
    list.append(el('li', {}, `${model.name}（${model.id}）`));
  }
  if (models.length > 6) {
    list.append(el('li', {}, `…还有 ${models.length - 6} 个`));
  }
  card.append(list);
  card.append(el('div', { class: 'hint' }, '旧设置只会被读取；导入不会删除它，也不会自动迁移。'));
  const actions = el('div', { class: 'banner-actions' });
  actions.append(
    button('导入到面板', () => importLegacy(), { class: 'primary' }),
    button('查看设置', () => send('legacy/openSetting', {}, 'open'), { class: 'link' }),
  );
  card.append(actions);
  return card;
}

function renderContent(): HTMLElement {
  const content = el('main', { class: 'content', id: 'content' });
  if (state.form) {
    content.append(renderFormPage(state.form));
    return content;
  }
  if (state.selection.kind === 'group') {
    const group = findGroup(state.selection.group.vendor, state.selection.group.groupName);
    if (group) {
      content.append(renderGroupPage(group));
      return content;
    }
  }
  content.append(renderWelcome());
  return content;
}

function renderWelcome(): HTMLElement {
  const wrapper = el('div', {});
  const snapshot = state.snapshot;
  const groups = snapshot?.groups ?? [];

  if (state.lastError) {
    wrapper.append(renderTransientError(state.lastError));
  }
  wrapper.append(
    banner(
      'info',
      '可视化添加第三方模型',
      '配置写入当前 VS Code Profile 的语言模型配置文件。面板只合并目标分组和目标模型，并保留其他字段、其他分组与其他提供方配置。',
    ),
  );
  if (snapshot?.adapterMessage) {
    wrapper.append(banner(snapshot.adapterAvailable ? 'warn' : 'error', '兼容性提示', snapshot.adapterMessage));
  }
  if (snapshot && !snapshot.credentialWriteEnabled) {
    wrapper.append(
      banner(
        'warn',
        'API Key 写入受限',
        '当前 VS Code / Copilot 版本不支持通过内部命令保存 API Key。你仍可保存不含密钥的配置，或使用官方模型管理设置凭据。',
      ),
    );
  }

  if (groups.length === 0) {
    const empty = el('div', { class: 'empty' });
    empty.append(
      el('p', {}, '填写模型 ID、接口地址和上下文长度即可创建第一个第三方模型。'),
      button('添加第一个模型', () => startCreate(), {
        class: 'primary',
        disabled: !snapshot?.writeEnabled,
      }),
    );
    wrapper.append(empty);
  }

  const summary = el('dl', { class: 'summary-grid' });
  const addRow = (label: string, value: string): void => {
    const item = el('div', { class: 'summary-item' });
    item.append(el('dt', {}, label), el('dd', { title: value }, value));
    summary.append(item);
  };
  addRow('配置文件', snapshot?.configFilePath ?? '未知');
  addRow('配置来源', sourceLabel(snapshot));
  addRow('Copilot 版本', snapshot?.copilotVersion ?? '未检测到');
  addRow('提供方', (snapshot?.vendorInfo ?? []).map((info) => info.label).join('、') || '未知');
  addRow('配置作用域', '当前 VS Code Profile');
  wrapper.append(summary);

  wrapper.append(
    el(
      'div',
      { class: 'hint' },
      '提示：思考强度的最终选择由 Copilot 模型选择器按会话保存；面板声明模型支持哪些档位。连接测试只在手动触发时发送请求。',
    ),
  );
  return wrapper;
}

function renderGroupPage(group: ProviderGroup): HTMLElement {
  const wrapper = el('div', {});
  const head = el('div', { class: 'page-head' });
  head.append(backButton());
  const titles = el('div', {});
  titles.append(el('h2', {}, group.name));
  const info = vendorInfo(group.vendor);
  titles.append(el('div', { class: 'meta-line' }, `${info?.label ?? group.vendor} · ${group.models.length} 个模型`));
  head.append(titles);

  const actions = el('div', { class: 'head-actions' });
  actions.append(
    button('新增模型到该分组', () => startCreateInGroup(group), {
      class: 'primary',
      disabled: !state.snapshot?.writeEnabled,
    }),
    button(group.hasApiKey ? '更新 API Key' : '设置 API Key', () => promptGroupKey(group)),
    button('打开 JSON 配置', () => send('panel/openConfigFile', {}, 'open'), { class: 'link' }),
  );
  head.append(actions);
  wrapper.append(head);

  const credentialBadge = el('div', { class: 'badges' });
  credentialBadge.append(
    el('span', { class: 'badge' }, info?.label ?? group.vendor),
    el('span', { class: 'badge' + (group.hasApiKey ? ' on' : ' warn') }, group.hasApiKey ? '已保存凭据' : '无凭据'),
    el('span', { class: 'badge' }, group.apiType ? apiTypeLabel(group.apiType) : '默认 API 类型'),
  );
  wrapper.append(credentialBadge);

  if (state.lastError) {
    wrapper.append(renderTransientError(state.lastError));
  }
  if (!group.hasApiKey) {
    wrapper.append(
      banner('warn', '缺少凭据', '这个分组尚未保存 API Key。需要认证的模型必须先设置 Key，否则请求会失败。'),
    );
  }
  wrapper.append(
    banner(
      'info',
      '分组是配置身份',
      '同一分组的模型共享凭据。编辑模型时不能更换分组；如需迁移，请新建模型后删除旧条目。MVP 不提供分组重命名。',
    ),
  );

  const list = el('fieldset', {});
  list.append(el('legend', {}, '分组中的模型'));
  if (group.models.length === 0) {
    list.append(el('div', { class: 'hint' }, '还没有模型。点击上方“新增模型到该分组”开始。'));
  }
  for (const model of group.models) {
    list.append(renderModelCard(group, model));
  }
  wrapper.append(list);

  const danger = el('div', { class: 'footer' });
  const status = el('div', { class: 'status-text' }, '危险操作会修改 Copilot 配置。');
  danger.append(status);
  if (group.hasApiKey) {
    danger.append(
      button('清除分组凭据', () => clearGroupKey(group), { class: 'danger' }),
    );
  }
  danger.append(
    button('删除分组', () => deleteGroup(group), { class: 'danger' }),
  );
  wrapper.append(danger);
  return wrapper;
}

function renderFormPage(form: FormState): HTMLElement {
  const wrapper = el('div', {});
  const head = el('div', { class: 'page-head' });
  head.append(backButton());
  const titles = el('div', {});
  const heading =
    form.mode === 'create'
      ? '新增模型'
      : form.mode === 'copy'
        ? `复制模型：${form.original?.id ?? form.draft.id}`
        : `编辑模型：${form.original?.id ?? form.draft.id}`;
  titles.append(el('h2', {}, heading));
  titles.append(
    el(
      'div',
      { class: 'meta-line' },
      `${vendorLabel(form.draft.vendor)} · ${form.draft.groupName || '未选择分组'}${form.mode === 'edit' ? ' · 编辑' : form.mode === 'copy' ? ' · 副本' : ' · 新建'}`,
    ),
  );
  head.append(titles);
  wrapper.append(head);

  if (state.lastError) {
    wrapper.append(renderTransientError(state.lastError));
  }
  if (!state.snapshot?.writeEnabled) {
    wrapper.append(
      banner('error', '配置不可写', state.snapshot?.adapterMessage ?? '配置文件无法读取或解析，保存已禁用。'),
    );
  } else if (!state.snapshot.credentialWriteEnabled) {
    wrapper.append(
      banner(
        'warn',
        'API Key 写入受限',
        '当前 VS Code/Copilot 不支持通过内部命令保存 API Key；不带新密钥的模型配置仍可保存。',
      ),
    );
  }
  if (form.stale) {
    const stale = banner(
      'warn',
      '配置已在外部修改',
      '保存会基于打开表单时的快照进行冲突检测。若外部修改不影响目标分组，可改用最新快照继续；否则请返回列表刷新。',
    );
    const actions = el('div', { class: 'banner-actions' });
    actions.append(
      button('改用最新快照继续', () => {
        const snapshot = state.snapshot;
        if (snapshot) {
          form.baseFingerprint = snapshot.fingerprint;
          form.stale = false;
          form.issues = validateForm(form);
          render();
        }
      }, { class: 'link' }),
      button('返回列表', () => closeForm(), { class: 'link' }),
    );
    stale.append(actions);
    wrapper.append(stale);
  }
  const info = vendorInfo(form.draft.vendor);
  if (info && !info.available) {
    wrapper.append(
      banner(
        'warn',
        '提供方不可用',
        `当前安装的 Copilot 没有声明 ${info.label} 提供方。配置仍可导出，但模型可能不会出现在选择器中。`,
      ),
    );
  }

  const formElement = el('form', { class: 'model-form', novalidate: 'novalidate' });
  formElement.addEventListener('submit', (event) => event.preventDefault());
  formElement.append(renderBasics(form), renderContext(form), renderThinking(form), renderAdvanced(form));
  wrapper.append(el('div', { id: 'form-error-summary', 'aria-live': 'polite' }));
  wrapper.append(el('div', { id: 'form-warning-summary', 'aria-live': 'polite' }));
  wrapper.append(formElement);

  if (form.testResult) {
    wrapper.append(renderTestResult(form.testResult));
  }
  updateSummaryContainersInto(wrapper, form);
  return wrapper;
}

function renderTransientError(message: string): HTMLElement {
  const errorBanner = banner('error', '操作失败', message);
  const actions = el('div', { class: 'banner-actions' });
  actions.append(
    button('关闭', () => {
      state.lastError = undefined;
      render();
    }, { class: 'link' }),
  );
  errorBanner.append(actions);
  return errorBanner;
}

/* ---------------------------- 基础信息 ---------------------------- */

function renderBasics(form: FormState): HTMLElement {
  const fieldset = el('fieldset', {});
  fieldset.append(el('legend', {}, '基础信息'));
  const draft = form.draft;
  const snapshot = state.snapshot;
  const editing = form.mode === 'edit';

  if (!editing && form.groupMode === 'new') {
    const vendorOptions = (snapshot?.vendorInfo ?? []).map<[string, string]>((info) => [
      info.vendor,
      `${info.label}${info.available ? '' : '（当前不可用）'}`,
    ]);
    if (vendorOptions.length > 1) {
      fieldset.append(
        field(
          '模型提供方',
          'vendor',
          select(vendorOptions, draft.vendor, (value) => {
            updateDraft({ vendor: value as VendorId }, { render: true });
          }),
          'Custom Endpoint 是当前推荐提供方；已弃用提供方仅用于兼容旧配置。',
        ),
      );
    }
  }

  const groups = snapshot?.groups ?? [];
  if (editing) {
    fieldset.append(
      field(
        '连接分组',
        'groupName',
        input('text', draft.groupName, () => undefined, { readonly: 'readonly' }),
        '编辑时不能更换分组，避免产生重复模型。如需迁移，请新建模型后删除旧条目。',
      ),
    );
  } else {
    const options: [string, string][] = groups.map((group) => [
      groupKey(group.vendor, group.name),
      `${group.name} · ${vendorLabel(group.vendor)}`,
    ]);
    options.push(['__new__', '＋ 新建分组…']);
    const currentValue =
      form.groupMode === 'existing' ? groupKey(draft.vendor, draft.groupName) : '__new__';
    fieldset.append(
      field(
        '连接分组',
        'groupName',
        select(options, currentValue, (value) => {
          if (value === '__new__') {
            form.groupMode = 'new';
            const base =
              draft.groupName && !findGroup(draft.vendor, draft.groupName.trim())
                ? draft.groupName
                : 'My Provider';
            updateDraft({ groupName: uniqueGroupName(draft.vendor, base) }, { render: true });
            return;
          }
          const group = groups.find((entry) => groupKey(entry.vendor, entry.name) === value);
          if (!group) {
            return;
          }
          form.groupMode = 'existing';
          updateDraft({ vendor: group.vendor, groupName: group.name }, { render: true });
        }),
        '同一分组的模型共享 API Key。不同服务账号请使用不同分组。',
        form.groupMode === 'new' ? 'groupNameSelect' : 'groupName',
      ),
    );
    if (form.groupMode === 'new') {
      const nameInput = input('text', draft.groupName, (value) => {
        updateDraft({ groupName: value });
      }, { placeholder: '例如：My Provider', required: true });
      nameInput.addEventListener('change', () => {
        updateDraft({}, { render: true });
      });
      fieldset.append(
        field('新分组名称', 'groupNameNew', nameInput, '新分组会与已有分组并列；同名分组请直接从上方列表选择。', 'groupName'),
      );
    }
  }

  const idInput = input('text', draft.id, (value) => updateDraft({ id: value }), {
    placeholder: '服务方要求的 model 名称',
    required: true,
    spellcheck: 'false',
  });
  fieldset.append(field('模型 ID', 'id', idInput, '会原样发送给服务方；同一分组内必须唯一。'));

  const nameInput = input('text', draft.name, (value) => {
    updateDraft({ name: value }, { markNameTouched: true });
  }, { placeholder: '在 Copilot 模型选择器中显示', required: true });
  fieldset.append(field('显示名称', 'name', nameInput, '新建时默认跟随模型 ID，手动修改后不再自动覆盖。'));

  const urlInput = input('text', draft.url, (value) => updateDraft({ url: value }), {
    placeholder: 'https://api.example.com/v1/chat/completions',
    required: true,
    spellcheck: 'false',
  });
  urlInput.addEventListener('change', () => {
    form.urlTouched = true;
    refreshValidation();
    updateFooter();
  });
  fieldset.append(field('API 地址', 'url', urlInput, urlHint(draft), undefined, 'hint-url'));

  const info = vendorInfo(draft.vendor);
  if (info?.supportsModelApiType ?? draft.vendor === 'customendpoint') {
    fieldset.append(
      field(
        'API 类型',
        'apiType',
        select(
          [
            ['chat-completions', 'Chat Completions'],
            ['responses', 'Responses'],
            ['messages', 'Messages（Anthropic 兼容）'],
          ],
          draft.apiType,
          (value) => updateDraft({ apiType: value as ModelDraft['apiType'] }),
        ),
        '决定请求/响应格式。地址已包含 /chat/completions、/responses 或 /messages 时以其路径为准。',
      ),
    );
  }

  fieldset.append(renderCredentialFields(form));
  return fieldset;
}

function renderCredentialFields(form: FormState): HTMLElement {
  const draft = form.draft;
  const group = findGroup(draft.vendor, draft.groupName.trim());
  const hasCredential = group?.hasApiKey ?? false;
  const block = el('div', { class: 'field' });
  block.append(el('div', { class: 'label-like' }, '认证方式'));
  block.append(
    el(
      'div',
      { class: 'hint' },
      hasCredential
        ? '该分组已保存凭据。留空表示继续使用原 Key，密钥永远不会回显到面板。'
        : draft.credentialMode === 'none'
          ? '该分组没有保存凭据，模型将以无认证方式调用；需要鉴权时请改用“使用 API Key”。'
          : '该分组还没有凭据：请输入 API Key，或明确选择“无需认证”。',
    ),
  );

  const keyRadio = radio(
    'credential-mode',
    'apiKey',
    draft.credentialMode !== 'none',
    () => updateDraft({ credentialMode: 'apiKey' }, { render: true }),
    '使用 API Key',
  );
  const noneRadio = radio(
    'credential-mode',
    'none',
    draft.credentialMode === 'none',
    () => updateDraft({ credentialMode: 'none', apiKey: undefined }, { render: true }),
    '无需认证（本地或受信任服务）',
    hasCredential ? '该分组已有凭据；如需无认证，请先在分组设置中清除分组凭据。' : undefined,
    hasCredential,
  );
  block.append(keyRadio, noneRadio);

  if (draft.credentialMode !== 'none') {
    block.append(
      field(
        hasCredential ? 'API Key（留空则不修改）' : 'API Key',
        'apiKey',
        input('password', draft.apiKey ?? '', (value) => updateDraft({ apiKey: value }), {
          placeholder: hasCredential ? '已配置，留空保留原凭据' : '本地服务可留空并选择“无需认证”',
          autocomplete: 'off',
        }),
        '只在本机 VS Code 密钥存储中保存；不会写入导出文件或日志。',
      ),
    );
  }
  block.append(el('div', { id: 'msgs-credentialMode', class: 'field-messages' }));
  return block;
}

/* ---------------------------- 上下文与能力 ---------------------------- */

function renderContext(form: FormState): HTMLElement {
  const draft = form.draft;
  const fieldset = el('fieldset', {});
  fieldset.append(el('legend', {}, '上下文与能力'));

  const row = el('div', { class: 'row' });
  row.append(
    field(
      '总上下文窗口',
      'contextWindow',
      numberInput(draft.contextWindow, (value) => updateDraft({ contextWindow: value })),
      '输入与输出共享的完整上下文窗口。',
    ),
    field(
      '最大输入 Tokens',
      'maxInputTokens',
      numberInput(draft.maxInputTokens, (value) => updateDraft({ maxInputTokens: value })),
      '通常等于总窗口减去最大输出；手动编辑后将不再自动跟随。',
    ),
    field(
      '最大输出 Tokens',
      'maxOutputTokens',
      numberInput(draft.maxOutputTokens, (value) => updateDraft({ maxOutputTokens: value })),
    ),
  );
  fieldset.append(row);

  const linkRow = el('div', { class: 'hint' });
  linkRow.append(
    button('按总窗口自动计算输入', () => {
      form.inputTouched = false;
      const auto = autoInputTokens(draft.contextWindow, draft.maxOutputTokens);
      if (auto === undefined) {
        showToast('warn', '请先填写有效的总上下文窗口和最大输出 Tokens。');
        return;
      }
      updateDraft({ maxInputTokens: auto }, { markInputTouched: false });
      refreshDerived();
    }, { class: 'link' }),
  );
  linkRow.append(el('span', { id: 'hint-context' }, contextHint(draft, form.inputTouched)));
  fieldset.append(linkRow);

  fieldset.append(
    check('工具调用', draft.toolCalling, (value) => updateDraft({ toolCalling: value }), '服务方真实支持时才开启。'),
    check('视觉模型', draft.vision, (value) => updateDraft({ vision: value }), '允许向模型发送图片。纯文本模型请勿开启。'),
    check('流式输出', draft.streaming, (value) => updateDraft({ streaming: value }), '接口不兼容流式响应时可关闭。'),
  );
  return fieldset;
}

/* ---------------------------- 思考设置 ---------------------------- */

function renderThinking(form: FormState): HTMLElement {
  const draft = form.draft;
  const fieldset = el('fieldset', {});
  fieldset.append(el('legend', {}, '思考设置'));
  fieldset.append(
    check(
      '支持思考',
      draft.thinking,
      (value) => {
        updateDraft(
          {
            thinking: value,
            supportsReasoningEffort:
              value && draft.supportsReasoningEffort.length === 0
                ? defaultEffortLevels()
                : draft.supportsReasoningEffort,
          },
          { render: true },
        );
      },
      '声明模型具有思考能力；实际效果取决于服务方实现。',
    ),
  );

  if (!draft.thinking) {
    fieldset.append(el('div', { class: 'hint' }, '未启用思考时，不会写入思考相关字段。'));
    return fieldset;
  }

  const levels = new Set(draft.supportsReasoningEffort.map((level) => level.toLowerCase()));
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': '支持的思考强度' });
  const extra = draft.supportsReasoningEffort.filter(
    (level) => !(COMMON_EFFORT_LEVELS as readonly string[]).includes(level.toLowerCase()),
  );
  for (const level of [...COMMON_EFFORT_LEVELS, ...extra]) {
    const active = levels.has(level.toLowerCase());
    const chip = button(level, () => {
      const exists = draft.supportsReasoningEffort.some((entry) => entry.toLowerCase() === level.toLowerCase());
      const next = exists
        ? draft.supportsReasoningEffort.filter((entry) => entry.toLowerCase() !== level.toLowerCase())
        : [...draft.supportsReasoningEffort, level];
      const defaultStillValid =
        draft.defaultReasoningEffort &&
        next.some((entry) => entry.toLowerCase() === draft.defaultReasoningEffort?.toLowerCase());
      updateDraft(
        {
          supportsReasoningEffort: next,
          defaultReasoningEffort: defaultStillValid ? draft.defaultReasoningEffort : undefined,
        },
        { render: true },
      );
    }, { class: 'chip' });
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    chips.append(chip);
  }
  const chipsField = el('div', { class: 'field' });
  chipsField.append(el('div', { class: 'label-like' }, '支持的思考强度'), chips);
  chipsField.append(el('div', { class: 'hint' }, '按服务方文档勾选；自定义值可在下方填写。'));
  fieldset.append(chipsField);

  const customInput = input('text', form.customEffortsText, (value) => {
    form.customEffortsText = value;
    const custom = value
      .split(/[,，\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const common = draft.supportsReasoningEffort.filter((level) =>
      (COMMON_EFFORT_LEVELS as readonly string[]).includes(level.toLowerCase()),
    );
    updateDraft({ supportsReasoningEffort: [...common, ...custom] });
  }, { placeholder: '例如：auto, ultra' });
  customInput.addEventListener('change', () => {
    updateDraft({}, { render: true });
  });
  fieldset.append(field('自定义强度', 'customEfforts', customInput, '用逗号分隔。未确认服务方支持时不要随意填写。'));

  fieldset.append(
    field(
      '默认强度',
      'defaultReasoningEffort',
      select(
        [
          ['', '使用 Copilot / 服务方默认'],
          ...draft.supportsReasoningEffort.map((level) => [level, level] as [string, string]),
        ],
        draft.defaultReasoningEffort ?? '',
        (value) => updateDraft({ defaultReasoningEffort: value || undefined }),
      ),
      '此默认值是否生效取决于 Copilot 版本；聊天中可在模型选择器按会话调整。',
    ),
  );

  if ((vendorInfo(draft.vendor)?.supportsReasoningEffortFormat ?? draft.vendor === 'customendpoint')) {
    fieldset.append(
      field(
        '强度参数格式',
        'reasoningEffortFormat',
        select(
          [
            ['', '按 API 类型自动'],
            ['chat-completions', '顶层 reasoning_effort'],
            ['responses', '嵌套 reasoning.effort'],
            ['messages', 'output_config.effort（Messages）'],
          ],
          draft.reasoningEffortFormat ?? '',
          (value) => updateDraft({ reasoningEffortFormat: (value || undefined) as ModelDraft['reasoningEffortFormat'] }),
        ),
        '仅当服务方字段约定与 API 路径不一致时覆盖。',
      ),
    );
  }
  return fieldset;
}

/* ---------------------------- 高级设置 ---------------------------- */

function renderAdvanced(form: FormState): HTMLElement {
  const details = el('details', { class: 'advanced' });
  details.append(el('summary', {}, '高级设置'));
  const draft = form.draft;

  const insecureBlock = el('div', { class: 'advanced-block' });
  insecureBlock.append(
    check(
      '允许向非本机 http 地址发送凭据',
      draft.allowInsecureHttp ?? false,
      (value) => updateDraft({ allowInsecureHttp: value }),
      'http 会明文传输 API Key。仅在可信内网且无法使用 https 时开启。',
    ),
  );
  details.append(insecureBlock);

  const previewBlock = el('div', { class: 'advanced-block' });
  previewBlock.append(el('div', { class: 'hint' }, '即将写入的模型对象（不含 API Key）：'));
  const preview = el('pre', { class: 'json', id: 'json-preview' });
  preview.textContent = previewJson(form);
  previewBlock.append(preview);
  details.append(previewBlock);

  const links = el('div', { class: 'advanced-block' });
  links.append(el('div', { class: 'hint' }, '配置与凭据：'));
  const linkRow = el('div', { class: 'banner-actions' });
  const group = findGroup(draft.vendor, draft.groupName.trim());
  if (group) {
    linkRow.append(
      button(group.hasApiKey ? '更新分组 API Key' : '设置分组 API Key', () => promptGroupKey(group), { class: 'link' }),
    );
    if (group.hasApiKey) {
      linkRow.append(
        button('清除分组凭据', () => clearGroupKey(group), { class: 'link danger' }),
      );
    }
  }
  linkRow.append(
    button('打开 chatLanguageModels.json', () => send('panel/openConfigFile', {}, 'open'), { class: 'link' }),
    button('打开备份目录', () => send('panel/openBackups', {}, 'open'), { class: 'link' }),
    button('打开旧版设置', () => send('legacy/openSetting', {}, 'open'), { class: 'link' }),
  );
  links.append(linkRow);
  details.append(links);

  const legacyBlock = el('div', { class: 'advanced-block' });
  legacyBlock.append(
    el('div', { class: 'hint' }, `旧版设置中的模型（${state.snapshot?.legacyModels.length ?? 0} 个）只读加载；导入不会删除旧设置。`),
    button('导入旧版设置到面板', () => importLegacy(), {
      class: 'link',
      disabled: (state.snapshot?.legacyModels.length ?? 0) === 0,
    }),
  );
  details.append(legacyBlock);
  return details;
}

function previewJson(form: FormState): string {
  const existing = form.original ? findModel(form.original)?.model.raw : undefined;
  const raw = applyDraftToRaw(cleanDraft(form.draft), existing, capabilitiesFor(form.draft.vendor));
  return JSON.stringify(raw, undefined, 2);
}

/* ---------------------------- 底部操作区 ---------------------------- */

function renderFooter(): HTMLElement {
  const form = state.form;
  const footer = el('footer', { class: 'footer', 'aria-label': '表单操作' });
  const status = el('div', { class: 'status-text', id: 'footer-status' });
  footer.append(status);

  const danger = el('div', { class: 'danger-zone' });
  if (form?.mode === 'edit' && form.original) {
    danger.append(
      button('复制为新模型', () => startCopy(form.original!), { class: 'link' }),
      button('删除模型', () => deleteModel(form.original!, form.draft.name || form.draft.id), { class: 'link danger' }),
    );
  }
  footer.append(danger);

  const cancelButton = button('取消', () => closeForm(), { disabled: Boolean(form?.saving) });
  cancelButton.id = 'footer-cancel';
  const testButton = button(form?.testing ? '取消测试' : '测试连接', () => testForm(), {
    class: 'secondary',
    disabled: Boolean(form?.saving) || Boolean(state.busy),
  });
  testButton.id = 'footer-test';
  const saveButton = button(
    form?.mode === 'edit' ? '保存修改' : form?.mode === 'copy' ? '创建副本' : '创建模型',
    () => saveForm(),
    { class: 'primary' },
  );
  saveButton.id = 'footer-save';
  footer.append(cancelButton, testButton, saveButton);
  return footer;
}

function updateFooter(): void {
  const form = state.form;
  if (!form) {
    return;
  }
  const status = document.getElementById('footer-status');
  if (status) {
    status.replaceChildren();
    if (form.dirty) {
      status.append(el('span', { class: 'dirty-dot', 'aria-hidden': 'true' }), document.createTextNode('未保存'));
    } else {
      status.append(document.createTextNode('没有未保存的修改'));
    }
    if (form.saving) {
      status.append(document.createTextNode(' · 正在保存'));
    }
    if (form.testing) {
      status.append(document.createTextNode(' · 正在测试连接'));
    }
    status.append(el('span', { class: 'hint' }, 'Ctrl/⌘ + S 保存，Esc 关闭对话框'));
  }
  const saveButtons = document.querySelectorAll<HTMLButtonElement>('.footer button.primary');
  const errors = hasErrors(visibleIssues(form));
  const credentialBlocked = Boolean(form.draft.apiKey?.trim()) && !state.snapshot?.credentialWriteEnabled;
  for (const buttonNode of saveButtons) {
    buttonNode.disabled = Boolean(
      form.saving || state.busy || errors || !state.snapshot?.writeEnabled || credentialBlocked,
    );
    buttonNode.title = errors
      ? '请先修正表单中的问题'
      : credentialBlocked
        ? '当前版本无法保存 API Key，请使用官方模型管理或改为无密钥配置'
        : '';
  }
  const testButton = document.querySelector<HTMLButtonElement>('.footer button.secondary');
  if (testButton) {
    testButton.disabled = Boolean(form.saving || state.busy);
    testButton.textContent = form.testing ? '取消测试' : '测试连接';
  }
}

/* ---------------------------- 校验显示 ---------------------------- */

const FIELD_NAMES = [
  'groupName',
  'groupNameNew',
  'id',
  'name',
  'url',
  'apiType',
  'apiKey',
  'credentialMode',
  'contextWindow',
  'maxInputTokens',
  'maxOutputTokens',
  'supportsReasoningEffort',
  'defaultReasoningEffort',
  'reasoningEffortFormat',
  'customEfforts',
  'allowInsecureHttp',
] as const;

function updateSummaryContainers(): void {
  const form = state.form;
  if (!form) {
    return;
  }
  const errorContainer = document.getElementById('form-error-summary');
  const warningContainer = document.getElementById('form-warning-summary');
  if (errorContainer) {
    fillErrorSummary(errorContainer, form);
  }
  if (warningContainer) {
    fillWarningSummary(warningContainer, form);
  }
}

function updateSummaryContainersInto(root: HTMLElement, form: FormState): void {
  const errorContainer = root.querySelector<HTMLElement>('#form-error-summary');
  const warningContainer = root.querySelector<HTMLElement>('#form-warning-summary');
  if (errorContainer) {
    fillErrorSummary(errorContainer, form);
  }
  if (warningContainer) {
    fillWarningSummary(warningContainer, form);
  }
}

function fillErrorSummary(container: HTMLElement, form: FormState): void {
  const errors = visibleIssues(form).filter((issue) => issue.severity !== 'warning');
  container.replaceChildren();
  if (errors.length === 0) {
    return;
  }
  const box = el('div', { class: 'form-errors', role: 'group', 'aria-label': '表单错误汇总' });
  box.append(el('strong', {}, `${errors.length} 个问题需要修正`));
  const list = el('ul', {});
  for (const issue of errors) {
    const item = el('li', {});
    item.append(
      button(issue.message, () => focusField(issue.field), { class: 'link' }),
    );
    list.append(item);
  }
  box.append(list);
  container.append(box);
}

function fillWarningSummary(container: HTMLElement, form: FormState): void {
  const warnings = visibleIssues(form).filter((issue) => issue.severity === 'warning');
  container.replaceChildren();
  if (warnings.length === 0) {
    return;
  }
  const box = el('div', { class: 'form-warnings', role: 'note' });
  box.append(el('strong', {}, '提示'));
  const list = el('ul', {});
  for (const warning of warnings) {
    list.append(el('li', {}, warning.message));
  }
  box.append(list);
  container.append(box);
}

function refreshValidation(): void {
  const form = state.form;
  if (!form) {
    return;
  }
  updateSummaryContainers();
  const issues = visibleIssues(form);
  for (const name of FIELD_NAMES) {
    const container = document.getElementById(`msgs-${name}`);
    const control = document.getElementById(`field-${name}`);
    const key =
      control instanceof HTMLElement && control.dataset.fieldKey ? control.dataset.fieldKey : name;
    if (container) {
      container.replaceChildren();
      const fieldIssues = issues.filter((issue) => issue.field === key);
      for (const issue of fieldIssues) {
        container.append(issueNode(issue));
      }
    }
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
      const hasError = issues.some((issue) => issue.field === key && issue.severity !== 'warning');
      control.classList.toggle('invalid', hasError);
      if (hasError) {
        control.setAttribute('aria-invalid', 'true');
      } else {
        control.removeAttribute('aria-invalid');
      }
    }
  }
}

function issueNode(issue: ValidationIssue): HTMLElement {
  return el('div', { class: issue.severity === 'warning' ? 'field-warning' : 'field-error' }, issue.message);
}

function focusFirstError(form: FormState): void {
  const first = form.issues.find((issue) => issue.severity !== 'warning');
  if (first) {
    focusField(first.field);
  }
}

function focusField(name: string): void {
  if (name === 'groupName') {
    const newGroup = document.getElementById('field-groupNameNew');
    if (newGroup instanceof HTMLElement) {
      newGroup.focus();
      return;
    }
  }
  const direct = document.getElementById(`field-${name}`);
  if (direct instanceof HTMLElement) {
    direct.focus();
    return;
  }
  if (name === 'credentialMode') {
    const radioNode = document.querySelector<HTMLInputElement>('input[name="credential-mode"][value="apiKey"]');
    radioNode?.focus();
    return;
  }
  document.getElementById('field-id')?.focus();
}

function refreshDerived(): void {
  const form = state.form;
  if (!form) {
    return;
  }
  const urlHintNode = document.getElementById('hint-url');
  if (urlHintNode) {
    urlHintNode.textContent = urlHint(form.draft);
  }
  const contextHintNode = document.getElementById('hint-context');
  if (contextHintNode) {
    contextHintNode.textContent = contextHint(form.draft, form.inputTouched);
  }
  if (!form.inputTouched) {
    const inputNode = document.getElementById('field-maxInputTokens');
    if (inputNode instanceof HTMLInputElement) {
      const auto = autoInputTokens(form.draft.contextWindow, form.draft.maxOutputTokens);
      if (auto !== undefined) {
        inputNode.value = String(auto);
      }
    }
  }
  if (!form.nameTouched) {
    const nameNode = document.getElementById('field-name');
    if (nameNode instanceof HTMLInputElement && nameNode.value !== form.draft.name) {
      nameNode.value = form.draft.name;
    }
  }
  const preview = document.getElementById('json-preview');
  if (preview) {
    preview.textContent = previewJson(form);
  }
}

function urlHint(draft: ModelDraft): string {
  if (!draft.url.trim()) {
    return '优先填写完整端点。也可以填写基础地址，Copilot 会追加 /v1/chat/completions 等路径。';
  }
  try {
    return `Copilot 实际请求：${resolveRequestUrl(draft.url.trim(), draft.apiType)}`;
  } catch {
    return '地址格式无法识别。';
  }
}

function contextHint(draft: ModelDraft, inputTouched: boolean): string {
  const auto = autoInputTokens(draft.contextWindow, draft.maxOutputTokens);
  if (auto === undefined) {
    return '需要满足：输入 + 输出 = 总窗口，且各值均为正整数。';
  }
  if (inputTouched) {
    if (Number.isSafeInteger(draft.maxInputTokens) && draft.maxInputTokens === auto) {
      return `当前输入与自动换算一致（${auto.toLocaleString()}）。`;
    }
    return `当前为手动输入；按总窗口自动计算应为 ${auto.toLocaleString()}。`;
  }
  return `已自动换算：输入 = 总窗口 − 输出 = ${auto.toLocaleString()}。`;
}

/* ---------------------------- 测试结果 ---------------------------- */

function renderTestResult(result: ConnectionTestResult): HTMLElement {
  const box = el('div', {
    class: `test-result ${result.ok ? 'success' : 'fail'}`,
    role: 'status',
    'aria-live': 'polite',
  });
  box.append(el('strong', {}, result.ok ? '测试成功' : '测试失败'));
  const latencyText = result.message.includes('ms') ? '' : `（${result.latencyMs} ms）`;
  box.append(document.createTextNode(`${result.message}${latencyText}`));
  if (!result.ok && result.kind) {
    box.append(el('div', { class: 'hint' }, errorKindHint(result.kind)));
  }
  return box;
}

function errorKindHint(kind: NonNullable<ConnectionTestResult['kind']>): string {
  switch (kind) {
    case 'dns':
      return '请检查域名拼写、DNS 与网络代理。';
    case 'timeout':
      return '可提高超时时间，或检查服务方是否可达。';
    case 'tls':
      return '检查证书链、代理或企业中间证书。';
    case 'auth':
      return 'Key 可能无效或权限不足；测试时输入的 Key 不会被保存。';
    case 'forbidden':
      return '账号可能被限制访问该模型或地区。';
    case 'not-found':
      return '确认完整端点与模型 ID 与服务方文档一致。';
    case 'rate-limit':
      return '稍后重试，或检查配额。';
    case 'server':
      return '服务方暂时异常，稍后重试。';
    case 'redirect':
      return '请填写重定向后的最终端点，避免凭据被转发到其他主机。';
    case 'response':
      return '请求已到达服务方，但响应不符合预期；检查 API 类型与地址。';
    case 'canceled':
      return '测试已被取消。';
    case 'config':
      return '检查模型 ID、地址或凭据配置。';
    default:
      return '检查网络、代理与服务方状态。';
  }
}

/* ---------------------------- 对话框 ---------------------------- */

function openImportDialog(): void {
  openDialog({
    kind: 'import',
    step: 'input',
    text: '',
    busy: false,
    fingerprint: state.snapshot?.fingerprint ?? '',
  });
}

function openExportDialog(): void {
  openDialog({ kind: 'export', json: '', busy: true });
  send('config/export', { copy: false }, 'export');
}

function renderDialog(dialog: DialogState): HTMLElement {
  const busy = dialog.kind !== 'discard' && dialog.busy;
  const overlay = el('div', { class: 'overlay' });
  const box = el('div', {
    class: 'dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'dialog-title',
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && !busy) {
      closeDialog();
    }
  });

  if (dialog.kind === 'discard') {
    box.append(el('h2', { id: 'dialog-title' }, '放弃未保存的修改？'));
    box.append(el('div', { class: 'hint' }, dialog.message));
    const actions = el('div', { class: 'dialog-actions' });
    const keepEditing = button('继续编辑', () => closeDialog(), {});
    keepEditing.setAttribute('data-autofocus', 'true');
    actions.append(
      keepEditing,
      button('放弃修改', () => {
        const action = dialog.onConfirm;
        closeDialog();
        action();
      }, { class: 'primary' }),
    );
    box.append(actions);
    overlay.append(box);
    return overlay;
  }

  if (dialog.kind === 'export') {
    box.append(el('h2', { id: 'dialog-title' }, '导出模型配置（不含 API Key）'));
    box.append(
      el('div', { class: 'hint' }, '导出内容使用字段白名单，不包含凭据、settings 或面板未识别的字段。'),
    );
    if (dialog.busy) {
      box.append(el('div', { class: 'loading', role: 'status' }, '正在生成导出内容…'));
    } else {
      const pre = el('pre', { class: 'json' });
      pre.textContent = dialog.json;
      box.append(pre);
    }
    const actions = el('div', { class: 'dialog-actions' });
    const saveButton = button('保存到文件…', () => {
      if (state.dialog?.kind === 'export') {
        state.dialog.busy = true;
        render();
      }
      send('config/exportSave', { json: dialog.json }, 'exportSave');
    }, { class: 'primary', disabled: dialog.busy });
    saveButton.setAttribute('data-autofocus', 'true');
    actions.append(
      button('关闭', () => closeDialog(), { disabled: dialog.busy }),
      button('复制到剪贴板', () => {
        if (state.dialog?.kind === 'export') {
          state.dialog.busy = true;
          render();
        }
        send('config/export', { copy: true }, 'exportCopy');
      }, { disabled: dialog.busy }),
      saveButton,
    );
    box.append(actions);
    overlay.append(box);
    return overlay;
  }

  if (dialog.step === 'input') {
    box.append(el('h2', { id: 'dialog-title' }, '导入模型分组'));
    box.append(
      el(
        'div',
        { class: 'hint' },
        '粘贴此前导出的 JSON 数组或单个分组对象。只接受 customendpoint / customoai 分组；导入不会恢复 API Key，也不会覆盖其他提供方。',
      ),
    );
    if (dialog.error) {
      box.append(banner('error', '无法导入', dialog.error));
    }
    const textarea = document.createElement('textarea');
    textarea.className = 'json-input';
    textarea.value = dialog.text;
    textarea.placeholder = '[{ "name": "...", "vendor": "customendpoint", "models": [...] }]';
    textarea.setAttribute('aria-label', '导入 JSON 内容');
    textarea.setAttribute('data-autofocus', 'true');
    textarea.addEventListener('input', () => {
      const current = state.dialog;
      if (current?.kind === 'import' && current.step === 'input') {
        current.text = textarea.value;
      }
      const parseButton = document.getElementById('import-parse') as HTMLButtonElement | null;
      if (parseButton) {
        parseButton.disabled = !textarea.value.trim();
      }
    });
    box.append(textarea);

    const actions = el('div', { class: 'dialog-actions' });
    const parseButton = button('解析预览', () => {
      const text = textarea.value.trim();
      if (!text) {
        showToast('warn', '请先粘贴 JSON 内容。');
        return;
      }
      const current = state.dialog;
      if (current?.kind !== 'import') {
        return;
      }
      const fingerprint = state.snapshot?.fingerprint ?? current.fingerprint;
      state.dialog = { kind: 'import', step: 'input', text, busy: true, fingerprint };
      render();
      send('config/import', { json: text }, 'import', { text });
    }, { class: 'primary', disabled: dialog.busy || !dialog.text.trim() });
    parseButton.id = 'import-parse';
    actions.append(
      button('取消', () => closeDialog(), { disabled: dialog.busy }),
      parseButton,
    );
    box.append(actions);
    overlay.append(box);
    return overlay;
  }

  box.append(el('h2', { id: 'dialog-title' }, '确认导入'));
  if (dialog.error) {
    box.append(banner('error', '导入失败', dialog.error));
  }
  box.append(
    el(
      'div',
      { class: 'hint' },
      `共 ${dialog.preview.totalModels} 个模型。同名分组会被文件中的模型列表替换，但保留原有凭据引用。`,
    ),
  );
  if (dialog.preview.strippedCredentials) {
    box.append(
      banner('warn', '凭据已移除', '导入内容包含 API Key，已主动移除；导入后请为相关分组重新设置。'),
    );
  }
  if (!dialog.preview.canApply) {
    box.append(
      banner('error', '无法导入', '导入内容包含未通过校验的模型，请返回修改 JSON 后重新解析。'),
    );
  }
  for (const group of dialog.preview.groups) {
    const card = el('div', { class: 'preview-group' });
    const head = el('div', { class: 'preview-head' });
    head.append(
      el('strong', {}, group.name),
      el('span', { class: 'badge' }, group.vendor),
      el('span', { class: 'badge' }, `${group.modelIds.length} 个模型`),
    );
    if (group.conflict) {
      head.append(el('span', { class: 'badge warn' }, '将覆盖同名分组'));
    }
    card.append(head);
    if (group.modelIds.length > 0) {
      card.append(el('div', { class: 'hint' }, group.modelIds.join('、')));
    }
    const errors = group.issues.filter((issue) => issue.severity !== 'warning');
    if (errors.length > 0) {
      const list = el('ul', {});
      for (const issue of errors) {
        list.append(el('li', { class: 'field-error' }, issue.message));
      }
      card.append(list);
    }
    box.append(card);
  }

  const actions = el('div', { class: 'dialog-actions' });
  const applyButton = button('确认导入', () => {
    const snapshot = state.snapshot;
    if (!snapshot) {
      return;
    }
    const current = state.dialog;
    if (current?.kind !== 'import') {
      return;
    }
    state.dialog = { ...current, busy: true };
    render();
    send(
      'config/importApply',
      { json: current.text, expectedFingerprint: current.fingerprint },
      'importApply',
    );
  }, { class: 'primary', disabled: dialog.busy || !dialog.preview.canApply });
  applyButton.setAttribute('data-autofocus', 'true');
  actions.append(
    button('取消导入', () => closeDialog(), {}),
    button('返回修改', () => {
      const current = state.dialog;
      if (current?.kind === 'import') {
        state.dialog = {
          kind: 'import',
          step: 'input',
          text: current.text,
          busy: false,
          fingerprint: current.fingerprint,
        };
        render();
      }
    }, {}),
    applyButton,
  );
  box.append(actions);
  overlay.append(box);
  return overlay;
}

function openDialog(dialog: DialogState): void {
  focusBeforeDialog =
    document.activeElement instanceof HTMLElement && document.activeElement.id
      ? document.activeElement.id
      : undefined;
  state.dialog = dialog;
  render();
}

function closeDialog(): void {
  state.dialog = undefined;
  render();
  if (focusBeforeDialog) {
    const target = document.getElementById(focusBeforeDialog);
    if (target instanceof HTMLElement) {
      target.focus();
    }
    focusBeforeDialog = undefined;
  }
}

function focusDialog(): void {
  const dialog = document.querySelector<HTMLElement>('.dialog');
  if (!dialog) {
    return;
  }
  const candidates = dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), textarea, input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
  );
  const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
  const target = preferred ?? candidates.item(0) ?? dialog;
  target.focus();
}

/* ------------------------------------------------------------------ */
/* 操作                                                                */
/* ------------------------------------------------------------------ */

function startCreateInGroup(group: ProviderGroup): void {
  const draft = createEmptyDraft(group.vendor, group.name);
  withDiscardGuard(() => {
    state.form = createForm('create', draft, {
      groupMode: 'existing',
      nameTouched: false,
      inputTouched: false,
    });
    state.selection = { kind: 'group', group: { vendor: group.vendor, groupName: group.name } };
    state.lastError = undefined;
    render();
    focusField('id');
  });
}

function deleteModel(ref: ModelRef, label: string): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  send('config/delete', { ref, expectedFingerprint: snapshot.fingerprint }, 'delete', { ref, label });
}

function deleteGroup(group: ProviderGroup): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  send(
    'config/deleteGroup',
    { group: { vendor: group.vendor, groupName: group.name }, expectedFingerprint: snapshot.fingerprint },
    'deleteGroup',
    { group: { vendor: group.vendor, groupName: group.name } },
  );
}

function promptGroupKey(group: ProviderGroup): void {
  send('group/promptApiKey', { group: { vendor: group.vendor, groupName: group.name } }, 'groupKey', {
    group: { vendor: group.vendor, groupName: group.name },
  });
}

function clearGroupKey(group: ProviderGroup): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  send(
    'group/clearApiKey',
    { group: { vendor: group.vendor, groupName: group.name }, expectedFingerprint: snapshot.fingerprint },
    'clearKey',
    { group: { vendor: group.vendor, groupName: group.name } },
  );
}

function importLegacy(): void {
  const snapshot = state.snapshot;
  if (!snapshot || snapshot.legacyModels.length === 0) {
    showToast('info', '旧版设置中没有可导入的模型。');
    return;
  }
  send('legacy/import', { expectedFingerprint: snapshot.fingerprint }, 'legacy');
}

/* ------------------------------------------------------------------ */
/* 焦点、通知与基础组件                                                */
/* ------------------------------------------------------------------ */

interface FocusSnapshot {
  id: string;
  start: number | null;
  end: number | null;
}

function captureFocus(): FocusSnapshot | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.id) {
    return undefined;
  }
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement || active instanceof HTMLButtonElement)) {
    return undefined;
  }
  const selectionStart =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  const selectionEnd =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null;
  return { id: active.id, start: selectionStart, end: selectionEnd };
}

function restoreFocus(snapshot: FocusSnapshot | undefined): void {
  if (!snapshot) {
    return;
  }
  const target = document.getElementById(snapshot.id);
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.focus({ preventScroll: true });
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const length = target.value.length;
    const start = Math.min(snapshot.start ?? length, length);
    const end = Math.min(snapshot.end ?? length, length);
    try {
      target.setSelectionRange(start, end);
    } catch {
      // number 类型输入不支持设置选区，忽略即可。
    }
  }
}

function showToast(level: 'info' | 'warn' | 'error', message: string, duration = 4600): void {
  const toast = el('div', {
    class: `toast${level === 'info' ? '' : ` ${level}`}`,
    role: level === 'error' ? 'alert' : 'status',
  }, message);
  toastRegion.append(toast);
  if (duration > 0) {
    setTimeout(() => toast.remove(), duration);
  }
}

function banner(level: 'info' | 'warn' | 'error', title: string, detail: string): HTMLElement {
  const element = el('div', { class: `banner${level === 'info' ? '' : ` ${level}`}` });
  element.append(el('strong', {}, title), document.createTextNode(detail));
  return element;
}

function field(
  labelText: string,
  name: string,
  control: HTMLElement,
  hint?: string,
  errorKey?: string,
  hintId?: string,
): HTMLElement {
  const wrapper = el('div', { class: 'field' });
  const id = `field-${name}`;
  control.id = id;
  const key = errorKey ?? name;
  control.setAttribute('data-field-key', key);
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  wrapper.append(label, control);

  const messages = el('div', { class: 'field-messages', id: `msgs-${name}` });
  const issues = state.form
    ? visibleIssues(state.form).filter((issue) => issue.field === key)
    : [];
  for (const issue of issues) {
    messages.append(issueNode(issue));
  }
  wrapper.append(messages);

  if (hint) {
    const hintNode = el('div', { class: 'hint', id: hintId ?? `hint-${name}` }, hint);
    wrapper.append(hintNode);
    control.setAttribute('aria-describedby', `${hintNode.id} ${messages.id}`);
  } else {
    control.setAttribute('aria-describedby', messages.id);
  }
  return wrapper;
}

function input(
  type: string,
  value: string,
  onChange: (value: string) => void,
  options: {
    placeholder?: string;
    required?: boolean;
    spellcheck?: string;
    list?: string;
    autocomplete?: string;
    readonly?: string;
  } = {},
): HTMLInputElement {
  const element = document.createElement('input');
  element.type = type;
  element.value = value;
  if (options.placeholder) {
    element.placeholder = options.placeholder;
  }
  if (options.required) {
    element.required = true;
  }
  if (options.spellcheck) {
    element.setAttribute('spellcheck', options.spellcheck);
  }
  if (options.list) {
    element.setAttribute('list', options.list);
  }
  if (options.autocomplete) {
    element.setAttribute('autocomplete', options.autocomplete);
  }
  if (options.readonly) {
    element.readOnly = true;
  }
  element.addEventListener('input', () => onChange(element.value));
  return element;
}

function numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
  const element = document.createElement('input');
  element.type = 'text';
  element.inputMode = 'numeric';
  element.setAttribute('pattern', '[0-9]*');
  element.value = Number.isFinite(value) ? String(value) : '';
  element.addEventListener('input', () => {
    const raw = element.value.trim();
    onChange(raw === '' ? Number.NaN : Number(raw));
  });
  return element;
}

function select(
  options: readonly [string, string][],
  value: string,
  onChange: (value: string) => void,
  ariaLabel?: string,
): HTMLSelectElement {
  const element = document.createElement('select');
  if (ariaLabel) {
    element.setAttribute('aria-label', ariaLabel);
  }
  for (const [optionValue, label] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    option.selected = optionValue === value;
    element.append(option);
  }
  element.addEventListener('change', () => onChange(element.value));
  return element;
}

function check(
  labelText: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  detail?: string,
): HTMLElement {
  const wrapper = el('label', { class: 'check' });
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  const text = el('span', { class: 'text' }, labelText);
  if (detail) {
    text.append(el('small', {}, detail));
  }
  wrapper.append(box, text);
  return wrapper;
}

function radio(
  name: string,
  value: string,
  checked: boolean,
  onChange: () => void,
  labelText: string,
  detail?: string,
  disabled = false,
): HTMLElement {
  const wrapper = el('label', { class: 'radio-row' });
  const box = document.createElement('input');
  box.type = 'radio';
  box.name = name;
  box.value = value;
  box.checked = checked;
  box.disabled = disabled;
  box.addEventListener('change', () => onChange());
  const text = el('span', { class: 'radio-text' }, labelText);
  if (detail) {
    text.append(el('small', {}, detail));
  }
  wrapper.append(box, text);
  return wrapper;
}

function button(
  label: string,
  onClick: () => void,
  options: {
    class?: string;
    disabled?: boolean;
    type?: string;
    'aria-label'?: string;
    title?: string;
  } = {},
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = options.type === 'submit' ? 'submit' : 'button';
  element.textContent = label;
  if (options.class) {
    element.className = options.class;
  }
  if (options.disabled) {
    element.disabled = true;
  }
  if (options['aria-label']) {
    element.setAttribute('aria-label', options['aria-label']);
  }
  if (options.title) {
    element.title = options.title;
  }
  element.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return element;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      element.setAttribute(key, value);
    }
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function backButton(): HTMLElement {
  return button('← 返回列表', () => closeForm(), { class: 'link back-button' });
}

function groupKey(vendor: VendorId, name: string): string {
  return `${vendor}\u0000${name}`;
}

function uniqueGroupName(vendor: VendorId, base: string): string {
  const trimmed = base.trim();
  const preferred = trimmed.length > 0 ? trimmed : 'My Provider';
  if (!findGroup(vendor, preferred)) {
    return preferred;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${preferred} ${index}`;
    if (!findGroup(vendor, candidate)) {
      return candidate;
    }
  }
  return `${preferred} ${Date.now()}`;
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.vendor === b.vendor && a.groupName === b.groupName && a.id === b.id;
}

function apiTypeLabel(apiType: ModelDraft['apiType']): string {
  if (apiType === 'responses') {
    return 'Responses';
  }
  if (apiType === 'messages') {
    return 'Messages';
  }
  return 'Chat Completions';
}

function sourceLabel(snapshot: ConfigSnapshot | undefined): string {
  switch (snapshot?.source) {
    case 'settings-legacy':
      return '旧版设置（只读）';
    case 'settings-empty':
      return '空配置';
    default:
      return 'chatLanguageModels.json';
  }
}

/* ------------------------------------------------------------------ */
/* 全局事件                                                            */
/* ------------------------------------------------------------------ */

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.dialog && (state.dialog.kind === 'discard' || !state.dialog.busy)) {
      closeDialog();
      return;
    }
    const menu = document.querySelector<HTMLDetailsElement>('details.more-menu[open]');
    if (menu) {
      menu.open = false;
    }
  }
  if (state.dialog && event.key === 'Tab') {
    const dialog = document.querySelector<HTMLElement>('.dialog');
    if (!dialog) {
      return;
    }
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea, input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => node.offsetParent !== null);
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    if (state.form) {
      event.preventDefault();
      saveForm();
    }
  }
});

document.addEventListener('click', (event) => {
  const menu = document.querySelector<HTMLDetailsElement>('details.more-menu[open]');
  if (menu && event.target instanceof Node && !menu.contains(event.target)) {
    menu.open = false;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.form?.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

render();
send('config/list', {}, 'list');
