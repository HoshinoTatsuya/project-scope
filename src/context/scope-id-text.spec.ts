import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { defineProjectScope } from '../scope/define-project-scope';
import type { ScopeColumnType } from '../types/scope-column-type.type';
import { scopeIdText } from './scope-id-text';

const scopeOf = (columnType: ScopeColumnType) =>
  defineProjectScope({ setting: 'app.scope', column: 'scope_id', columnType, tables: ['items'] });

describe('scopeIdText', () => {
  it.each([
    [SCOPE_COLUMN_TYPE.uuid, '0A0A0A0A-0000-4000-8000-00000000000A', '0a0a0a0a-0000-4000-8000-00000000000a'],
    [SCOPE_COLUMN_TYPE.text, 'tenant-é', 'tenant-é'],
    [SCOPE_COLUMN_TYPE.varchar, 'acme', 'acme'],
    [SCOPE_COLUMN_TYPE.bigint, '9223372036854775807', '9223372036854775807'],
    [SCOPE_COLUMN_TYPE.bigint, 42, '42'],
    [SCOPE_COLUMN_TYPE.bigint, -7n, '-7'],
    [SCOPE_COLUMN_TYPE.integer, '-2147483648', '-2147483648'],
    // Одна область — один текст: по нему сверяется вложенность.
    [SCOPE_COLUMN_TYPE.integer, '-0', '0'],
    [SCOPE_COLUMN_TYPE.bigint, -0, '0'],
  ])('%s: %p → %p', (type, input, expected) => {
    expect(scopeIdText(scopeOf(type), input)).toBe(expected);
  });

  it.each([
    [SCOPE_COLUMN_TYPE.uuid, ''],
    // Пустое значение для text и varchar: формат его не ловит, только запрет пустого.
    [SCOPE_COLUMN_TYPE.text, ''],
    [SCOPE_COLUMN_TYPE.varchar, ''],
    // Одиночные суррогаты: Node кодирует оба в U+FFFD — разные значения стали бы одной областью.
    [SCOPE_COLUMN_TYPE.text, 'a\ud800b'],
    [SCOPE_COLUMN_TYPE.varchar, 'a\udc00b'],
    [SCOPE_COLUMN_TYPE.uuid, 'not-a-uuid'],
    [SCOPE_COLUMN_TYPE.uuid, 42],
    [SCOPE_COLUMN_TYPE.text, '   '],
    [SCOPE_COLUMN_TYPE.text, 'a\0b'],
    [SCOPE_COLUMN_TYPE.text, null],
    [SCOPE_COLUMN_TYPE.bigint, '9223372036854775808'],
    [SCOPE_COLUMN_TYPE.bigint, '01'],
    [SCOPE_COLUMN_TYPE.bigint, 1.5],
    [SCOPE_COLUMN_TYPE.bigint, Number.MAX_SAFE_INTEGER + 1],
    [SCOPE_COLUMN_TYPE.integer, '2147483648'],
    [SCOPE_COLUMN_TYPE.integer, '1e3'],
    [SCOPE_COLUMN_TYPE.text, 'acme\u200b'],
    [SCOPE_COLUMN_TYPE.text, '\ufeffacme'],
    [SCOPE_COLUMN_TYPE.text, 'ac\u0007me'],
    [SCOPE_COLUMN_TYPE.text, 'a\u2028b'],
    [SCOPE_COLUMN_TYPE.text, 'acme '],
    [SCOPE_COLUMN_TYPE.text, ' tenant'],
    [SCOPE_COLUMN_TYPE.text, 'ac\u3164me'],
    // Заполнитель, устойчивый к NFKC: ловит только запрет Default_Ignorable_Code_Point.
    [SCOPE_COLUMN_TYPE.text, 'ac\u115fme'],
    [SCOPE_COLUMN_TYPE.text, 'tenant-e\u0301'],
    [SCOPE_COLUMN_TYPE.text, '\uff41\uff43\uff4d\uff45'],
  ])('%s: %p — отказ до запроса', (type, input) => {
    expect(() => scopeIdText(scopeOf(type), input)).toThrow('значение области app.scope');
  });

  it('значение области в текст отказа не попадает: он уходит в логи', () => {
    const secret = 'tenant-secret-0001';
    for (const [type, input] of [
      [SCOPE_COLUMN_TYPE.uuid, secret],
      [SCOPE_COLUMN_TYPE.bigint, secret],
      [SCOPE_COLUMN_TYPE.text, `${secret}\u200b`],
    ] as const) {
      expect(() => scopeIdText(scopeOf(type), input)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(secret) }),
      );
    }
  });
});
