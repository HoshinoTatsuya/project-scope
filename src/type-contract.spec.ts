import { join } from 'node:path';

import ts from 'typescript';

/**
 * Договор типов публичного API: `src/testing/type-contract/usage.ts` под
 * настройками пакета (`tsconfig.json`: strict, exactOptionalPropertyTypes)
 * компилируется без ошибок. Строки `@ts-expect-error` в нём — то, что типы
 * обязаны отвергать: если тип вдруг пропускает (число для uuid-области,
 * `resetSession: false`), компилятор отвечает TS2578 и спека краснеет.
 */
describe('договор типов публичного API', () => {
  it('usage.ts компилируется без ошибок: запрещённое — отвергнуто типами, нужное — экспортировано', () => {
    const root = join(__dirname, '..');
    const config = ts.readConfigFile(join(root, 'tsconfig.json'), (path) => ts.sys.readFile(path));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const file = join(__dirname, 'testing', 'type-contract', 'usage.ts');
    const program = ts.createProgram([file], { ...parsed.options, noEmit: true });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(diagnostics).toEqual([]);
    // Выборка не выродилась: файл в программе, строки-запреты в нём есть.
    const source = program.getSourceFile(file);
    expect(source?.text.match(/@ts-expect-error/g)?.length).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
