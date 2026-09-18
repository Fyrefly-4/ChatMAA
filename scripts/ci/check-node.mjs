import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pinned = readFileSync('.node-version', 'utf8').trim();
assert.match(pinned, /^\d+\.\d+\.\d+$/);
assert.equal(process.versions.node, pinned, 'Node 与版本文件不一致');
const range = JSON.parse(readFileSync('backend/package.json', 'utf8')).engines.node;
// Fail closed if the project's engine declaration changes to another range format.
const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(range);
assert.ok(match, 'engines 格式改变，请同步范围校验');
const compare = (a, b) => a.reduce((value, part, i) => value || Math.sign(part - b[i]), 0);
const actual = pinned.split('.').map(Number);
assert.ok(compare(actual, match.slice(1, 4).map(Number)) >= 0 && actual[0] < Number(match[4]), 'Node 不满足 engines');
console.log(`Node ${pinned}; engines ${range}`);
