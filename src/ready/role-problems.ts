import type { PoolClient } from 'pg';

import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { SERVER_FILE_FUNCTIONS } from '../constants/server-file-functions.constant';
import { SERVER_FILE_ROLES } from '../constants/server-file-roles.constant';
import type { ProjectScope } from '../types/project-scope.type';
import type { RoleFacts } from '../types/role-facts.type';
import type { ScopeProblem } from '../types/scope-problem.type';
import { reachableRolesSql } from './reachable-roles-sql';

/**
 * Роли сессии: суперпользователь и BYPASSRLS политики не проходят; REPLICATION
 * читает строки всех областей слотом логического декодирования; роль, входящая
 * в такую (в роль сквозного доступа, во встроенную роль доступа к файлам и
 * программам сервера), снимает изоляцию одним `SET ROLE` или
 * `COPY … FROM PROGRAM`; CREATEROLE на Postgres ниже 16 выдаёт членство в
 * любой роли без суперправ; EXECUTE на функции чтения файлов сервера
 * (`SERVER_FILE_FUNCTIONS`) читает файлы таблиц.
 *
 * Проверяются ОБЕ роли — `current_user` и `session_user`: вход под одной ролью
 * с `ALTER ROLE вход SET role = приложение` даёт сессию, где запросы идут под
 * ролью приложения, а `SET ROLE NONE` возвращает к роли входа со всеми её
 * атрибутами.
 *
 * Запрос идёт на соединении ВНЕ транзакции: заданный там контекст области — это
 * сессионный SET или `ALTER ROLE/DATABASE … SET`, и тогда запрос «без
 * контекста» видит область.
 */
export async function roleProblems(client: PoolClient, scope: ProjectScope): Promise<ScopeProblem[]> {
  const { rows } = await client.query<RoleFacts>(
    `SELECT r.rolname::text AS role, r.rolname = current_user AS current, r.rolname = session_user AS session,
            r.rolsuper AS superuser, r.rolbypassrls AS bypass, r.rolreplication AS replication,
            (r.rolcreaterole AND current_setting('server_version_num')::int < 160000) AS createrole,
            ARRAY(SELECT m.rolname::text FROM pg_roles m
                   WHERE m.oid <> r.oid
                     AND (m.rolsuper OR m.rolbypassrls OR m.rolreplication OR m.rolname = ANY($3::text[])
                          OR (m.rolcreaterole AND current_setting('server_version_num')::int < 160000))
                     AND m.oid IN (${reachableRolesSql('(VALUES (r.oid))')})
                   ORDER BY m.rolname) AS escalations,
            ARRAY(SELECT DISTINCT p.oid::regprocedure::text FROM pg_proc p
                   WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($4::text[])
                     AND EXISTS (SELECT 1 FROM pg_roles x
                                  WHERE x.oid IN (${reachableRolesSql('(VALUES (r.oid))')})
                                    AND has_function_privilege(x.oid, p.oid, 'EXECUTE'))
                   ORDER BY 1) AS file_functions,
            (SELECT m.oid IN (${reachableRolesSql('(VALUES (r.oid))')}) FROM pg_roles m WHERE m.rolname = $1) AS maintenance,
            current_setting($2, true) AS context, current_setting($5, true) AS reason
       FROM pg_roles r WHERE r.rolname IN (current_user, session_user)
      ORDER BY r.rolname = current_user DESC`,
    [
      scope.maintenanceRole,
      scope.setting,
      [...SERVER_FILE_ROLES],
      [...SERVER_FILE_FUNCTIONS],
      scope.reasonSetting,
    ],
  );
  if (!rows.some((facts) => facts.current === true) || !rows.some((facts) => facts.session === true)) {
    return [{ code: SCOPE_PROBLEM.undetermined, table: null, detail: 'роль сессии не найдена в pg_roles' }];
  }
  const problems: ScopeProblem[] = [];
  const add = (code: ScopeProblem['code'], detail: string): void => {
    problems.push({ code, table: null, detail });
  };
  for (const facts of rows) {
    const who =
      facts.current === true
        ? `роль «${facts.role}»`
        : `роль входа «${facts.role}» (session_user; SET ROLE NONE возвращает к ней)`;
    if (facts.superuser !== false) {
      add(SCOPE_PROBLEM.superuser, `${who} — суперпользователь: RLS к ней не применяется`);
    }
    if (facts.bypass !== false) {
      add(SCOPE_PROBLEM.bypassRls, `${who} с BYPASSRLS`);
    }
    // Суперпользователю pg_has_role отвечает «да» на любую роль: членства — шум рядом с главной причиной.
    const memberships = facts.superuser === false;
    if (memberships && !Array.isArray(facts.escalations)) {
      add(SCOPE_PROBLEM.undetermined, `${who}: членство в ролях не прочиталось`);
    } else if (memberships && facts.escalations.length > 0) {
      add(
        SCOPE_PROBLEM.escalation,
        `${who} входит в ${facts.escalations.join(', ')} (суперправа, BYPASSRLS, REPLICATION, CREATEROLE ниже Postgres 16 или доступ к файлам и программам сервера): изоляция снимается одной командой`,
      );
    }
    if (memberships && facts.createrole !== false) {
      add(
        SCOPE_PROBLEM.escalation,
        `${who} с CREATEROLE на Postgres ниже 16: выдаёт себе членство в любой роли без суперправ (в том числе в роль сквозного доступа)`,
      );
    }
    if (memberships && facts.replication !== false) {
      add(
        SCOPE_PROBLEM.escalation,
        `${who} с REPLICATION: слот логического декодирования отдаёт строки всех областей`,
      );
    }
    if (memberships && !Array.isArray(facts.file_functions)) {
      add(SCOPE_PROBLEM.undetermined, `${who}: права на функции чтения файлов не прочитались`);
    } else if (memberships && facts.file_functions.length > 0) {
      add(
        SCOPE_PROBLEM.escalation,
        `${who} может исполнять ${facts.file_functions.join(', ')}: чтение файлов сервера (в том числе файлов таблиц) мимо RLS`,
      );
    }
    if (memberships && scope.maintenanceRole !== null && facts.role === scope.maintenanceRole) {
      add(SCOPE_PROBLEM.maintenanceRole, `${who} — роль сквозного доступа`);
    } else if (memberships && facts.maintenance === true) {
      add(
        SCOPE_PROBLEM.memberOfMaintenanceRole,
        `${who} входит в роль сквозного доступа «${scope.maintenanceRole}»`,
      );
    }
  }
  const context = rows[0]?.context ?? null;
  if (context !== null && context !== '') {
    // Значение области в отказ не попадает: текст отказа уходит в логи.
    add(
      SCOPE_PROBLEM.contextOutsideTransaction,
      `${scope.setting} задан вне транзакции (длина ${context.length}): запрос без контекста видел бы эту область`,
    );
  }
  const reason = rows[0]?.reason ?? null;
  if (reason !== null && reason !== '') {
    add(
      SCOPE_PROBLEM.contextOutsideTransaction,
      `${scope.reasonSetting} задан вне транзакции (сессионный SET, ALTER ROLE/DATABASE … SET; длина ${reason.length}): каждая работа withScope откажет ScopeConflictError, а триггер аудита читал бы причину без сквозного доступа`,
    );
  }
  return problems;
}
