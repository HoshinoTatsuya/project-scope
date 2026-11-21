import type { RoutineFacts } from '../types/routine-facts.type';
import { routineReach } from './routine-reach';

/**
 * К концу истории — подпрограммы SECURITY DEFINER, которые касаются данных
 * области через ДРУГИЕ подпрограммы миграций (`routineReach`) или чьё тело не
 * прочесть: динамический SQL, язык кроме sql и plpgsql. Прямое касание названо
 * раньше, в своей миграции (`reported`).
 */
export function definerViolations(routines: ReadonlyMap<string, RoutineFacts>): string[] {
  const opaque =
    'динамический SQL или тело на языке, которое гейт не читает: касается ли она таблиц области, не определить';
  const violations: string[] = [];
  for (const [name, routine] of routines) {
    if (!routine.definer || routine.reported) {
      continue;
    }
    const found = routineReach(routines, name);
    if (found === null) {
      continue;
    }
    violations.push(
      found.via === name
        ? `${routine.file}: функция SECURITY DEFINER ${name} — ${opaque}`
        : found.opaque
          ? `${routine.file}: функция SECURITY DEFINER ${name} зовёт ${found.via} — ${opaque}`
          : `${routine.file}: функция SECURITY DEFINER ${name} через ${found.via} касается таблицы области — исполняется правами владельца, который политик не проходит`,
    );
  }
  return violations;
}
