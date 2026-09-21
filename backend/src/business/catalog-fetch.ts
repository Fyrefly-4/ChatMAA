import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// A maintenance-only entry point. Planning never calls this module.
const [directory, gameRevision, maaRevision = 'v6.17.5', transport] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(gameRevision ?? '') || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(maaRevision) ||
    (transport !== undefined && transport !== '--github-cli')) {
  throw new Error('用法：catalog-fetch.ts <资料目录> <游戏数据完整提交SHA> [MAA版本，默认v6.17.5] [--github-cli]');
}
const game = `https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/${gameRevision}/zh_CN/gamedata/excel`;
const maa = `https://raw.githubusercontent.com/MaaAssistantArknights/MaaAssistantArknights/${maaRevision}/resource`;
const inputs = [
  ['gameStages', 'stage_table.json', `${game}/stage_table.json`, gameRevision],
  ['gameItems', 'item_table.json', `${game}/item_table.json`, gameRevision],
  ['maaStages', 'maa-stages.json', `${maa}/stages.json`, maaRevision],
  ['maaItems', 'maa-items.json', `${maa}/item_index.json`, maaRevision],
  ['matrix', 'matrix.json', 'https://penguin-stats.io/PenguinStats/api/v2/result/matrix?server=CN&show_closed_zones=false', 'CN-public-matrix'],
];
mkdirSync(resolve(directory), { recursive: true });
const manifest: Record<string, unknown> = {};
for (const [key, file, url, revision] of inputs) {
  let bytes: Buffer;
  if (transport === '--github-cli' && url.startsWith('https://raw.githubusercontent.com/')) {
    const [owner, repo, ref, ...path] = new URL(url).pathname.slice(1).split('/');
    bytes = execFileSync('gh', ['api', `repos/${owner}/${repo}/contents/${path.join('/')}?ref=${ref}`,
      '-H', 'Accept: application/vnd.github.raw+json'], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`资料读取失败：${key} HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  JSON.parse(bytes.toString('utf8'));
  writeFileSync(resolve(directory, file), bytes);
  manifest[key] = { file, url, revision, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') };
}
// No complete manifest is published if any input failed. Import checks all hashes.
writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('资料与来源清单已保存；尚未导入或激活。');
