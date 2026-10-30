import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
// @vscode/test-electron 在非 reuseMachineInstall 模式下固定使用该目录。
const userDataDir = path.join(projectRoot, '.vscode-test', 'user-data');
const workspaceDir = path.join(projectRoot, '.vscode-test', 'workspace');

async function main() {
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.mkdir(path.join(userDataDir, 'User'), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const fixture = [
    {
      name: 'KeepMe',
      vendor: 'openai',
      apiKey: '${input:chat.lm.secret.keep}',
      models: [{ id: 'keep', name: 'Keep' }],
    },
    {
      name: 'ProbeGroup',
      vendor: 'customendpoint',
      apiKey: '${input:chat.lm.secret.old}',
      apiType: 'chat-completions',
      models: [
        {
          id: 'existing',
          name: 'Existing',
          url: 'http://127.0.0.1:9/v1/chat/completions',
          toolCalling: true,
          vision: false,
          maxInputTokens: 900,
          maxOutputTokens: 100,
        },
      ],
    },
  ];
  await fs.writeFile(path.join(userDataDir, 'User', 'chatLanguageModels.json'), `${JSON.stringify(fixture, null, '\t')}\n`);

  const options = {
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: path.resolve(here, 'suite', 'index.mjs'),
    launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspaceDir],
    extensionTestsEnv: {
      CMC_USER_DATA: userDataDir,
    },
  };
  const executable = process.env.VSCODE_EXECUTABLE;
  if (executable) {
    options.vscodeExecutablePath = executable;
  }
  await runTests(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
