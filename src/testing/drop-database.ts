import type { Client } from 'pg';

/**
 * Удаление базы набора после того, как её пулы закрыты.
 *
 * `pool.end()` из pg-pool резолвится, когда клиенты сняты с учёта пула, а не
 * когда закрыты их сокеты: бэкенд ещё жив, и на клиенте висит обработчик
 * 'error' пула. `DROP DATABASE … WITH (FORCE)` в это окно обрывает бэкенд
 * (57P01), пул передаёт ошибку в своё 'error' без слушателя — и падает процесс
 * jest посреди чужого теста. Замер на Postgres 15: 54 из 60 циклов
 * «end → DROP FORCE» падали без ожидания, 0 из 60 — с ним.
 *
 * Поэтому сначала ждём, пока у базы не останется клиентских бэкендов;
 * FORCE остаётся для соединений, которые действительно никто не закрыл.
 */
export const dropDatabase = async (admin: Client, name: string, waitMs = 2000): Promise<void> => {
  const until = Date.now() + waitMs;
  for (;;) {
    const { rows } = await admin.query<{ open: number }>(
      `SELECT count(*)::int AS open FROM pg_stat_activity
        WHERE datname = $1 AND backend_type = 'client backend' AND pid <> pg_backend_pid()`,
      [name],
    );
    if ((rows[0]?.open ?? 0) === 0 || Date.now() >= until) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
};
