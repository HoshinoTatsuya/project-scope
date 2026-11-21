import { deepFreeze } from '../deep-freeze';

/** Причины отказа `assertScopeReady`: каждая — отдельный способ, которым изоляция не действует. */
export const SCOPE_PROBLEM = {
  /** Суперпользователь обходит RLS целиком, FORCE на него не действует. */
  superuser: 'superuser',
  /** Атрибут BYPASSRLS: политики не применяются. */
  bypassRls: 'bypass-rls',
  /**
   * Роль (текущая или роль входа) — с REPLICATION, входит в роль с суперправами,
   * BYPASSRLS, REPLICATION или во встроенную роль доступа к файлам и программам
   * сервера (`pg_execute_server_program`, `pg_read_server_files`,
   * `pg_write_server_files`), или может исполнять функции чтения файлов сервера
   * (`pg_read_binary_file`, `lo_import`…): слот логического декодирования,
   * `SET ROLE`, `COPY … FROM PROGRAM` или чтение файла таблицы снимают изоляцию.
   */
  escalation: 'escalation',
  /** Сессия открыта под ролью сквозного доступа. */
  maintenanceRole: 'maintenance-role',
  /** Роль приложения входит в роль сквозного доступа. */
  memberOfMaintenanceRole: 'member-of-maintenance-role',
  /**
   * Параметр области или причины сквозного доступа задан вне транзакции
   * (сессионный SET, ALTER ROLE/DATABASE … SET): запрос «без контекста» видел
   * бы область, а причина ломает каждую работу области.
   */
  contextOutsideTransaction: 'context-outside-transaction',
  tableMissing: 'table-missing',
  /** Колонки области нет или её тип не тот, что объявлен. */
  columnMismatch: 'column-mismatch',
  rlsDisabled: 'rls-disabled',
  /** RLS без FORCE: владелец таблицы её не проходит. */
  rlsNotForced: 'rls-not-forced',
  /** Роль — владелец таблицы без FORCE: изоляции для неё нет прямо сейчас. */
  ownerWithoutForce: 'owner-without-force',
  policyMissing: 'policy-missing',
  /** Политика области есть, но не та: выражение, команда, роли или вид. */
  policyMismatch: 'policy-mismatch',
  /** Другая разрешающая политика действует на роль: политики складываются через OR и расширяют доступ. */
  foreignPolicy: 'foreign-policy',
  /**
   * Таблица с колонкой области (обычная, секционированная, внешняя) не в списке
   * области и не секция/наследник таблицы списка: её строки не изолированы.
   */
  unlistedTable: 'unlisted-table',
  /**
   * Предок по наследованию таблицы области вне защиты: запрос к нему читает и
   * меняет строки наследников по его политикам, TRUNCATE проверяет права только
   * у него.
   */
  inheritanceAncestor: 'inheritance-ancestor',
  /** Материализованное представление над данными области: у него нет RLS, REFRESH выносит строки мимо политик. */
  materializedView: 'materialized-view',
  /** Представление над данными области без `security_invoker = true`: политики применяются к его владельцу. */
  viewNotInvoker: 'view-not-invoker',
  /** Правило (CREATE RULE) на данных области: действие исполняется правами владельца таблицы правила. */
  rewriteRule: 'rewrite-rule',
  /**
   * Внешний ключ на таблицу области без пары колонок области (проверка ключа и
   * каскады идут мимо RLS — другая область меняет и удаляет строки, а вставка
   * отвечает, есть ли чужая строка), или каскад в таблицу области из ОБЩЕЙ
   * таблицы, которую роль сессии может менять.
   */
  foreignKeyAcrossScopes: 'foreign-key-across-scopes',
  /** Право TRUNCATE на таблицу области: TRUNCATE не проходит политики и стирает все области. */
  truncatePrivilege: 'truncate-privilege',
  /** Колонка области с недетерминированной колацией: `acme` и `ACME` — одна область для сравнения. */
  nondeterministicCollation: 'nondeterministic-collation',
  /**
   * Функция или процедура SECURITY DEFINER, до которой сессия дотягивается
   * (EXECUTE, триггер на таблице, которую она меняет, событийный триггер), а
   * владелец обходит политики области: суперпользователь, BYPASSRLS, член такой
   * роли, роль сквозного доступа или член её. Тело исполняется правами
   * владельца и видит строки всех областей.
   */
  securityDefiner: 'security-definer',
  /**
   * Функция, до которой сессия дотягивается, задаёт параметр области или
   * причины в своём определении (`CREATE FUNCTION … SET app.project_id = …`):
   * внутри неё запросы видят другую область, а сверка контекста к концу
   * работы этого не видит.
   */
  routineSetsScope: 'routine-sets-scope',
  /**
   * Функция LEAKPROOF вне `pg_catalog`, которую сессия может вызвать:
   * планировщик применяет её условие ДО политик, на строках всех областей, и
   * всё, что она выдаёт (ошибка, notice), выносит чужие значения.
   */
  leakproofFunction: 'leakproof-function',
  /**
   * Сопоставление пользователя внешнего сервера для роли сессии или PUBLIC:
   * внешняя таблица этого сервера читает данные под ролью сопоставления, а не
   * под политиками сессии (в том числе таблицы области этой же базы).
   */
  userMapping: 'user-mapping',
  /** Проверку не удалось выполнить: «не смог определить» — отказ, а не пропуск. */
  undetermined: 'undetermined',
} as const;

deepFreeze(SCOPE_PROBLEM);
