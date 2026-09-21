import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { sealCatalog, validateCatalog } from './catalog.ts';
import type { CatalogData, Source, Stage, YieldSample } from './catalog.ts';

type GameStage = { stageId: string; code: string; name: string; stageType: string; difficulty: string;
  canBattleReplay: boolean; apCost: number; stageDropInfo: { displayDetailRewards: { id: string; dropType: string }[] } };
type Item = { name: string; stageDropList?: { stageId: string }[] };
type MaaStage = { stageId: string; code: string; apCost: number; dropInfos: { itemId: string; dropType: string }[] };
export type ImportInput = {
  gameStages: { stages: Record<string, GameStage> }; gameItems: { items: Record<string, Item> };
  maaStages: MaaStage[]; maaItems: Record<string, unknown>;
  matrix?: { matrix: ({ stageId: string; itemId: string } & Omit<YieldSample, 'asOf'>)[] };
  sources: Record<string, Source>;
};

export function importCatalog(input: ImportInput) {
  const { gameStages, gameItems, maaStages, maaItems, matrix, sources } = input;
  if (!gameStages?.stages || !gameItems?.items || !Array.isArray(maaStages) || !maaItems ||
      !['gameStages', 'gameItems', 'maaStages', 'maaItems'].every(k => sources[k]) ||
      (matrix && (!Array.isArray(matrix.matrix) || !sources.matrix))) throw new Error('资料文件或来源清单不完整');
  const stages: Stage[] = [];
  const items: CatalogData['items'] = {};
  for (const maa of maaStages) {
    const game = gameStages.stages[maa.stageId];
    if (!game || !['MAIN', 'SUB', 'DAILY'].includes(game.stageType) || game.difficulty !== 'NORMAL' ||
        !game.canBattleReplay || game.code !== maa.code || game.apCost !== maa.apCost || game.apCost <= 0 ||
        !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(game.code)) continue;
    const repeatable = new Set((game.stageDropInfo?.displayDetailRewards ?? [])
      .filter(r => ['NORMAL', 'ADDITIONAL'].includes(r.dropType)).map(r => r.id));
    const drops = [...new Set(maa.dropInfos.filter(r => ['NORMAL_DROP', 'EXTRA_DROP'].includes(r.dropType) &&
      repeatable.has(r.itemId) && maaItems[r.itemId] && gameItems.items[r.itemId]).map(r => r.itemId))].sort();
    for (const id of drops) items[id] = { name: gameItems.items[id].name, recommendation: null };
    const samples: Record<string, YieldSample> = {};
    for (const id of drops) {
      // Multiple windows are not added together: overlapping samples would invent precision.
      const matches = (matrix?.matrix ?? []).filter(r => r.stageId === game.stageId && r.itemId === id &&
        Number.isSafeInteger(r.times) && r.times >= 100 && Number.isSafeInteger(r.quantity) && r.quantity > 0 &&
        Number.isFinite(r.start) && r.start <= Date.parse(sources.matrix.fetchedAt) &&
        (r.end === null || (Number.isFinite(r.end) && r.end > r.start && r.end <= Date.parse(sources.matrix.fetchedAt))));
      if (matches.length === 1) {
        const { quantity, times, start, end } = matches[0];
        samples[id] = { quantity, times, start, end, asOf: sources.matrix.fetchedAt };
      }
    }
    stages.push({ id: game.stageId, code: game.code, name: game.name, apCost: game.apCost,
      availability: game.stageType === 'DAILY' ? 'scheduled' : 'permanent', drops, samples });
  }
  // Ambiguous stage codes need a reviewed mapping, not an arbitrary first match.
  const unambiguous = stages.filter(s => stages.filter(other => other.code === s.code).length === 1)
    .sort((a, b) => a.code.localeCompare(b.code, 'en'));
  for (const [id, item] of Object.entries(items)) {
    const preferred = gameItems.items[id].stageDropList ?? [];
    for (const candidate of preferred) {
      const stage = unambiguous.find(s => s.id === candidate.stageId && s.availability === 'permanent' && s.drops.includes(id));
      if (stage) { item.recommendation = stage.code; break; }
    }
  }
  return validateCatalog(sealCatalog({ schema: 1, server: 'CN', sources, items, stages: unambiguous,
    coverage: { excludedStages: maaStages.length - unambiguous.length,
      relationships: unambiguous.reduce((sum, s) => sum + s.drops.length, 0),
      estimates: unambiguous.reduce((sum, s) => sum + Object.keys(s.samples).length, 0),
      recommendations: Object.values(items).filter(i => i.recommendation).length } }));
}

// Explicit maintenance command; never imported by the runtime to perform network work.
async function main() {
  const [sourceDir, manifestFile, output] = process.argv.slice(2);
  if (!sourceDir || !manifestFile || !output) throw new Error('用法：catalog-import.ts <资料目录> <来源清单.json> <输出.json>');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, Source & { file: string }>;
  const inputs: Record<string, unknown> = {}; const sources: Record<string, Source> = {};
  for (const [key, { file, ...source }] of Object.entries(manifest)) {
    const bytes = readFileSync(resolve(sourceDir, file));
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`来源摘要不匹配：${key}`);
    inputs[key] = JSON.parse(bytes.toString('utf8')); sources[key] = source;
  }
  const snapshot = importCatalog({ ...inputs, sources } as ImportInput);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  const temporary = `${resolve(output)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, resolve(output));
  console.log(JSON.stringify({ version: snapshot.version, stages: snapshot.stages.length, items: Object.keys(snapshot.items).length,
    ...snapshot.coverage }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
