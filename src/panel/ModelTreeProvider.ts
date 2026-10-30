import * as vscode from 'vscode';
import type {
  ConfigSnapshot,
  GroupRef,
  ModelRecord,
  ModelRef,
  ProviderGroup,
  VendorId,
} from '../models/modelConfig.ts';
import { LEGACY_GROUP_NAME, VENDOR_LABELS } from '../models/modelConfig.ts';
import { formatTokenCount } from '../models/draft.ts';

export type ModelTreeItem = GroupTreeItem | ModelTreeLeaf | LegacyTreeItem;

export class GroupTreeItem extends vscode.TreeItem {
  readonly group: ProviderGroup;
  readonly ref: GroupRef;

  constructor(group: ProviderGroup) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);
    this.group = group;
    this.ref = { vendor: group.vendor, groupName: group.name };
    this.id = `group:${group.vendor}:${group.name}`;
    this.contextValue = 'copilotModels.group';
    const vendorLabel = VENDOR_LABELS[group.vendor as VendorId] ?? group.vendor;
    this.description = `${vendorLabel} · ${group.models.length} 个模型${group.hasApiKey ? '' : ' · 无凭据'}`;
    this.tooltip = [
      group.name,
      `提供方：${vendorLabel}`,
      `凭据：${group.hasApiKey ? '已保存' : '未保存'}`,
      `模型：${group.models.length} 个`,
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon(group.hasApiKey ? 'folder-library' : 'warning');
    this.command = {
      command: 'copilotModels.openGroup',
      title: '打开分组设置',
      arguments: [this.ref],
    };
  }
}

export class ModelTreeLeaf extends vscode.TreeItem {
  readonly model: ModelRecord;
  readonly ref: ModelRef;

  constructor(model: ModelRecord) {
    super(model.name || model.id, vscode.TreeItemCollapsibleState.None);
    this.model = model;
    this.ref = { vendor: model.vendor, groupName: model.groupName, id: model.id };
    this.id = `model:${model.vendor}:${model.groupName}:${model.id}`;
    this.contextValue = 'copilotModels.model';
    this.description = `${formatTokenCount(model.contextWindow)} · ${model.apiType}`;
    const flags = [
      model.vision ? '视觉' : '文本',
      model.toolCalling ? '工具调用' : '无工具调用',
      model.thinking ? `思考 ${model.supportsReasoningEffort.join('/') || '默认'}` : '无思考',
      model.streaming ? '流式' : '非流式',
    ];
    this.tooltip = [
      model.name,
      `模型 ID：${model.id}`,
      `上下文：${model.contextWindow.toLocaleString()}（输入 ${model.maxInputTokens.toLocaleString()} / 输出 ${model.maxOutputTokens.toLocaleString()}）`,
      `能力：${flags.join(' · ')}`,
      `接口：${model.url}`,
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon(model.vision ? 'eye' : 'symbol-method');
    // 内联按钮（view/item/context）拿到的实参是树元素本身，两个入口都只传 ref。
    this.command = {
      command: 'copilotModels.openModel',
      title: '编辑模型',
      arguments: [this.ref],
    };
  }
}

export class LegacyTreeItem extends vscode.TreeItem {
  constructor(count: number) {
    super(LEGACY_GROUP_NAME, vscode.TreeItemCollapsibleState.None);
    this.id = 'legacy:customOAIModels';
    this.contextValue = 'copilotModels.legacy';
    this.description = `${count} 个模型（只读）`;
    this.tooltip = '旧版 github.copilot.chat.customOAIModels 中的模型。导入到面板不会删除旧设置。';
    this.iconPath = new vscode.ThemeIcon('warning');
    this.command = {
      command: 'copilotModels.importLegacy',
      title: '导入旧版设置',
    };
  }
}

export class ModelTreeProvider implements vscode.TreeDataProvider<ModelTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ModelTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private snapshot: ConfigSnapshot | undefined;

  update(snapshot: ConfigSnapshot | undefined): void {
    this.snapshot = snapshot;
    this.emitter.fire(undefined);
  }

  getChildren(element?: ModelTreeItem): ModelTreeItem[] {
    if (!element) {
      const items: ModelTreeItem[] = (this.snapshot?.groups ?? []).map((group) => new GroupTreeItem(group));
      if ((this.snapshot?.legacyModels.length ?? 0) > 0) {
        items.push(new LegacyTreeItem(this.snapshot?.legacyModels.length ?? 0));
      }
      return items;
    }
    if (element instanceof GroupTreeItem) {
      return element.group.models.map((model) => new ModelTreeLeaf(model));
    }
    return [];
  }

  getTreeItem(element: ModelTreeItem): vscode.TreeItem {
    return element;
  }
}

export function describeEmptyState(snapshot: ConfigSnapshot | undefined): string {
  if (!snapshot) {
    return '正在读取配置…';
  }
  if (snapshot.groups.length === 0) {
    return snapshot.legacyModels.length > 0 ? '仅有旧版设置，可导入面板' : '还没有模型，点击标题栏 + 添加';
  }
  return `${snapshot.groups.length} 个分组`;
}
