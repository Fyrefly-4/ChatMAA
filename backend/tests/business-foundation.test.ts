import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog, sealCatalog } from '../src/business/catalog.ts';
import { importCatalog } from '../src/business/catalog-import.ts';
import type { ImportInput } from '../src/business/catalog-import.ts';
import { amount, executionParams, goalDraft, goalResult, missingGoal, sumAmounts } from '../src/business/goals.ts';
import type { TaskView } from '../src/task-contract.ts';

const source = { url: 'https://example.org/fixture', revision: 'fixture', sha256: 'a'.repeat(64), fetchedAt: '2026-09-21T00:00:00Z' };
function input(): ImportInput {
  const stage = { stageId: 'main_fixture', code: '1-7', name: '测试', stageType: 'MAIN', difficulty: 'NORMAL',
    canBattleReplay: true, apCost: 6, stageDropInfo: { displayDetailRewards: [
      { id: 'rock', dropType: 'NORMAL' }, { id: 'gem', dropType: 'COMPLETE' }] } };
  return { gameStages: { stages: { main_fixture: stage } },
    gameItems: { items: { rock: { name: '材料', stageDropList: [{ stageId: 'main_fixture' }] }, gem: { name: '首次奖励' } } },
    maaItems: { rock: {}, gem: {} }, maaStages: [{ stageId: 'main_fixture', code: '1-7', apCost: 6,
      dropInfos: [{ itemId: 'rock', dropType: 'NORMAL_DROP' }, { itemId: 'gem', dropType: 'NORMAL_DROP' }] }],
    sources: { gameStages: source, gameItems: source, maaStages: source, maaItems: source, matrix: source },
    matrix: { matrix: [{ stageId: 'main_fixture', itemId: 'rock', quantity: 1250, times: 1000, start: 1, end: null }] } };
}
test('资料导入核对双源普通掉落，保留统计时点；首次奖励不作为材料执行依据', () => {
  const snapshot = importCatalog(input()); const catalog = new Catalog(snapshot);
  assert.deepEqual(snapshot.stages[0].drops, ['rock']);
  assert.equal(catalog.select(undefined, 'rock').code, '1-7');
  assert.equal(catalog.estimate('1-7', 20, 'rock').sanity, 96);
  assert.equal(catalog.estimate('1-7', 5).sanity, 30);
  assert.equal(snapshot.stages[0].samples.rock.end, null);
  assert.equal(snapshot.stages[0].samples.rock.asOf, source.fetchedAt);
  assert.throws(() => catalog.select('1-7', 'gem'));
  assert.equal(catalog.select('UNLISTED').entry, null);
  assert.equal(catalog.estimate('UNLISTED', 5).kind, 'unavailable');
});
test('资料不一致、统计重复或低样本时不伪造推荐与估算', () => {
  const data = input(); data.maaStages[0].apCost = 9;
  assert.equal(importCatalog(data).stages.length, 0);
  const duplicate = input(); duplicate.matrix!.matrix.push({ ...duplicate.matrix!.matrix[0] });
  assert.equal(new Catalog(importCatalog(duplicate)).estimate('1-7', 20, 'rock').kind, 'unavailable');
  const small = input(); small.matrix!.matrix[0].times = 2;
  assert.equal(Object.keys(importCatalog(small).stages[0].samples).length, 0);
  const ambiguous = input(); ambiguous.maaStages.push({ ...ambiguous.maaStages[0] });
  assert.equal(importCatalog(ambiguous).stages.length, 0);
});
test('快照内容篡改被拒绝；无关资料变化不改变当前方案依据指纹', () => {
  const snapshot = importCatalog(input()); const original = new Catalog(snapshot);
  assert.throws(() => new Catalog({ ...snapshot, items: {} }));
  const { version: _, ...data } = structuredClone(snapshot);
  data.items.other = { name: '另一个材料', recommendation: null };
  const newer = new Catalog(sealCatalog(data));
  assert.notEqual(newer.snapshot.version, original.snapshot.version);
  assert.equal(newer.basis('1-7', 'rock'), original.basis('1-7', 'rock'));
  data.stages[0].apCost = 7;
  assert.notEqual(new Catalog(sealCatalog(data)).basis('1-7', 'rock'), original.basis('1-7', 'rock'));
});
test('三种目标保留含义，拒绝隐含放宽和任意执行参数', () => {
  assert.deepEqual(missingGoal(goalDraft({ kind: 'inventory' })), ['quantity', 'itemId']);
  for (const invalid of [{ quantity: '5' }, { quantity: 0 }, { kind: 'count', itemId: 'rock' }, { medicine: 1 }, { kind: 'count', series: 2 }]) {
    assert.throws(() => goalDraft(invalid));
  }
  assert.deepEqual(executionParams({ kind: 'inventory', quantity: 100, itemId: 'rock' }, '1-7', 28),
    { version: 2, stage: '1-7', series: 1, medicine: 0, premium: 0, kind: 'fight_material', item_id: 'rock', quantity: 28 });
});
function task(): TaskView {
  return { id: 'one', seq: 2, state: 'ended', reason: 'normal', automation_stopped: true, device: 'ready',
    confirmed: 5, certainty: 'exact', started_cycles: 5, unsettled_cycles: 0, evidence_source: 'fixture',
    params: { version: 2, kind: 'fight_material', stage: '1-7', item_id: 'rock', quantity: 28, series: 1, medicine: 0, premium: 0 },
    count_result: { value: 5, certainty: 'exact', issues: [] }, material_result: { items: { rock: 29 }, certainty: 'exact', issues: [] },
    cursor: 2, gap: false, sync: { available: true, last_success_at: 1, reason: null } };
}
test('库存目标由初始观察和掉落核算；normal 不猜理智不足，掉落不混用次数', () => {
  const result = goalResult(task(), { kind: 'inventory', itemId: 'rock', quantity: 100 }, undefined, 72);
  assert.equal(result.estimatedInventory?.value, 101); assert.equal(result.target, 'achieved');
  assert.equal(result.process, 'unknown'); assert.equal(result.amount.value, 29); assert.equal(result.rescanned, false);
  assert.equal(goalResult(task(), { kind: 'count', quantity: 10 }).amount.value, 5);
});
test('下界足够时可证明达标，但不生成精确剩余；缺失材料与冲突保持未知', () => {
  const view = task(); view.material_result!.certainty = 'lower_bound';
  const goal = { kind: 'material' as const, quantity: 40, itemId: 'rock' };
  assert.equal(goalResult(view, goal).target, 'uncertain'); assert.equal(goalResult(view, goal).remaining, null);
  assert.equal(goalResult(view, { ...goal, quantity: 20 }).target, 'achieved');
  delete view.material_result!.items.rock;
  assert.deepEqual(amount(view, goal), { value: null, certainty: 'unknown' });
  view.material_result!.items.rock = 29; view.evidence_conflict = true;
  assert.equal(amount(view, goal).certainty, 'unknown');
  assert.equal(sumAmounts([{ value: 2, certainty: 'exact' }, { value: 1, certainty: 'lower_bound' }]).certainty, 'lower_bound');
});
