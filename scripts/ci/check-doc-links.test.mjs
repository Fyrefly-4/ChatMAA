import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinks } from './check-doc-links.mjs';

test('checks portable tracked destinations, including references, images and directories', () => {
  const files = ['docs/index.md', 'README.md', 'docs/a b.md', 'images/chart.png'];
  const content = '[root](../README.md#intro) [space](<a b.md>) ![chart](/images/chart.png) [dir](../images/)\n[ref]: a%20b.md\n[external](https://example.org/nope) [anchor](#missing)';
  assert.deepEqual(checkLinks(files, file => file === 'docs/index.md' ? content : ''), []);
});

test('reports missing and untracked targets with source line; ignores code examples', () => {
  const content = '```md\n[example](missing.md)\n```\n`[inline](missing.md)`\n[bad](missing.md)\n[bad-ref]: ../private.md\n![bad-image](x.png)\n[bad-url](bad%ZZ.md)';
  const errors = checkLinks(['docs/index.md'], () => content);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /docs\/index.md:5:.*missing.md/);
  assert.match(errors[1], /docs\/index.md:6:.*private.md/);
  assert.match(errors[2], /docs\/index.md:7:.*x.png/);
  assert.match(errors[3], /docs\/index.md:8: invalid URL encoding/);
});

test('accepts balanced, nested, escaped and angle-wrapped parentheses with optional titles', () => {
  const files = ['index.md', 'guide(v2).md', 'guide(v2(draft)).md', 'a (v2).md', 'plot(v2).png'];
  const content = String.raw`[plain](guide(v2).md) [nested](guide(v2(draft)).md "Guide")
[escaped](guide\(v2\).md 'Guide') [angle](<a (v2).md> (Guide))
![image](plot(v2).png) [encoded](guide%28v2%29.md)
[reference]: guide\(v2\).md`;
  assert.deepEqual(checkLinks(files, file => file === 'index.md' ? content : ''), []);
});

test('reports the full missing parenthesized path and still checks the following link', () => {
  const errors = checkLinks(['index.md'], () => '[bad](missing(v2(draft)).md "Title") [next](other.md)');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /missing\(v2\(draft\)\)\.md$/);
  assert.match(errors[1], /other\.md$/);
});
