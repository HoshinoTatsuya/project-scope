import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_ID_FORMAT } from '../constants/scope-id-format.constant';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Значение области — текстом для `set_config`, проверенное по типу колонки ДО
 * запроса. Пустое значение — отказ: пустая строка в политике означает «не
 * задано» (ноль строк), и вызывающий, передавший пустой id по ошибке, получил
 * бы молчаливое «ничего нет» вместо отказа. Значение, которое сервер не
 * приведёт к типу колонки, — тоже отказ здесь, а не ошибка приведения на
 * первом запросе работы. Значение, которое выглядит как другое, — отказ:
 * управляющие и невидимые символы (NUL, пробел нулевой ширины, BOM,
 * заполнители вроде U+3164), одиночный суррогат UTF-16 (`'a\ud800b'` и
 * `'a\udc00b'` ушли бы в базу одним `a�b`), пробел по краям, запись не в NFKC (разложенные
 * `é`, полноширинные `ａｃｍｅ`) — `acme` и `acme\u200b` выглядят одной
 * областью, а для сервера — две. Целое приводится к одной записи (`-0` → `0`), uuid — к
 * нижнему регистру: одна область — один текст (по нему сверяется вложенность).
 *
 * Само значение в текст отказа не попадает: он уходит в логи, а значение —
 * чужой ввод.
 */
export function scopeIdText(scope: ProjectScope, scopeId: unknown): string {
  const fail = (why: string): never => {
    throw new Error(`значение области ${scope.setting} (${scope.columnType}): ${why}`);
  };
  let text: string;
  if (typeof scopeId === 'string') {
    text = scopeId;
  } else if (typeof scopeId === 'bigint' || (typeof scopeId === 'number' && Number.isSafeInteger(scopeId))) {
    if (scope.columnType !== SCOPE_COLUMN_TYPE.bigint && scope.columnType !== SCOPE_COLUMN_TYPE.integer) {
      return fail(`число для колонки ${scope.columnType}`);
    }
    text = String(scopeId);
  } else {
    return fail(
      `ожидалась строка${typeof scopeId === 'number' ? ' (число не целое или вне безопасного диапазона)' : `, получено ${typeof scopeId}`}`,
    );
  }
  if (text.trim() === '') {
    return fail('пусто — пустой контекст означает «не задано», а не область');
  }
  // Одиночный суррогат Node кодирует в UTF-8 как U+FFFD: разные значения приложения стали бы одной областью.
  if (/\p{Cs}/u.test(text)) {
    return fail('одиночный суррогат UTF-16 — в базу ушёл бы U+FFFD вместо символа');
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(text)) {
    return fail('управляющий или невидимый символ (NUL, пробел нулевой ширины, BOM, заполнитель)');
  }
  if (text !== text.trim()) {
    return fail('пробел в начале или в конце');
  }
  if (text !== text.normalize('NFKC')) {
    return fail('запись не в форме NFKC (составные, полноширинные или совместимые символы)');
  }
  switch (scope.columnType) {
    case SCOPE_COLUMN_TYPE.uuid:
      return SCOPE_ID_FORMAT.uuid.test(text) ? text.toLowerCase() : fail(`не uuid (длина ${text.length})`);
    case SCOPE_COLUMN_TYPE.bigint:
    case SCOPE_COLUMN_TYPE.integer: {
      const [min, max] = SCOPE_ID_FORMAT.range[scope.columnType];
      if (!SCOPE_ID_FORMAT.integer.test(text) || BigInt(text) < min || BigInt(text) > max) {
        return fail(`не ${scope.columnType} (длина ${text.length})`);
      }
      return String(BigInt(text));
    }
    default:
      return text;
  }
}
