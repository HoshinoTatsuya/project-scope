import type { Pool, PoolClient } from 'pg';

import { SCOPE_READY_LIMITS } from '../constants/scope-ready-limits.constant';
import { ScopeNotReadyError } from '../errors/scope-not-ready.error';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeProblem } from '../types/scope-problem.type';
import type { ScopeReadyOptions } from '../types/scope-ready-options.type';
import { collectProblems } from './collect-problems';
import { undeterminedProblem } from './undetermined-problem';

/**
 * Проверка на старте: изоляция области ДЕЙСТВУЕТ для роли этого пула. Отказ —
 * `ScopeNotReadyError` с перечнем ВСЕХ причин (`SCOPE_PROBLEM`), а не первой:
 * - роли сессии (`current_user` и `session_user`): не суперпользователь, без
 *   BYPASSRLS, не входит в роль с ними, во встроенные роли доступа к файлам и
 *   программам сервера и в роль сквозного доступа; контекст вне транзакции пуст;
 * - один проход по каталогу — всё, что касается данных области
 *   (`catalogProblems`): таблицы списка с секциями и наследниками, таблицы с
 *   колонкой области вне списка, представления и материализованные
 *   представления над ними, внешние ключи, правила, право TRUNCATE.
 * Запрос, который не выполнился или не уложился в `timeoutMs`, — причина
 * `undetermined`: «не смог проверить» — отказ, а не пропуск.
 *
 * Пул — тот, под чьей ролью работает приложение (`db.$client`).
 */
export async function assertScopeReady(
  pool: Pool,
  scope: ProjectScope,
  options: ScopeReadyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SCOPE_READY_LIMITS.DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > SCOPE_READY_LIMITS.MAX_TIMEOUT_MS) {
    throw new Error(
      `assertScopeReady: timeoutMs — целое число миллисекунд от 1 до ${SCOPE_READY_LIMITS.MAX_TIMEOUT_MS}, получено ${String(timeoutMs)}`,
    );
  }
  // Соединения проверки: по потолку они уничтожаются, а не возвращаются в пул
  // посреди запроса. Выданное пулом после потолка — тоже.
  //
  // Пока соединение выдано, pg-pool своего обработчика 'error' на нём не держит:
  // обрыв сервером между запросами (pg_terminate_backend, idle_session_timeout,
  // рестарт) давал необработанное 'error' — процесс падал на старте. Здесь
  // обработчик стоит всё время выдачи и запоминает обрыв; возврат в пул с ним —
  // уничтожение соединения, а не отдача сломанного следующему.
  const held = new Map<PoolClient, { readonly onError: (error: Error) => void; broken?: Error }>();
  let expired = false;
  const acquire = async (from: Pool): Promise<PoolClient> => {
    const client = await from.connect();
    if (expired) {
      client.release(new Error('assertScopeReady: потолок проверки истёк'));
      throw new Error('потолок проверки истёк');
    }
    const entry: { readonly onError: (error: Error) => void; broken?: Error } = {
      onError: (error) => {
        entry.broken ??= error;
      },
    };
    client.on('error', entry.onError);
    held.set(client, entry);
    return client;
  };
  const release = (client: PoolClient, broken?: Error): void => {
    const entry = held.get(client);
    if (entry === undefined) {
      return;
    }
    held.delete(client);
    client.off('error', entry.onError);
    client.release(broken ?? entry.broken);
  };
  const checks = collectProblems(pool, scope, options, acquire, release);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let problems: ScopeProblem[] | null;
  try {
    problems = await Promise.race([checks, deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (problems === null) {
    expired = true;
    checks.catch(() => undefined);
    for (const client of [...held.keys()]) {
      release(client, new Error('assertScopeReady: потолок проверки истёк'));
    }
    problems = [
      undeterminedProblem(
        null,
        'проверка',
        new Error(`не уложилась в ${timeoutMs} мс (соединение пула, блокировка)`),
      ),
    ];
  }
  if (problems.length > 0) {
    throw new ScopeNotReadyError(problems);
  }
}
