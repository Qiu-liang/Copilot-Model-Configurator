import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MessageController, type ControllerHost } from './MessageController.ts';
import type { ExtensionMessage } from './protocol.ts';
import type { ModelConfigService } from '../services/ModelConfigService.ts';
import type { GroupRef, ModelRef } from '../models/modelConfig.ts';

const VIEW_TYPE = 'copilotModels.panel';
const TITLE = 'Copilot 模型管理';

export type PanelMode = 'open' | 'add' | 'add-group' | 'copy';

export interface PanelContext {
  service: ModelConfigService;
  log: vscode.LogOutputChannel;
  onDidChange: vscode.Event<void>;
}

interface PanelTarget {
  ref?: ModelRef;
  group?: GroupRef;
}

export class ModelPanel {
  private static current: ModelPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    context: PanelContext,
    mode: PanelMode = 'open',
    target: PanelTarget = {},
  ): void {
    if (ModelPanel.current) {
      ModelPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ModelPanel.current.requestAction(mode, target);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    ModelPanel.current = new ModelPanel(panel, extensionUri, context, mode, target);
  }

  static disposeCurrent(): void {
    ModelPanel.current?.dispose();
    ModelPanel.current = undefined;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly context: PanelContext;
  private readonly controller: MessageController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly nonce = createNonce();
  private readonly queue: ExtensionMessage[] = [];
  private webviewReady = false;
  private disposed = false;
  private initialMode: PanelMode;
  private initialTarget: PanelTarget;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    context: PanelContext,
    mode: PanelMode,
    target: PanelTarget,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.context = context;
    this.initialMode = mode;
    this.initialTarget = target;

    const host: ControllerHost = {
      post: (message) => this.post(message),
      pushState: () => this.pushState(),
      setDirty: (dirty) => {
        this.panel.title = dirty ? `● ${TITLE}` : TITLE;
      },
      onWebviewReady: () => {
        this.webviewReady = true;
        void this.flush();
      },
      log: context.log,
    };
    this.controller = new MessageController(host, context.service);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    };
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.onMessage(message),
      undefined,
      this.disposables,
    );
    context.onDidChange(() => void this.pushState(), undefined, this.disposables);

    void this.initializeHtml();
  }

  private async initializeHtml(): Promise<void> {
    let html: string;
    try {
      html = await this.renderHtml();
    } catch (error) {
      this.context.log.error(`加载 Webview 模板失败：${error instanceof Error ? error.message : String(error)}`);
      html = this.fallbackHtml();
    }
    if (!this.disposed) {
      this.panel.webview.html = html;
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.controller.handle(raw);
    } catch (error) {
      this.context.log.warn(`消息处理失败：${error instanceof Error ? error.name : 'Unknown'}`);
    }
  }

  private async flush(): Promise<void> {
    const queued = this.queue.splice(0, this.queue.length);
    for (const message of queued) {
      await this.panel.webview.postMessage(message);
    }
    const mode = this.initialMode;
    const target = this.initialTarget;
    this.initialMode = 'open';
    this.initialTarget = {};
    if (mode === 'add') {
      await this.post({ type: 'start-create', payload: {} });
    } else if (mode === 'add-group') {
      await this.post({ type: 'start-create-group', payload: {} });
    } else if (mode === 'copy' && target.ref) {
      await this.post({ type: 'start-copy', payload: { ref: target.ref } });
    } else if (target.group) {
      await this.post({ type: 'select', payload: { group: target.group } });
    } else if (target.ref) {
      await this.post({ type: 'select', payload: { ref: target.ref } });
    }
  }

  private requestAction(mode: PanelMode, target: PanelTarget): void {
    if (!this.webviewReady) {
      this.initialMode = mode;
      this.initialTarget = target;
      return;
    }
    if (mode === 'add') {
      void this.post({ type: 'start-create', payload: {} });
    } else if (mode === 'add-group') {
      void this.post({ type: 'start-create-group', payload: {} });
    } else if (mode === 'copy' && target.ref) {
      void this.post({ type: 'start-copy', payload: { ref: target.ref } });
    } else if (target.group) {
      void this.post({ type: 'select', payload: { group: target.group } });
    } else if (target.ref) {
      void this.post({ type: 'select', payload: { ref: target.ref } });
    }
  }

  private async pushState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let snapshot = this.context.service.currentSnapshot;
    if (!snapshot) {
      snapshot = await this.context.service.reload();
    }
    await this.post({ type: 'state', payload: { snapshot } });
  }

  private async post(message: ExtensionMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.webviewReady) {
      this.queue.push(message);
      return;
    }
    await this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ModelPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async renderHtml(): Promise<string> {
    const templatePath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'index.html');
    const template = await fs.readFile(templatePath, 'utf8');
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css'),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource}`,
      `script-src 'nonce-${this.nonce}'`,
      `img-src ${this.panel.webview.cspSource} data:`,
      `font-src ${this.panel.webview.cspSource}`,
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    return template
      .split('{{csp}}')
      .join(csp)
      .split('{{nonce}}')
      .join(this.nonce)
      .split('{{scriptUri}}')
      .join(scriptUri.toString())
      .split('{{styleUri}}')
      .join(styleUri.toString());
  }

  private fallbackHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css'),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource}`,
      `script-src 'nonce-${this.nonce}'`,
      "connect-src 'none'",
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>${TITLE}</title>
</head>
<body>
<div id="app" aria-busy="true"><div class="loading" role="status">正在读取 Copilot 模型配置…</div></div>
<script nonce="${this.nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(24);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(bytes).toString('base64url');
}
