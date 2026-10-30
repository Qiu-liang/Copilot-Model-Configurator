import { isVendorId } from './draft.ts';
import type { GroupRef, ModelRef } from './modelConfig.ts';

/**
 * 树命令的实参有两种来源：`TreeItem.command.arguments`（显式 ref）和
 * `view/item/context` 内联按钮（VS Code 注入树元素实例）。两者都必须归一化成 ref。
 */
const MAX_DEPTH = 4;
const NESTED_KEYS = ['ref', 'model', 'group'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function* candidates(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (!isRecord(value) || depth > MAX_DEPTH) {
    return;
  }
  yield value;
  for (const key of NESTED_KEYS) {
    if (key in value) {
      yield* candidates(value[key], depth + 1);
    }
  }
}

function asModelRef(value: Record<string, unknown>): ModelRef | undefined {
  const vendor = value['vendor'];
  const groupName = nonEmptyString(value['groupName']);
  const id = nonEmptyString(value['id']);
  if (!isVendorId(vendor) || !groupName || !id) {
    return undefined;
  }
  return { vendor, groupName, id };
}

function asGroupRef(value: Record<string, unknown>): GroupRef | undefined {
  const vendor = value['vendor'];
  if (!isVendorId(vendor)) {
    return undefined;
  }
  // 带 id 的是模型（ModelRef / ModelRecord），不能当作分组，否则模型条目会被误判。
  if (nonEmptyString(value['id'])) {
    return undefined;
  }
  // ProviderGroup 用 name 表示分组名；TreeItem 没有 name 字段，不会误命中。
  const groupName = nonEmptyString(value['groupName']) ?? nonEmptyString(value['name']);
  return groupName ? { vendor, groupName } : undefined;
}

/** 接受 ModelRef、ModelRecord、树元素（{ ref } / { model } / { group }）等形态。 */
export function modelRefOf(value: unknown): ModelRef | undefined {
  for (const candidate of candidates(value)) {
    const ref = asModelRef(candidate);
    if (ref) {
      return ref;
    }
  }
  return undefined;
}

/** 接受 GroupRef、ProviderGroup、树元素（{ ref } / { group }）等形态。 */
export function groupRefOf(value: unknown): GroupRef | undefined {
  for (const candidate of candidates(value)) {
    const ref = asGroupRef(candidate);
    if (ref) {
      return ref;
    }
  }
  return undefined;
}
