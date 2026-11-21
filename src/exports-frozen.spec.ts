import { deepFreeze } from './deep-freeze';
import * as drizzleEntry from './drizzle';
import * as gate from './gate';
import * as gateJest from './gate-jest';
import * as entry0 from './index';

/**
 * Каждое экспортированное значение-объект заморожено глубоко: иначе любая
 * зависимость потребителя переписала бы словарь пакета для всего процесса
 * (`SCOPE_PROBLEM.superuser = …` — и проверка на старте говорила бы не то).
 */
const ENTRIES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['.', entry0 as Record<string, unknown>],
  ['./drizzle', drizzleEntry as Record<string, unknown>],
  ['./gate', gate as Record<string, unknown>],
  ['./gate/jest', gateJest as Record<string, unknown>],
];

const unfrozen = (value: unknown, path: string, seen: Set<unknown>): string[] => {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const own = Object.isFrozen(value) && !(value instanceof Set) && !(value instanceof Map) ? [] : [path];
  return own.concat(...Object.entries(value).map(([key, inner]) => unfrozen(inner, `${path}.${key}`, seen)));
};

describe('экспортированные значения заморожены', () => {
  it.each(ENTRIES)('вход %s: словари и массивы — глубоко', (_entry, api) => {
    const values = Object.entries(api).filter(([, value]) => typeof value === 'object' && value !== null);
    expect(values.flatMap(([name, value]) => unfrozen(value, name, new Set()))).toEqual([]);
  });

  it('выборка не выродилась: объекты есть', () => {
    const objects = ENTRIES.flatMap(([, api]) =>
      Object.values(api).filter((value) => typeof value === 'object' && value !== null),
    );
    expect(objects.length).toBeGreaterThanOrEqual(3);
  });

  it('deepFreeze: вложенные объекты и массивы; регулярка с g, Set и Map — отказ', () => {
    const value = { list: ['a', { deep: [1] }], nested: { flag: true } };
    deepFreeze(value);
    expect([value, value.list, value.list[1], value.nested].every((item) => Object.isFrozen(item))).toBe(
      true,
    );
    expect(() => deepFreeze({ pattern: /x/g })).toThrow('флаг g');
    expect(() => deepFreeze({ names: new Set(['a']) })).toThrow('Set');
    expect(() => deepFreeze({ byName: new Map() })).toThrow('Map');
    expect(() => deepFreeze({ pattern: /x/i })).not.toThrow();
  });
});
