'use strict';
/**
 * ESM-декларации для условия `import`: каждый `dist/**\/*.d.ts` копируется в
 * `.d.mts` с явными расширениями относительных путей (`./x` → `./x.mjs`,
 * каталог → `./x/index.mjs`). Рантайм остаётся одним CJS — вторая копия классов
 * не появляется; меняется только то, как TypeScript потребителя резолвит
 * зависимости ИЗ деклараций пакета.
 *
 * Зачем: пакет `"type": "commonjs"`, и его `.d.ts` берут drizzle по условию
 * `require` (`.d.cts`), а потребитель с `moduleResolution` bundler/nodenext-ESM
 * (и TypeScript 6 с `module: commonjs`) — по `import` (`.d.ts`). Два файла
 * деклараций одной установки — два разных класса `Column`, и таблица из
 * `defineOutboxTable` не принималась функциями drizzle потребителя (TS2345).
 * `.d.mts` — ESM по расширению, и drizzle из него резолвится так же, как у
 * потребителя. Проверка — `scripts/consumer-matrix.sh`.
 *
 * Путь, который не разрешился ни в файл, ни в каталог, — отказ сборки, а не
 * копия как есть: нерезолвящийся импорт в декларациях молча стал бы `any`.
 */
const { readdirSync, readFileSync, statSync, existsSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const DIST = resolve(__dirname, '..', 'dist');
const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g;

function declarations(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return declarations(path);
    }
    return name.endsWith('.d.ts') ? [path] : [];
  });
}

function esmSpecifier(file, specifier) {
  const base = resolve(dirname(file), specifier);
  if (existsSync(`${base}.d.ts`)) {
    return `${specifier}.mjs`;
  }
  if (existsSync(join(base, 'index.d.ts'))) {
    return `${specifier.replace(/\/$/, '')}/index.mjs`;
  }
  throw new Error(`${file}: относительный импорт «${specifier}» не разрешился в декларацию`);
}

let written = 0;
for (const file of declarations(DIST)) {
  const source = readFileSync(file, 'utf8');
  const esm = source
    .replace(SPECIFIER, (_match, head, quote, specifier) => `${head}${quote}${esmSpecifier(file, specifier)}${quote}`)
    .replace(/^\/\/# sourceMappingURL=.*$/m, '');
  writeFileSync(file.replace(/\.d\.ts$/, '.d.mts'), esm);
  written += 1;
}
if (written === 0) {
  throw new Error(`в ${DIST} нет ни одной декларации: сборка не прошла или каталог не тот`);
}
console.log(`ESM-декларации: ${written}`);
