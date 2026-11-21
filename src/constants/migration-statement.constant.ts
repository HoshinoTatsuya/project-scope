import { deepFreeze } from '../deep-freeze';
import { SQL_NAME_PATTERN } from './sql-name-pattern.constant';

/**
 * Формы операторов миграций, которые читает гейт покрытия (по тексту без
 * комментариев и литералов, пробелы сведены к одному). Без флага g: общий
 * словарь не держит `lastIndex`.
 */
export const MIGRATION_STATEMENT = {
  createTable: new RegExp(
    `^CREATE (?:(?:GLOBAL |LOCAL )?(TEMP|TEMPORARY) |UNLOGGED )?TABLE (IF NOT EXISTS )?(${SQL_NAME_PATTERN.qualified}) ?(.*)$`,
    'i',
  ),
  /** `SELECT … INTO таблица FROM …` — та же новая таблица, что CREATE TABLE AS. */
  selectInto: new RegExp(
    `^(?:WITH .*? )?SELECT (?:(?!\\bFROM\\b).)*?(?<!INSERT )\\bINTO (?:(?:GLOBAL |LOCAL )?(TEMP|TEMPORARY) |UNLOGGED )?(?:TABLE )?(${SQL_NAME_PATTERN.qualified})`,
    'i',
  ),
  partitionOf: new RegExp(`^PARTITION OF (${SQL_NAME_PATTERN.qualified})`, 'i'),
  inherits: /\bINHERITS ?\(([^)]*)\)/i,
  tableConstraint: /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i,
  likeElement: /^LIKE\b/i,
  columnName: new RegExp(`^(${SQL_NAME_PATTERN.identifier})`),
  alterTable: new RegExp(
    String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${SQL_NAME_PATTERN.qualified})(?: ?\*)? (.*)$`,
    'i',
  ),
  enableRls: /^ENABLE ROW LEVEL SECURITY$/i,
  disableRls: /^DISABLE ROW LEVEL SECURITY$/i,
  forceRls: /^FORCE ROW LEVEL SECURITY$/i,
  noForceRls: /^NO FORCE ROW LEVEL SECURITY$/i,
  addColumn: new RegExp(`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(${SQL_NAME_PATTERN.identifier})`, 'i'),
  /** `ADD [CONSTRAINT имя] FOREIGN KEY …` — без слова ADD в группе. */
  addConstraint: /^ADD ((?:CONSTRAINT|FOREIGN)\b.*)$/i,
  dropColumn: new RegExp(`^DROP (?:COLUMN )?(?:IF EXISTS )?(${SQL_NAME_PATTERN.identifier})`, 'i'),
  dropConstraint: new RegExp(`^DROP CONSTRAINT (?:IF EXISTS )?(${SQL_NAME_PATTERN.identifier})`, 'i'),
  renameColumn: new RegExp(
    `^RENAME (?:COLUMN )?(${SQL_NAME_PATTERN.identifier}) TO (${SQL_NAME_PATTERN.identifier})$`,
    'i',
  ),
  renameTable: new RegExp(`^RENAME TO (${SQL_NAME_PATTERN.identifier})$`, 'i'),
  setSchema: new RegExp(`^SET SCHEMA (${SQL_NAME_PATTERN.identifier})$`, 'i'),
  inherit: new RegExp(`^INHERIT (${SQL_NAME_PATTERN.qualified})$`, 'i'),
  noInherit: new RegExp(`^NO INHERIT (${SQL_NAME_PATTERN.qualified})$`, 'i'),
  /** `[CONSTRAINT имя] PRIMARY KEY (колонки)` — элемент таблицы или действие ADD (без ADD). */
  primaryKey: new RegExp(`^(?:CONSTRAINT ${SQL_NAME_PATTERN.identifier} )?PRIMARY KEY ?\\(([^)]*)\\)`, 'i'),
  columnPrimaryKey: /\bPRIMARY KEY\b/i,
  attachPartition: new RegExp(`^ATTACH PARTITION (${SQL_NAME_PATTERN.qualified})`, 'i'),
  /** `DETACH PARTITION секция [CONCURRENTLY | FINALIZE]` — секция становится самостоятельной таблицей. */
  detachPartition: new RegExp(
    `^DETACH PARTITION (${SQL_NAME_PATTERN.qualified})(?: (?:CONCURRENTLY|FINALIZE))?$`,
    'i',
  ),
  createPolicy: new RegExp(
    `^CREATE POLICY (${SQL_NAME_PATTERN.identifier}) ON (${SQL_NAME_PATTERN.qualified})`,
    'i',
  ),
  dropPolicy: new RegExp(
    `^DROP POLICY (?:IF EXISTS )?(${SQL_NAME_PATTERN.identifier}) ON (${SQL_NAME_PATTERN.qualified})`,
    'i',
  ),
  alterPolicy: new RegExp(
    `^ALTER POLICY (${SQL_NAME_PATTERN.identifier}) ON (${SQL_NAME_PATTERN.qualified})`,
    'i',
  ),
  dropTable: new RegExp(`^DROP TABLE (?:IF EXISTS )?(${SQL_NAME_PATTERN.qualifiedList})`, 'i'),
  createView: new RegExp(
    `^CREATE (?:OR REPLACE )?(TEMP |TEMPORARY )?(?:RECURSIVE )?VIEW (${SQL_NAME_PATTERN.qualified}) ?(.*)$`,
    'i',
  ),
  /** Параметры `WITH (…)` представления — по ТЕКСТУ оператора (значение бывает строкой). */
  viewOptions: new RegExp(
    `^CREATE (?:OR REPLACE )?(?:TEMP |TEMPORARY )?(?:RECURSIVE )?VIEW ${SQL_NAME_PATTERN.qualified} ?(?:\\([^)]*\\) ?)?WITH ?\\(([^)]*)\\)`,
    'i',
  ),
  createMaterializedView: new RegExp(
    `^CREATE MATERIALIZED VIEW (?:IF NOT EXISTS )?(${SQL_NAME_PATTERN.qualified}) ?(.*)$`,
    'i',
  ),
  alterView: new RegExp(
    `^ALTER (MATERIALIZED )?VIEW (?:IF EXISTS )?(${SQL_NAME_PATTERN.qualified}) (.*)$`,
    'i',
  ),
  viewSetOptions: /^(SET|RESET) ?\(([^)]*)\)$/i,
  dropView: new RegExp(
    `^DROP (?:MATERIALIZED )?VIEW (?:IF EXISTS )?(${SQL_NAME_PATTERN.qualifiedList})`,
    'i',
  ),
  createRule: new RegExp(
    `^CREATE (?:OR REPLACE )?RULE (${SQL_NAME_PATTERN.identifier}) AS ON (?:SELECT|INSERT|UPDATE|DELETE) TO (${SQL_NAME_PATTERN.qualified})(.*)$`,
    'i',
  ),
  dropRule: new RegExp(
    `^DROP RULE (?:IF EXISTS )?(${SQL_NAME_PATTERN.identifier}) ON (${SQL_NAME_PATTERN.qualified})`,
    'i',
  ),
  /** `CREATE SCHEMA … CREATE TABLE …`: элементы схемы — операторы внутри оператора. */
  createSchemaElements: new RegExp(
    `^CREATE SCHEMA (?:IF NOT EXISTS )?(?:(?!AUTHORIZATION\\b)${SQL_NAME_PATTERN.identifier} )?(?:AUTHORIZATION ${SQL_NAME_PATTERN.identifier} )?(?:CREATE|GRANT)\\b`,
    'i',
  ),
  rollback: /^(?:ROLLBACK|ABORT)\b/i,
  conformingStrings: /\bstandard_conforming_strings\b/i,
  unicodeEscapeClause: /\bUESCAPE\b/i,
  /** GRANT роли (без `ON`): кому достаётся членство. */
  grantRole: /^GRANT (?!.*\bON\b)(.+?) TO (.+)$/i,
  /**
   * Атрибуты роли, снимающие изоляцию: обход RLS, слот логического
   * декодирования, CREATEROLE (ниже Postgres 16 — членство в любой роли без
   * суперправ; гейт версии сервера не знает).
   */
  roleAttributes:
    /^(?:CREATE|ALTER) (?:ROLE|USER|GROUP)\b.*(?<!NO)\b(BYPASSRLS|SUPERUSER|REPLICATION|CREATEROLE)\b/i,
  /** `CREATE ROLE имя …`: остаток — для `IN ROLE`/`IN GROUP` и `ROLE`/`ADMIN`/`USER` (члены новой роли). */
  createRole: new RegExp(`^CREATE (?:ROLE|USER|GROUP) (${SQL_NAME_PATTERN.identifier})(.*)$`, 'i'),
  roleInRole: /\bIN (?:ROLE|GROUP) (.+)$/i,
  roleMembers: /(?<!\bIN )\b(?:ROLE|ADMIN|USER) (.+)$/i,
  alterGroupAdd: new RegExp(`^ALTER GROUP (${SQL_NAME_PATTERN.identifier}) ADD USER (.+)$`, 'i'),
  createRoutine: /^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE)\b/i,
  /** `CREATE [OR REPLACE] FUNCTION|PROCEDURE имя(` — имя подпрограммы (перегрузки не различаются). */
  createRoutineName: new RegExp(
    `^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) (${SQL_NAME_PATTERN.qualified}) ?\\(`,
    'i',
  ),
  /** Язык подпрограммы — по маске (тело вырезано); без LANGUAGE — `BEGIN ATOMIC` (sql). */
  routineLanguage: /\bLANGUAGE ([A-Za-z_][A-Za-z0-9_]*)\b/i,
  /** Динамический SQL в теле plpgsql: текст запроса собирается при исполнении. */
  dynamicSql: /\bEXECUTE\b/i,
  dropRoutine: /^DROP (?:FUNCTION|PROCEDURE|ROUTINE) (?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$/i,
  alterRoutineOwner: new RegExp(
    `^ALTER (?:FUNCTION|PROCEDURE|ROUTINE) (${SQL_NAME_PATTERN.qualified}) ?(?:\\([^)]*\\) ?)?OWNER TO\\b`,
    'i',
  ),
  alterRoutineRename: new RegExp(
    `^ALTER (?:FUNCTION|PROCEDURE|ROUTINE) (${SQL_NAME_PATTERN.qualified}) ?(?:\\([^)]*\\) ?)?RENAME TO (${SQL_NAME_PATTERN.identifier})$`,
    'i',
  ),
  /** `GRANT … ON FUNCTION|PROCEDURE|ROUTINE список TO` и `… ON ALL FUNCTIONS IN SCHEMA схемы TO`. */
  grantRoutine:
    /^GRANT .*?\bON (?:(?:FUNCTION|PROCEDURE|ROUTINE) (.+?)|ALL (?:FUNCTIONS|PROCEDURES|ROUTINES) IN SCHEMA (.+?)) TO\b/i,
  /**
   * `EXPLAIN` перед оператором: с ANALYZE оператор ИСПОЛНЯЕТСЯ (CREATE TABLE …
   * AS, CREATE MATERIALIZED VIEW), без него — только план. Группы: параметры в
   * скобках, старая запись (`ANALYZE VERBOSE`), сам оператор.
   */
  explain: /^EXPLAIN (?:\(([^)]*)\) ?|((?:(?:ANALY[SZ]E|VERBOSE) )*))(.+)$/i,
  /**
   * `search_path` на сессию, роль или базу: имена без схемы сервер разрешает
   * по нему, а гейт читает их как public. Значение — по тексту (бывает строкой).
   */
  searchPath:
    /^(?:SET (?:SESSION |LOCAL )?|ALTER (?:ROLE|USER|DATABASE) .*?\bSET )search_path ?(?:TO|=) ?(.+)$/i,
  /** `set_config('search_path', '<значение>', …)` — по тексту оператора. */
  setConfigSearchPath: /\bset_config ?\( ?'search_path' ?, ?(?:'((?:[^']|'')*)')?/i,
  alterRoutine: /^ALTER (?:FUNCTION|PROCEDURE)\b/i,
  securityDefiner: /\bSECURITY DEFINER\b/i,
  /** Ограничение таблицы `[CONSTRAINT имя] FOREIGN KEY (…) REFERENCES родитель [(…)]`. */
  tableForeignKey: new RegExp(
    `^(?:CONSTRAINT (${SQL_NAME_PATTERN.identifier}) )?FOREIGN KEY ?\\(([^)]*)\\) ?REFERENCES (${SQL_NAME_PATTERN.qualified}) ?(?:\\(([^)]*)\\))?`,
    'i',
  ),
  /** Ограничение колонки `… [CONSTRAINT имя] REFERENCES родитель [(колонка)]`. */
  columnForeignKey: new RegExp(
    `(?:\\bCONSTRAINT (${SQL_NAME_PATTERN.identifier}) )?\\bREFERENCES (${SQL_NAME_PATTERN.qualified}) ?(?:\\(([^)]*)\\))?`,
    'i',
  ),
} as const;

deepFreeze(MIGRATION_STATEMENT);
