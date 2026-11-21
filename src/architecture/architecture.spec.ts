import { resolve } from 'node:path';

import type { ArchConfig } from '@hoshinotatsuya/arch-gates';
import { rules } from '@hoshinotatsuya/arch-gates/rules';

/**
 * Гейты, которые пакеты семейства проверяют у потребителей, — на самом пакете.
 * Допущения «один файл — одна сущность» — храповик: `ARCH_UPDATE=1` только
 * понижает их до факта, новый нарушитель вносится правкой файла руками.
 */
const ARCH: ArchConfig = { root: resolve(__dirname, '..', '..') };

rules.oneDeclarationPerFile(ARCH, {
  allowlist: 'src/architecture/one-declaration-per-file.allowlist.json',
  minSample: 60,
});

rules.specsDoNotTimeWithWallClock(ARCH, {
  allowlist: 'src/architecture/wall-clock-in-specs.allowlist.json',
  minSample: 12,
});

rules.noEmptyDirectories(ARCH, { minVisited: 12 });

rules.typeCheckNotSuppressed(ARCH, { tsconfigs: { 'tsconfig.json': 80 } });
