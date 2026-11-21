import { splitSqlStatements } from './split-sql-statements';

describe('splitSqlStatements', () => {
  it('делит по ; верхнего уровня, вырезает комментарии, маскирует строки и тела', () => {
    const statements = splitSqlStatements(`
      -- ALTER TABLE items FORCE ROW LEVEL SECURITY;
      /* вложенный /* комментарий */ ; ещё */
      CREATE TABLE items ("project_id" uuid, note text DEFAULT 'a;b');
      DO $$ BEGIN PERFORM 1; END $$;
      SELECT E'x\\';y', $tag$ ; $tag$
    `);
    expect(statements).toEqual([
      {
        text: `CREATE TABLE items ("project_id" uuid, note text DEFAULT 'a;b')`,
        masked: `CREATE TABLE items ("project_id" uuid, note text DEFAULT '')`,
      },
      { text: 'DO $$ BEGIN PERFORM 1; END $$', masked: 'DO $body$' },
      { text: `SELECT E'x\\';y', $tag$ ; $tag$`, masked: `SELECT E'', $body$` },
    ]);
  });

  it('параметр $1 — не тело; незакрытые строка, идентификатор, тело и комментарий — исключение', () => {
    expect(splitSqlStatements('SELECT $1')).toEqual([{ text: 'SELECT $1', masked: 'SELECT $1' }]);
    for (const broken of ["SELECT 'x", 'SELECT "x', 'DO $$ x', 'SELECT 1 /* x']) {
      expect(() => splitSqlStatements(broken)).toThrow(/незакрыт/);
    }
  });

  it('тело BEGIN ATOMIC … END функции и процедуры — один оператор (как у psql и сервера), CASE … END внутри не закрывает тело', () => {
    const texts = (sql: string): string[] => splitSqlStatements(sql).map((statement) => statement.text);
    expect(
      texts(`
        CREATE FUNCTION f() RETURNS bigint LANGUAGE sql SECURITY DEFINER
        BEGIN ATOMIC
          SELECT 1;
          SELECT CASE WHEN true THEN count(*) END FROM items;
        END;
        CREATE OR REPLACE PROCEDURE p() BEGIN ATOMIC DELETE FROM items; END;
        CREATE TABLE t (id int);
      `),
    ).toEqual([
      'CREATE FUNCTION f() RETURNS bigint LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN count(*) END FROM items; END',
      'CREATE OR REPLACE PROCEDURE p() BEGIN ATOMIC DELETE FROM items; END',
      'CREATE TABLE t (id int)',
    ]);
    // Двойники: BEGIN транзакции, параметр с именем begin, CASE … END вне тела — делятся как прежде.
    expect(texts('BEGIN; CREATE TABLE a (x int); END; COMMIT;')).toEqual([
      'BEGIN',
      'CREATE TABLE a (x int)',
      'END',
      'COMMIT',
    ]);
    expect(
      texts(
        'CREATE FUNCTION g(begin int) RETURNS int LANGUAGE sql RETURN CASE WHEN begin > 0 THEN 1 END; CREATE TABLE b (y int);',
      ),
    ).toEqual([
      'CREATE FUNCTION g(begin int) RETURNS int LANGUAGE sql RETURN CASE WHEN begin > 0 THEN 1 END',
      'CREATE TABLE b (y int)',
    ]);
    // Функция с именем begin (сервер её принимает) — не тело; psql здесь склеил бы оператор с остатком.
    expect(
      texts('CREATE FUNCTION begin() RETURNS int LANGUAGE sql RETURN 1; CREATE TABLE c (z int);'),
    ).toEqual(['CREATE FUNCTION begin() RETURNS int LANGUAGE sql RETURN 1', 'CREATE TABLE c (z int)']);
    // В скобках — параметры: параметр begin типа atomic тела не открывает.
    expect(
      texts('CREATE FUNCTION k(begin atomic) RETURNS int LANGUAGE sql RETURN 1; CREATE TABLE d (w int);'),
    ).toEqual([
      'CREATE FUNCTION k(begin atomic) RETURNS int LANGUAGE sql RETURN 1',
      'CREATE TABLE d (w int)',
    ]);
    expect(texts(`CREATE FUNCTION h() RETURNS text LANGUAGE sql AS 'begin; end'; SELECT 1;`)).toEqual([
      `CREATE FUNCTION h() RETURNS text LANGUAGE sql AS 'begin; end'`,
      'SELECT 1',
    ]);
    // Незакрытое тело — не «операторов меньше», а отказ разбора.
    expect(() =>
      splitSqlStatements('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1;'),
    ).toThrow(/незакрыт/);
  });
});
