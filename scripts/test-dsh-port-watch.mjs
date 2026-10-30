// DSH 端口守护（src/dsh-port.js → planDshPortMove）的离线单测。
// 不连 DSH、不连 QQ、不写任何文件：probe/discover 都是注入的假函数。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planDshPortMove } from '../src/dsh-port.js';

test('探得通就 stay，并把 misses 归零', async () => {
  const plan = await planDshPortMove({
    current: 'http://127.0.0.1:1371',
    misses: 3,
    probe: async () => true,
    discover: async () => 'http://127.0.0.1:9999'
  });
  assert.equal(plan.action, 'stay');
  assert.equal(plan.misses, 0);
});

test('第一次探不通只等一轮，不急着换地址', async () => {
  let discovered = 0;
  const plan = await planDshPortMove({
    current: 'http://127.0.0.1:1371',
    misses: 0,
    probe: async () => false,
    discover: async () => {
      discovered += 1;
      return 'http://127.0.0.1:9999';
    }
  });
  assert.equal(plan.action, 'wait');
  assert.equal(plan.misses, 1);
  assert.equal(discovered, 0, '只有连续两轮失败才去发现新端口');
});

test('连续两轮探不通就换到发现到的地址', async () => {
  const plan = await planDshPortMove({
    current: 'http://127.0.0.1:4385',
    misses: 1,
    probe: async () => false,
    discover: async () => 'http://127.0.0.1:3899'
  });
  assert.equal(plan.action, 'move');
  assert.equal(plan.next, 'http://127.0.0.1:3899');
  assert.equal(plan.misses, 0);
});

test('发现到的地址和当前一样时继续等（别原地重连刷屏）', async () => {
  const plan = await planDshPortMove({
    current: 'http://127.0.0.1:3899/',
    misses: 1,
    probe: async () => false,
    discover: async () => 'http://127.0.0.1:3899'
  });
  assert.equal(plan.action, 'wait');
});

test('探不通又找不到 DSH 时报 lost，并保留累计轮数', async () => {
  const plan = await planDshPortMove({
    current: 'http://127.0.0.1:3899',
    misses: 1,
    probe: async () => false,
    discover: async () => null
  });
  assert.equal(plan.action, 'lost');
  assert.equal(plan.misses, 2);
});
