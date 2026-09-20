import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Check local file/directory destinations, not remote URLs or heading anchors.
export function checkLinks(files, read) {
  const tracked = new Set(files);
  const errors = [];
  for (const file of files.filter(name => name.endsWith('.md'))) {
    let fence;
    const lines = read(file).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const line = lines[i].replace(/(`+).*?\1/g, '');
      const destinations = [...line.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)]
        .map(match => match[1] ?? match[2]);
      const reference = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/.exec(line);
      if (reference) destinations.push(reference[1] ?? reference[2]);
      for (const destination of destinations) {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue;
        let path;
        try { path = decodeURIComponent(destination.split(/[?#]/, 1)[0]); }
        catch { errors.push(`${file}:${i + 1}: invalid URL encoding: ${destination}`); continue; }
        if (!path) continue;
        const target = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path)).replace(/\/$/, '');
        const exists = tracked.has(target) || files.some(name => name.startsWith(`${target}/`)) || target === '.';
        if (!exists) errors.push(`${file}:${i + 1}: untracked or missing destination: ${destination}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const errors = checkLinks(files, file => readFileSync(file, 'utf8'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Checked local link destinations in ${files.filter(file => file.endsWith('.md')).length} tracked Markdown files.`);
}
