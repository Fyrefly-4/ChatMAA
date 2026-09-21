import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TaskError } from '../task-contract.ts';

export type Source = { url: string; revision: string; sha256: string; fetchedAt: string };
export type YieldSample = { quantity: number; times: number; start: number; end: number | null; asOf: string };
export type Stage = {
  id: string; code: string; name: string; apCost: number; availability: 'permanent' | 'scheduled';
  drops: string[]; samples: Record<string, YieldSample>;
};
export type CatalogData = {
  schema: 1; server: 'CN'; sources: Record<string, Source>;
  items: Record<string, { name: string; recommendation: string | null }>;
  stages: Stage[];
  coverage: { excludedStages: number; relationships: number; estimates: number; recommendations: number };
};
export type CatalogSnapshot = CatalogData & { version: string };
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function sealCatalog(data: CatalogData): CatalogSnapshot { return { ...data, version: digest(data) }; }

// This validates imported data again at the application boundary, before activating it.
export function validateCatalog(value: unknown): CatalogSnapshot {
  const invalid = () => { throw new TaskError(422, 'invalid_catalog'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const { version, ...data } = value as CatalogSnapshot;
  if (version !== digest(data) || data.schema !== 1 || data.server !== 'CN' || !Array.isArray(data.stages) ||
      !data.items || !data.sources || !Object.keys(data.sources).length) return invalid();
  for (const source of Object.values(data.sources)) {
    if (!source || !/^https:\/\//.test(source.url) || !source.revision ||
        !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isFinite(Date.parse(source.fetchedAt))) return invalid();
  }
  const codes = new Set<string>();
  for (const stage of data.stages) {
    if (!stage || !stage.id || !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(stage.code) || codes.has(stage.code) ||
        !Number.isSafeInteger(stage.apCost) || stage.apCost < 1 || !['permanent', 'scheduled'].includes(stage.availability) ||
        !Array.isArray(stage.drops) || new Set(stage.drops).size !== stage.drops.length || !stage.samples) return invalid();
    codes.add(stage.code);
    for (const item of stage.drops) if (!data.items[item]) return invalid();
    for (const [item, sample] of Object.entries(stage.samples)) {
      if (!stage.drops.includes(item) || !Number.isSafeInteger(sample.times) || sample.times < 100 ||
          !Number.isSafeInteger(sample.quantity) || sample.quantity <= 0 || !Number.isFinite(sample.start) ||
          !Number.isFinite(Date.parse(sample.asOf)) || sample.start > Date.parse(sample.asOf) ||
          (sample.end !== null && (!Number.isFinite(sample.end) || sample.end <= sample.start || sample.end > Date.parse(sample.asOf)))) return invalid();
    }
  }
  for (const [id, item] of Object.entries(data.items)) {
    if (!/^[A-Za-z0-9_]{1,80}$/.test(id) || !item || typeof item.name !== 'string' || !item.name ||
        (item.recommendation !== null && !data.stages.some(s => s.code === item.recommendation && s.availability === 'permanent' && s.drops.includes(id)))) return invalid();
  }
  return value as CatalogSnapshot;
}

export class Catalog {
  readonly snapshot: CatalogSnapshot;
  constructor(snapshot: unknown) { this.snapshot = validateCatalog(snapshot); }
  static bundled() { return new Catalog(JSON.parse(readFileSync(new URL('../../data/catalog-cn.json', import.meta.url), 'utf8'))); }
  candidates(itemId: string) {
    return this.snapshot.stages.filter(s => s.drops.includes(itemId)).map(s => ({ ...s,
      recommended: this.snapshot.items[itemId]?.recommendation === s.code }));
  }
  select(stage: string | undefined, itemId?: string) {
    if (itemId && !this.snapshot.items[itemId]) throw new TaskError(422, 'unknown_material');
    const code = stage ?? (itemId ? this.snapshot.items[itemId]?.recommendation : null);
    if (!code) throw new TaskError(409, 'stage_required');
    const entry = this.snapshot.stages.find(s => s.code === code);
    // Count operations may use explicitly selected stages outside this data coverage.
    if (itemId && !entry?.drops.includes(itemId)) throw new TaskError(409, 'material_stage_unverified');
    return { code, entry: entry ?? null, selection: stage ? 'user' as const : 'source_recommendation' as const,
      explanation: stage ? '沿用明确选定的关卡；解锁、代理与当前开放条件仍需满足。' :
        '沿用游戏材料表 stageDropList 顺序中的首个已核验常驻候选；不是效率最优结论。' };
  }
  estimate(stage: string, quantity: number, itemId?: string) {
    const entry = this.snapshot.stages.find(s => s.code === stage);
    const sample = itemId ? entry?.samples[itemId] : undefined;
    const common = { availableSanity: null, guarantee: false, note: '仅用现有理智，不吃药、不碎石；可能部分完成。' };
    if (!entry || (itemId && !sample)) return { ...common, kind: 'unavailable' as const, sanity: null,
      reason: entry ? '缺少可靠的材料产量统计，无法可靠估算。' : '资料未覆盖该关卡的参考消耗。' };
    return { ...common, kind: itemId ? 'historical_mean' as const : 'count_cost' as const,
      sanity: itemId ? quantity / (sample!.quantity / sample!.times) * entry.apCost : quantity * entry.apCost,
      sample: sample ?? null, reason: itemId ? '历史均值参考，不保证本次产量；不作为次数上限。' : '目标次数乘单次消耗，不表示当前理智足够。' };
  }
  // Relevant-entry comparison avoids invalidating every plan when unrelated data changes.
  basis(stage: string, itemId?: string) {
    const entry = this.snapshot.stages.find(s => s.code === stage);
    return digest({ stage, apCost: entry?.apCost ?? null, availability: entry?.availability ?? null,
      item: itemId ? this.snapshot.items[itemId] ?? null : null,
      applicable: itemId ? entry?.drops.includes(itemId) ?? false : null,
      sample: itemId ? entry?.samples[itemId] ?? null : null });
  }
}
