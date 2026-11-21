import { Client, Pool } from 'pg';

import { dropDatabase } from './drop-database';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const urlOf = (name: string): string => {
  const url = new URL(adminUrl as string);
  url.pathname = `/${name}`;
  return url.toString();
};

const exists = async (admin: Client, name: string): Promise<boolean> => {
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return rows.length > 0;
};

describeDb('dropDatabase [нужен PG_TEST_URL]', () => {
  let admin: Client;
  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  /**
   * Окно гонки — между резолвом `pool.end()` и закрытием сокетов, и оно тем
   * шире, чем больше соединений закрывается разом. Замер без ожидания на
   * Postgres 15, 20 циклов: пул из 5 — 0–2 обрыва, из 10 — 9–13. Поэтому пул
   * из 20: прогон без ожидания и без единого обрыва случайно не выходит.
   */
  it('закрытый пул и сразу удаление: сервер не оборвал ни одного соединения пула (20 циклов)', async () => {
    const terminated: unknown[] = [];
    for (let round = 0; round < 20; round++) {
      const name = `drop_race_${process.pid}_${round}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const pool = new Pool({ connectionString: urlOf(name), max: 20 });
      pool.on('error', (error) => terminated.push(error));
      await Promise.all(Array.from({ length: 20 }, () => pool.query('SELECT pg_sleep(0.005)')));
      // Контроль фикстуры: в окне есть что обрывать — пул держал двадцать соединений.
      expect(pool.totalCount).toBe(20);
      await pool.end();
      await dropDatabase(admin, name);
      expect(await exists(admin, name)).toBe(false);
    }
    // Сообщение FATAL доходит до клиента позже ответа на DROP.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminated).toEqual([]);
  });

  it('соединение, которое никто не закрыл, не держит базу: по истечении ожидания — FORCE', async () => {
    const name = `drop_leak_${process.pid}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const leaked = new Client({ connectionString: urlOf(name) });
    const errors: unknown[] = [];
    leaked.on('error', (error) => errors.push(error));
    await leaked.connect();
    try {
      await dropDatabase(admin, name, 100);
      expect(await exists(admin, name)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      // Без FORCE соединение осталось бы открытым и не дало бы jest завершиться.
      await leaked.end().catch(() => undefined);
    }
    // Контроль: соединение оборвал именно сервер (57P01), а не закрыл кто-то ещё.
    expect(errors[0]).toMatchObject({ code: '57P01' });
  });
});
