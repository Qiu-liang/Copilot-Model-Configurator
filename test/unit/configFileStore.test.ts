import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigFileStore, ConfigParseFailure, asMessage, isNotFound } from '../../src/adapters/ConfigFileStore.ts';
import type { RawGroup } from '../../src/models/configDocument.ts';

async function tempStore(): Promise<{ store: ConfigFileStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmc-test-'));
  return { store: new ConfigFileStore(path.join(dir, 'chatLanguageModels.json')), dir };
}

const sample = (): RawGroup[] => [
  { name: 'G', vendor: 'customendpoint', apiKey: '${input:chat.lm.secret.1}', models: [{ id: 'a' }] },
];

test('缺失文件返回空分组且不创建文件', async () => {
  const { store, dir } = await tempStore();
  const result = await store.read();
  assert.equal(result.exists, false);
  assert.deepEqual(result.groups, []);
  await assert.rejects(fs.access(path.join(dir, 'chatLanguageModels.json')), (error: unknown) => isNotFound(error));
});

test('写入后可读取且格式化稳定', async () => {
  const { store } = await tempStore();
  const result = await store.write(sample());
  assert.ok(result.bytesWritten > 0);
  const read = await store.read();
  assert.equal(read.exists, true);
  assert.equal(read.groups[0]?.name, 'G');
  assert.ok(read.text?.endsWith('\n'));
  assert.ok(read.text?.includes('\t"name"'));
});

test('写入不产生临时文件残留', async () => {
  const { store, dir } = await tempStore();
  await store.write(sample());
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['chatLanguageModels.json']);
});

test('空文件视为空配置', async () => {
  const { store, dir } = await tempStore();
  await fs.writeFile(path.join(dir, 'chatLanguageModels.json'), '   \n', 'utf8');
  const result = await store.read();
  assert.equal(result.exists, true);
  assert.deepEqual(result.groups, []);
});

test('损坏 JSON 抛出可读错误', async () => {
  const { store, dir } = await tempStore();
  await fs.writeFile(path.join(dir, 'chatLanguageModels.json'), '{ broken', 'utf8');
  await assert.rejects(store.read(), (error: unknown) => {
    assert.ok(error instanceof ConfigParseFailure);
    assert.ok(asMessage(error).includes('无法解析'));
    return true;
  });
});

test('结构非法的配置抛出错误', async () => {
  const { store, dir } = await tempStore();
  await fs.writeFile(path.join(dir, 'chatLanguageModels.json'), JSON.stringify([{ name: 'x' }]), 'utf8');
  await assert.rejects(store.read(), ConfigParseFailure);
});

test('备份按数量上限清理', async () => {
  const { store } = await tempStore();
  for (let index = 0; index < 4; index += 1) {
    await store.createBackup(JSON.stringify(sample()), 2);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const entries = await fs.readdir(store.backupDirectory());
  assert.equal(entries.length, 2);
});

test('keep 为 0 时不创建备份目录', async () => {
  const { store } = await tempStore();
  const result = await store.createBackup('[]', 0);
  assert.equal(result, undefined);
  await assert.rejects(fs.access(store.backupDirectory()));
});

test('fromGlobalStorage 推导用户目录', () => {
  const store = ConfigFileStore.fromGlobalStorage('/home/u/.config/Code/User/globalStorage/pub.ext');
  assert.equal(store.filePath, path.resolve('/home/u/.config/Code/User/chatLanguageModels.json'));
});

test('写入保留原始未知字段', async () => {
  const { store } = await tempStore();
  const groups = sample();
  groups[0]!['customGroupField'] = { nested: true };
  await store.write(groups);
  const read = await store.read();
  assert.deepEqual(read.groups[0]?.['customGroupField'], { nested: true });
});
