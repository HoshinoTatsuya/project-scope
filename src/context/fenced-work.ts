import { CLIENT_MISUSE, TransactionClientMisuseError } from '@hoshinotatsuya/pg-runtime';
import type { PoolClient } from 'pg';

/**
 * Работа вызывающего и проверка после неё на одном соединении транзакции. Как
 * только работа вернулась (успехом или отказом), её запросы — отказ
 * `TransactionClientMisuseError` (как у pg-runtime после конца работы): иначе
 * запрос, отложенный работой (`setImmediate`, незаждённый промис), попал бы в
 * транзакцию между её концом и проверкой — после сверки контекста, до COMMIT.
 *
 * Запросы работы идут и через сырое соединение, и через `tx` drizzle — оба
 * через одно соединение, поэтому закрывается сам его метод `query` (своё
 * свойство экземпляра поверх метода прототипа) и возвращается в прежнее
 * состояние до выхода: COMMIT pg-runtime шлёт уже без него. Проверка после
 * работы идёт тем же соединением pg-runtime (под пулером — через его фильтр):
 * она только читает параметры, а сессионные значения сбрасывает сам pg-runtime
 * (`resetAppSettings`).
 */
export async function fencedWork<T>(
  client: PoolClient,
  work: () => Promise<T>,
  afterWork: (query: PoolClient['query']) => Promise<void>,
): Promise<T> {
  const target = client as unknown as { query: unknown };
  const send = client.query.bind(client) as PoolClient['query'];
  const hadOwn = Object.hasOwn(client, 'query');
  const previous = hadOwn ? target.query : undefined;
  let open = true;
  target.query = (...args: unknown[]): unknown => {
    if (!open) {
      throw new TransactionClientMisuseError(CLIENT_MISUSE.afterEnd);
    }
    return (send as (...inner: unknown[]) => unknown)(...args);
  };
  try {
    const result = await work();
    open = false;
    await afterWork(send);
    return result;
  } finally {
    open = false;
    if (hadOwn) {
      target.query = previous;
    } else {
      delete target.query;
    }
  }
}
