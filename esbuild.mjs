import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';

const watchMode = process.argv.includes('--watch');

const WEBVIEW_ASSETS = [
  ['src/webview/index.html', 'dist/webview/index.html'],
  ['src/webview/styles.css', 'dist/webview/styles.css'],
];

async function copyWebviewAssets() {
  await mkdir(path.join('dist', 'webview'), { recursive: true });
  await Promise.all(WEBVIEW_ASSETS.map(([from, to]) => copyFile(from, to)));
}

const copyAssetsPlugin = {
  name: 'copy-webview-assets',
  setup(buildApi) {
    buildApi.onEnd(async (result) => {
      if (result.errors.length === 0) {
        await copyWebviewAssets();
      }
    });
  },
};

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  minify: false,
};

const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const webview = {
  ...shared,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  plugins: [copyAssetsPlugin],
};

if (watchMode) {
  const extensionContext = await context(extension);
  const webviewContext = await context(webview);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);

  let timer;
  watch('src/webview', { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void copyWebviewAssets().catch((error) => console.error('复制 Webview 资源失败', error));
    }, 60);
  });
  console.log('Watching extension, webview and assets...');
} else {
  await Promise.all([build(extension), build(webview)]);
}
