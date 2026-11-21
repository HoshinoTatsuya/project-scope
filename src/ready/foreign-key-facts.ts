import type { PoolClient } from 'pg';

import type { ForeignKeyFacts } from '../types/foreign-key-facts.type';

/**
 * Внешние ключи, ссылающиеся на отношения `oids`. Ключи-копии на секциях
 * (`conparentid <> 0`) — не отдельные: судится ключ, который объявлен.
 * «В паре» — колонка области ссылающейся таблицы стоит в ключе на той же
 * позиции, что колонка области родителя: тогда строка может сослаться только
 * на строку своей области, и каскад меняет только строки той же области.
 */
export async function foreignKeyFacts(
  client: PoolClient,
  column: string,
  oids: readonly string[],
): Promise<ForeignKeyFacts[]> {
  const { rows } = await client.query<ForeignKeyFacts>(
    `SELECT con.conname::text AS name, con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
            EXISTS (SELECT 1 FROM unnest(con.conkey, con.confkey) AS k(c, p)
                      JOIN pg_attribute ac ON ac.attrelid = con.conrelid AND ac.attnum = k.c
                      JOIN pg_attribute ap ON ap.attrelid = con.confrelid AND ap.attnum = k.p
                     WHERE ac.attname = $1 AND ap.attname = $1) AS paired
       FROM pg_constraint con
      WHERE con.contype = 'f' AND con.conparentid = 0 AND con.confrelid = ANY($2::oid[])
      ORDER BY child, name`,
    [column, [...oids]],
  );
  return rows;
}
