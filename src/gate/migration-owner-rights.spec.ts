import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { migrationScopeViolations } from './migration-scope-violations';

const SCOPE = defineProjectScope({
  setting: 'app.project_id',
  column: 'project_id',
  columnType: SCOPE_COLUMN_TYPE.uuid,
  tables: ['items'],
  maintenanceRole: 'app_maintenance',
});
const TABLE = 'CREATE TABLE "items" ("id" serial PRIMARY KEY, "project_id" uuid NOT NULL, "body" text);';
const INIT = `${TABLE}\n${scopePolicySql(SCOPE)}`;

const check = (migrations: string[], first: string = INIT): readonly string[] =>
  migrationScopeViolations(
    SCOPE,
    [first, ...migrations].map((sql, index) => ({ name: `000${index}_m.sql`, sql })),
  ).violations;

/**
 * Код, исполняемый правами владельца, и то, что меняет смысл имён в
 * миграции: каждый случай — история, после которой область A читает или
 * меняет строки B, а гейт по тексту отвечал «чисто». Рядом — легитимный
 * двойник, на котором нарушения быть не должно.
 */
describe('migrationScopeViolations: права владельца, EXPLAIN ANALYZE, search_path, права на файлы', () => {
  it('SECURITY DEFINER с телом BEGIN ATOMIC: таблица области во ВТОРОМ операторе тела — нарушение; двойник без неё — чисто, и тело не читается операторами миграции', () => {
    const definer = (body: string): string =>
      `CREATE FUNCTION counted() RETURNS bigint LANGUAGE sql SECURITY DEFINER\nBEGIN ATOMIC\n  SELECT 1;\n  ${body};\nEND;`;
    expect(check([definer('SELECT count(*) FROM items')])).toEqual([
      '0001_m.sql: функция SECURITY DEFINER над таблицей области — исполняется правами владельца, который политик не проходит',
    ]);
    expect(check([definer('SELECT count(*) FROM pg_class')])).toEqual([]);
  });

  it('SECURITY DEFINER, который зовёт функцию над таблицей области (в любом порядке создания), — нарушение; двойник без таблицы области — чисто', () => {
    const inner =
      "CREATE FUNCTION inner_bodies() RETURNS SETOF text LANGUAGE sql AS 'SELECT body FROM items';";
    const outer =
      'CREATE FUNCTION outer_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM inner_bodies() $$;';
    const expected = [
      '0002_m.sql: функция SECURITY DEFINER outer_bodies через inner_bodies касается таблицы области — исполняется правами владельца, который политик не проходит',
    ];
    expect(check([inner, outer])).toEqual(expected);
    expect(
      check(['CREATE FUNCTION placeholder() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', outer, inner]),
    ).toEqual(expected);
    // Триггерная функция с правами владельца на ДРУГОЙ таблице зовёт чистку таблицы области.
    expect(
      check([
        'CREATE TABLE notes (id int);',
        'CREATE FUNCTION wipe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN PERFORM purge_all(); RETURN NEW; END$$;',
        "CREATE FUNCTION purge_all() RETURNS void LANGUAGE sql AS 'DELETE FROM items';",
        'CREATE TRIGGER t AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION wipe();',
      ]),
    ).toEqual([
      '0002_m.sql: функция SECURITY DEFINER wipe через purge_all касается таблицы области — исполняется правами владельца, который политик не проходит',
    ]);
    expect(
      check([
        "CREATE FUNCTION greeting() RETURNS text LANGUAGE sql AS 'SELECT 1::text';",
        'CREATE FUNCTION outer_greeting() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT greeting() $$;',
      ]),
    ).toEqual([]);
  });

  it('SECURITY DEFINER с динамическим SQL или на языке, тело которого не читается, — нарушение (не определить = отказ); снятый позже — чисто', () => {
    expect(
      check([
        "CREATE FUNCTION g() RETURNS SETOF text LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN RETURN QUERY EXECUTE 'SELECT body FROM ' || 'it' || 'ems'; END$$;",
      ]),
    ).toEqual([
      '0001_m.sql: функция SECURITY DEFINER g — динамический SQL или тело на языке, которое гейт не читает: касается ли она таблиц области, не определить',
    ]);
    expect(
      check(["CREATE FUNCTION native() RETURNS int LANGUAGE c SECURITY DEFINER AS 'scope_ext', 'native';"]),
    ).toEqual([
      '0001_m.sql: функция SECURITY DEFINER native — динамический SQL или тело на языке, которое гейт не читает: касается ли она таблиц области, не определить',
    ]);
    expect(
      check([
        "CREATE FUNCTION py() RETURNS int LANGUAGE plpython3u SECURITY DEFINER AS 'return 1';",
        'DROP FUNCTION py();',
      ]),
    ).toEqual([]);
    expect(
      check([
        "CREATE FUNCTION g() RETURNS SETOF text LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN RETURN QUERY EXECUTE 'SELECT 1'; END$$;",
        "CREATE OR REPLACE FUNCTION g() RETURNS SETOF text LANGUAGE plpgsql AS $$BEGIN RETURN QUERY EXECUTE 'SELECT 1'; END$$;",
      ]),
    ).toEqual([]);
  });

  it('ALTER FUNCTION … OWNER TO: функции вне миграций или с правами владельца над областью — нарушение; функции с правами вызывающего — чисто', () => {
    expect(check(['ALTER FUNCTION unknown_fn(int) OWNER TO postgres;'])).toEqual([
      '0001_m.sql: ALTER FUNCTION unknown_fn OWNER TO — функция создана не в этих миграциях: исполняется ли она правами владельца над данными области, не определить',
    ]);
    expect(
      check([
        "CREATE FUNCTION bodies() RETURNS SETOF text LANGUAGE sql AS 'SELECT body FROM items';",
        'ALTER FUNCTION public.bodies() OWNER TO postgres;',
      ]),
    ).toEqual([]);
    expect(
      check([
        "CREATE FUNCTION bodies() RETURNS SETOF text LANGUAGE sql AS 'SELECT body FROM items';",
        'CREATE FUNCTION outer_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM bodies() $$;',
        'ALTER FUNCTION outer_bodies() OWNER TO postgres;',
      ]),
    ).toEqual([
      '0003_m.sql: ALTER FUNCTION outer_bodies OWNER TO — функция SECURITY DEFINER касается таблицы области: новый владелец решает, проходит ли она политики',
      '0002_m.sql: функция SECURITY DEFINER outer_bodies через bodies касается таблицы области — исполняется правами владельца, который политик не проходит',
    ]);
  });

  it('EXPLAIN ANALYZE исполняет оператор: материализованное представление и CREATE TABLE … AS под ним — нарушения; EXPLAIN без ANALYZE — чисто', () => {
    expect(check(['EXPLAIN ANALYZE CREATE MATERIALIZED VIEW mv AS SELECT * FROM items;'])).toEqual([
      '0001_m.sql: материализованное представление mv над данными области — у него нет RLS, REFRESH сохраняет строки, видимые обновившему, для всех',
    ]);
    expect(check(['EXPLAIN (ANALYZE, BUFFERS) CREATE TABLE items_copy AS SELECT * FROM items;'])).toEqual([
      '0001_m.sql: CREATE TABLE items_copy не разобран (AS, LIKE, OF) — есть ли колонка project_id, не определить; внесите таблицу в список области или в notScoped с причиной',
    ]);
    expect(
      check(['EXPLAIN (ANALYZE TRUE) CREATE MATERIALIZED VIEW mv AS SELECT * FROM items;']),
    ).toHaveLength(1);
    expect(
      check([
        'EXPLAIN CREATE TABLE items_copy AS SELECT * FROM items;',
        'EXPLAIN (ANALYZE false, COSTS off) CREATE MATERIALIZED VIEW mv AS SELECT * FROM items;',
        'EXPLAIN VERBOSE SELECT * FROM items;',
      ]),
    ).toEqual([]);
  });

  it('search_path, уводящий имена без схемы в другую схему, — нарушение; путь к public и сброс — чисто', () => {
    const moved =
      '0001_m.sql: search_path без public первым — имена без схемы сервер разрешает не в public, а гейт читает их как public; пишите схему явно';
    expect(check(['CREATE SCHEMA shadow;', 'SET search_path TO shadow;', INIT], 'SELECT 1;')).toEqual([
      moved.replace('0001', '0002'),
    ]);
    expect(check(["SELECT set_config('search_path', 'shadow', false);"])).toEqual([moved]);
    expect(check(['ALTER DATABASE app SET search_path = shadow, public;'])).toEqual([moved]);
    expect(check(['ALTER ROLE app IN DATABASE app SET search_path TO shadow;'])).toEqual([moved]);
    expect(
      check([
        'SET search_path TO public;',
        'SET LOCAL search_path = "$user", public;',
        'SET search_path TO public, extensions;',
        'RESET search_path;',
        'SET search_path TO DEFAULT;',
      ]),
    ).toEqual([]);
  });

  it('GRANT EXECUTE на функции чтения файлов сервера — нарушение; на свою функцию — чисто', () => {
    const file = (name: string): string =>
      `0001_m.sql: GRANT EXECUTE ON ${name} — функция чтения файлов сервера читает файлы таблиц мимо RLS`;
    expect(check(['GRANT EXECUTE ON FUNCTION pg_read_binary_file(text) TO app;'])).toEqual([
      file('pg_read_binary_file'),
    ]);
    expect(check(['GRANT ALL ON FUNCTION pg_catalog.lo_import(text), now() TO app;'])).toEqual([
      file('lo_import'),
    ]);
    expect(check(['GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_catalog TO app;'])).toEqual([
      file('ALL FUNCTIONS IN SCHEMA pg_catalog'),
    ]);
    expect(
      check([
        "CREATE FUNCTION now_utc() RETURNS timestamptz LANGUAGE sql AS 'SELECT now()';",
        'GRANT EXECUTE ON FUNCTION now_utc() TO app;',
        'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app;',
      ]),
    ).toEqual([]);
  });

  it('CREATEROLE — нарушение (ниже Postgres 16 выдаёт членство в любой роли); NOCREATEROLE — чисто', () => {
    expect(check(['CREATE ROLE admins NOLOGIN CREATEROLE;', 'ALTER ROLE app WITH CREATEROLE;'])).toEqual([
      '0001_m.sql: роль с CREATEROLE — ниже Postgres 16 выдаёт себе членство в любой роли без суперправ (в том числе в роль сквозного доступа)',
      '0002_m.sql: роль с CREATEROLE — ниже Postgres 16 выдаёт себе членство в любой роли без суперправ (в том числе в роль сквозного доступа)',
    ]);
    expect(check(['CREATE ROLE readers NOLOGIN NOCREATEROLE;'])).toEqual([]);
  });
});
