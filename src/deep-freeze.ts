/**
 * Заморозить экспортированное значение целиком, со вложенными объектами и
 * массивами. `as const` — только тип: без заморозки любая зависимость
 * потребителя переписала бы словарь для всего процесса (`СПИСОК.length = 0`
 * молча выключал проверку). Регулярное выражение с флагом g или y в общем
 * словаре — отказ при загрузке: его `lastIndex` — общее изменяемое состояние,
 * а замороженное оно падало бы на первом `replace`. Set и Map — тоже отказ:
 * заморозка не мешает `add` и `set`.
 */
export function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (value instanceof RegExp && (value.global || value.sticky)) {
    throw new Error(
      `регулярное выражение /${value.source}/${value.flags} в замороженном словаре: флаг g или y`,
    );
  }
  if (value instanceof Set || value instanceof Map) {
    throw new Error(
      `${value.constructor.name} в замороженном словаре: заморозка не мешает изменять его содержимое`,
    );
  }
  Object.freeze(value);
  for (const inner of Object.values(value)) {
    deepFreeze(inner, seen);
  }
}
