import * as vscode from 'vscode';
import { readLegacyModels, type LegacyModelInput } from '../models/configDocument.ts';
import { LEGACY_SETTING } from '../models/modelConfig.ts';

/**
 * 旧版 `github.copilot.chat.customOAIModels` 只读适配器。
 * 面板不会写旧设置，避免 Copilot 再次迁移时产生重复模型。
 */
export class LegacySettingsAdapter {
  static readonly settingKey = LEGACY_SETTING;

  read(): LegacyModelInput[] {
    try {
      return readLegacyModels(vscode.workspace.getConfiguration().get<unknown>(LEGACY_SETTING));
    } catch {
      return [];
    }
  }

  async openSetting(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', LEGACY_SETTING);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(LEGACY_SETTING)) {
        listener();
      }
    });
  }
}
