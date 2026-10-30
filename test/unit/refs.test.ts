import assert from 'node:assert/strict';
import test from 'node:test';
import { groupRefOf, modelRefOf } from '../../src/models/refs.ts';

const ref = { vendor: 'customendpoint', groupName: 'New-API', id: 'glm-5.3-反代' } as const;

test('模型 ref 原样返回', () => {
  assert.deepEqual(modelRefOf({ ...ref }), { ...ref });
});

test('完整模型记录可解析', () => {
  assert.deepEqual(
    modelRefOf({
      ...ref,
      name: 'GLM',
      url: 'https://api.example.com/v1/chat/completions',
      raw: { id: ref.id },
    }),
    { ...ref },
  );
});

test('树元素的 ref 与 model 字段可解析', () => {
  assert.deepEqual(modelRefOf({ ref: { ...ref } }), { ...ref });
  assert.deepEqual(modelRefOf({ model: { ...ref } }), { ...ref });
});

test('模型 ref 首尾空白会被裁剪', () => {
  assert.deepEqual(modelRefOf({ ...ref, groupName: ' New-API ', id: ' glm-5.3-反代 ' }), { ...ref });
});

test('模型未知提供方或缺失字段返回 undefined', () => {
  assert.equal(modelRefOf({ ...ref, vendor: 'openai' }), undefined);
  assert.equal(modelRefOf({ vendor: 'customendpoint', groupName: 'G' }), undefined);
  assert.equal(modelRefOf({ vendor: 'customendpoint', id: 'm' }), undefined);
});

test('分组 ref 与分组树元素可解析', () => {
  assert.deepEqual(groupRefOf({ vendor: 'customendpoint', groupName: 'New-API' }), {
    vendor: 'customendpoint',
    groupName: 'New-API',
  });
  assert.deepEqual(groupRefOf({ group: { vendor: 'customendpoint', name: 'New-API', models: [] } }), {
    vendor: 'customendpoint',
    groupName: 'New-API',
  });
});

test('带模型 id 的对象不会被当作分组', () => {
  assert.equal(groupRefOf({ ...ref }), undefined);
});

test('非对象与未知提供方返回 undefined', () => {
  assert.equal(modelRefOf(undefined), undefined);
  assert.equal(modelRefOf('model:customendpoint:G:m'), undefined);
  assert.equal(groupRefOf({ vendor: 'openai', name: 'G' }), undefined);
});
