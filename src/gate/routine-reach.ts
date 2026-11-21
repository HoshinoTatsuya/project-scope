import type { RoutineFacts } from '../types/routine-facts.type';

/**
 * Касается ли подпрограмма данных области — сама или через подпрограммы,
 * чьи имена встречаются в её тексте (в любом порядке создания). Ответ —
 * первая подпрограмма цепочки, которая касается области или чьё тело не
 * прочесть (`opaque`: «не определить» — то же, что «касается»); null — ни одна.
 * Перегрузки не различаются: лишнее ребро делает ответ строже, а не мягче.
 */
export function routineReach(
  routines: ReadonlyMap<string, RoutineFacts>,
  name: string,
  seen: Set<string> = new Set(),
): { via: string; opaque: boolean } | null {
  const routine = routines.get(name);
  if (routine === undefined || seen.has(name)) {
    return null;
  }
  seen.add(name);
  if (routine.touchesScope || routine.opaque) {
    return { via: name, opaque: !routine.touchesScope };
  }
  for (const called of routine.names) {
    const found = routineReach(routines, called, seen);
    if (found !== null) {
      return found;
    }
  }
  return null;
}
