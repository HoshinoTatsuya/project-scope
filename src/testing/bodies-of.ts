import type { Pool } from 'pg';

/** Тела строк таблицы, видимые пулу без контекста и без транзакции. */
export const bodiesOf = async (pool: Pool, table: string): Promise<string[]> => {
  const { rows } = await pool.query<{ body: string }>(`SELECT body FROM ${table} ORDER BY body`);
  return rows.map((row) => row.body);
};
