#!/usr/bin/env node
// README code that claims to be an example must be the example file verbatim: the examples are
// type-checked against the real API (tsconfig.examples.json), the README copy is not.
//
// A block is bound to a file by a marker line right before the fence:
//   <!-- example: examples/quick-start.ts -->
//   ```ts
//   …exact content of the file…
//   ```
// Every file in examples/ must be cited by README.md, and README.md must contain at least one marker
// (an empty selection would otherwise read as "all examples match").
'use strict';
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const readmes = ['README.md', 'README.ru.md'].filter((name) => existsSync(join(root, name)));
const marker = /^<!-- example: (\S+) -->$/;
const problems = [];
const citedByMain = new Set();

for (const readme of readmes) {
  const lines = readFileSync(join(root, readme), 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = marker.exec(lines[index]);
    if (match === null) {
      continue;
    }
    const file = match[1];
    if (!/^```[a-z]*$/.test(lines[index + 1] ?? '')) {
      problems.push(`${readme}:${index + 1}: marker for ${file} is not followed by a code fence`);
      continue;
    }
    const end = lines.indexOf('```', index + 2);
    if (end === -1) {
      problems.push(`${readme}:${index + 1}: code fence for ${file} is not closed`);
      continue;
    }
    if (!existsSync(join(root, file))) {
      problems.push(`${readme}:${index + 1}: ${file} does not exist`);
      continue;
    }
    const cited = lines.slice(index + 2, end).join('\n');
    const actual = readFileSync(join(root, file), 'utf8').replace(/\n$/, '');
    if (cited !== actual) {
      problems.push(`${readme}:${index + 1}: block differs from ${file}`);
    }
    if (readme === 'README.md') {
      citedByMain.add(file);
    }
  }
}

const examples = existsSync(join(root, 'examples'))
  ? readdirSync(join(root, 'examples')).filter((name) => name.endsWith('.ts')).map((name) => `examples/${name}`)
  : [];
if (examples.length === 0) {
  problems.push('examples/: no example files found');
}
for (const file of examples) {
  if (!citedByMain.has(file)) {
    problems.push(`README.md does not cite ${file}`);
  }
}

if (problems.length > 0) {
  console.error(`README examples: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log(`README examples: ${citedByMain.size} file(s) cited verbatim in ${readmes.join(', ')}`);
