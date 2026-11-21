# @hoshinotatsuya/project-scope

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/project-scope.svg)](https://www.npmjs.com/package/@hoshinotatsuya/project-scope)
[![CI](https://github.com/HoshinoTatsuya/project-scope/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/project-scope/actions/workflows/ci.yml)

[English](README.md) · [Изменения](CHANGELOG.md)

Изоляция данных по области — проекту, арендатору, организации (имя колонки и параметра настраивается) — на row-level security Postgres как **второй рубеж** поверх `WHERE project_id = …` в коде. Один забытый фильтр перестаёт быть утечкой чужих строк: запрос видит и пишет только строки области своей транзакции.

| Что | Чем |
|---|---|
| Политики для миграций: ENABLE + FORCE RLS, политика с USING и WITH CHECK (без контекста — ноль строк и отказ записи), политика роли сквозного доступа (все строки — только без контекста), отзыв TRUNCATE | `scopePolicySql(scope)`, для drizzle-kit — `scopePgPolicies(scope)` (вход `/drizzle`) |
| Контекст области только на транзакцию (`SET LOCAL`), вложенная другая область — отказ, смена контекста внутри работы — отказ и откат | `withScope(db, scope, id, work)` поверх `transactionKeepingFailure` из `@hoshinotatsuya/pg-runtime` |
| Сквозной доступ для обслуживающих задач — только отдельной ролью и с причиной | `withCrossScope(db, scope, { reason }, work)` |
| Проверка на старте — один проход по каталогу: всё, что касается данных области, а не только таблицы списка | `assertScopeReady(pool, scope, options?)` |
| Гейт покрытия схемы и миграций — функции, без раннера тестов | `evaluateScopeCoverage`, `schemaScopeViolations`, `migrationScopeViolations` (вход `/gate`) |
| Тот же гейт как спека jest | `scopeCoverageGate({ scope, schema, migrations })` (вход `/gate/jest`) |


## Установка

```sh
pnpm add @hoshinotatsuya/project-scope @hoshinotatsuya/pg-runtime drizzle-orm pg
pnpm add -D @types/pg   # необязательно, для TypeScript
```

Peer-зависимости: `@hoshinotatsuya/pg-runtime` `^0.7.1 || ^0.8.0 || ^0.9.0` (одна копия на процесс: вложенность транзакций распознаётся через неё), `drizzle-orm` `>=0.45.2 <0.46`, `pg` `^8.18.0`, `@jest/globals` `>=29` (необязательна, только для входа `/gate/jest`), `@types/pg` `>=8.15.0` (необязательна). Node.js ≥ 24, PostgreSQL 15–18.

Все примеры кода, помеченные как примеры, — файлы каталога [`examples/`](examples): `pnpm typecheck` проверяет их против исходников пакета и сверяет, что README цитирует их дословно. Пример ниже прогнан на Postgres 17 под ролью приложения без суперправ, владеющей таблицами: `assertScopeReady` проходит, `listDocuments` отдаёт строки только своего проекта, запрос БЕЗ `WHERE` внутри `withScope` — тоже только их, без контекста — ноль строк, `withCrossScope` под ролью приложения — `CrossScopeRefusedError`.

## Чего это НЕ делает

- **Не заменяет авторизацию.** RLS отделяет области друг от друга, но не знает, кто их просит. Что проект `id` принадлежит пользователю запроса (BOLA/IDOR), проверяет вызывающий — ДО `withScope(db, scope, id, …)`. Подставив в `withScope` идентификатор из URL без проверки, вы получите ровно ту утечку, от которой защищались, только аккуратно отфильтрованную.
- **Не заменяет `WHERE`.** Фильтр в запросе остаётся: он делает намерение явным и даёт планировщику то же условие. Политика ловит место, где его забыли.
- **Не защищает от владельца схемы и от умысла.** Роль, владеющая таблицей, может выполнить `ALTER TABLE … DISABLE ROW LEVEL SECURITY` или вернуть себе TRUNCATE. Строже всего, когда миграции выполняет одна роль, а приложение работает под другой (только GRANT на таблицы); если это одна роль, FORCE обязателен (пакет его ставит, `assertScopeReady` проверяет). Гейт миграций читает текст — это рубеж против ошибок, а не против умысла.
- **Не скрывает существование чужих строк через уникальность.** Уникальный ключ без колонки области (`id serial PRIMARY KEY`) отвечает области A, есть ли строка с таким ключом у области B: `INSERT` с чужим `id` — `23505`, `ON CONFLICT DO NOTHING` — `rowCount 0`. Изменить чужую строку через `ON CONFLICT DO UPDATE` нельзя (`42501`). Где существование — тайна, ключи — непредсказуемые (uuid) или с колонкой области. Внешние ключи между таблицами области — только парой колонок области (см. ниже), иначе они тот же оракул (`23503`) и каскады мимо RLS: это `assertScopeReady` и гейт ловят.
- **Код с правами владельца судится по владельцу, а не по телу.** `assertScopeReady` отказывает (`security-definer`), если сессия дотягивается до функции или процедуры `SECURITY DEFINER` — EXECUTE, триггер на таблице, которую она меняет (EXECUTE для триггера проверяется при `CREATE TRIGGER`, а не при срабатывании), событийный триггер — и её владелец обходит политики области: суперпользователь, BYPASSRLS, член такой роли, роль сквозного доступа или член её. Функция, владелец которой проходит те же политики (сама роль приложения, роль без обхода RLS), не судится: её тело видит ту же область, что и вызывающий. Но тело такой функции исполняется ПРАВАМИ владельца — если у владельца есть доступ, которого нет у сессии (таблица вне списка, материализованное представление), функция его отдаёт; это проверка не видит. Тела функций каталог не читает; гейт миграций читает текст (см. «Гейт покрытия»). Атрибуты владельца, которые для РОЛИ СЕССИИ — эскалация (`REPLICATION`, `CREATEROLE` ниже 16, встроенные роли файлов и программ сервера), для функции `SECURITY DEFINER` отказом не считаются: запросы её тела проходят политики области так же (проверено на сервере — `owner-rights.db.spec.ts`), а воспользоваться атрибутом может только тело, написанное для этого (`pg_read_file`, слот логического декодирования, `GRANT`), — такое тело гейт миграций видит по тексту, а каталог — нет.
- **Не покрывает обходы RLS самим Postgres вне каталога:** логическую репликацию и `pg_dump` под суперпользователем.
- **Не закрывает каналы, которые не проходят через строки таблиц области.** Ни проверка, ни гейт их не видят, и закрыть их проверкой нельзя — только устройством схемы:
  - **триггер-копия:** триггер роли приложения на таблице области, копирующий `NEW` в общую таблицу без колонки области, — область A читает там строки B (у владельца таблицы право TRIGGER есть всегда; то же — право TRIGGER на чужой таблице, поэтому оно и REFERENCES «доступом к строкам» не считаются);
  - **`pg_notify` из триггера** доставляет строки любой области всем слушателям канала;
  - **`pg_stat_activity`** показывает роли тексты запросов соседей ПОД ТОЙ ЖЕ ролью — литералы области B видны работе области A (передавайте значения параметрами, а не литералами; разные роли видят `<insufficient privilege>`);
  - **существование ключа** через `REFERENCES` и уникальность (см. выше).
- **Причина сквозного доступа — не подпись.** Внутри `withScope` и `withCrossScope` её подмена — отказ и откат, но запрос мимо них (сырой пул) задаёт любой параметр. Триггер аудита, кроме причины, проверяет роль: `current_user = '<роль сквозного доступа>'`.
- **Уборка соединения возвращает его к состоянию после connect — в пределах pg-runtime.** Без пулера после каждой транзакции области соединение чистится `resetSession` pg-runtime (нужен ≥ 0.7.0, базовая линия `connect` по умолчанию): временные таблицы, курсоры WITH HOLD, сессионные параметры работы снимаются, а параметры, роль и `LISTEN`, с которыми соединение пришло в первую транзакцию с уборкой, восстанавливаются тем же запросом. `SET search_path`, `TimeZone`, `application_name`, `work_mem` из `pool.on('connect')` переживают `withScope` и `withCrossScope`, параметры стартового пакета (`options`, `application_name`) и `ALTER ROLE … SET` — тоже (проверено, `isolation.db.spec.ts`). Пакет `sessionBaseline` не передаёт: изоляцию держит снятие состояния работы, а не то, к чему соединение возвращается. Опция pg-runtime проходит через `withScope`/`withCrossScope` как есть: `sessionBaseline: 'defaults'` — прежняя уборка к значениям по умолчанию сессии. Пределы pg-runtime 0.7.0:
  - **свои параметры (`app.*`), заданные `SET` на connect, не восстанавливаются** — Postgres не показывает их в `pg_settings`, и после первой транзакции области их нет (проверено тем же набором). Задавайте их стартовым пакетом (`options: '-c app.x=…'`), на роль (`ALTER ROLE … SET`) или на транзакцию (`localSettings`);
  - обработчик connect, оставляющий на соединении временную таблицу, курсор WITH HOLD или сессионный advisory-лок, — отказ pg-runtime в первой транзакции до работы (уборка сняла бы их безвозвратно);
  - **под PgBouncer в transaction mode уборки нет** (pg-runtime её запрещает), и базовая линия клиента — то, что пулер держит за ним: параметры, о которых сервер сообщает клиенту (`TimeZone`, `application_name`, `DateStyle`, …; `search_path` — с Postgres 18). Остальные `SET` обработчика connect (`search_path` ниже 18, `work_mem`, `SET ROLE`) остаются на том серверном соединении, где выполнились: их видит сосед по пулеру, а сам клиент в следующей транзакции может получить чужие значения. Под пулером такие параметры — на роль или базу (`ALTER ROLE/DATABASE … SET`) или на транзакцию.
- **Под пулером в transaction mode временные таблицы работы — только `ON COMMIT DROP`.** Без пулера соединение после каждой транзакции области чистится целиком; под пулером уборка после COMMIT ушла бы на чужое серверное соединение, и pg-runtime её запрещает. Вместо неё pg-runtime ≥ 0.7.0 отказывает сам: `CREATE TEMP TABLE` без `ON COMMIT DROP`, сессионный `SET`, `set_config(…, false)` в любой форме, курсор WITH HOLD — `PoolerIncompatibleError` до отправки; временная таблица, созданная в обход текста (`EXECUTE` в DO, функция), — `SessionStateLeakError` сверкой после транзакции, но уже ПОСЛЕ COMMIT (`committed: true`): таблица остаётся на серверном соединении, и её видит сосед (проверено, `pgbouncer.pooler.spec.ts`). Свои параметры (`app.*`) сверка pg-runtime не видит — параметр области и причину сквозного доступа, заданные в обход текста, снимает сброс в конце работы (`resetAppSettings` pg-runtime ≥ 0.7.1, ниже).
- **Postgres 15–18.** Набор проходит на 15, 16, 17 и 18; ниже 15 нет `security_invoker` представлений, и эти версии вне поддержки самого Postgres. Пулер в transaction mode проверен настоящим PgBouncer перед Postgres 15, 16, 17 и 18 (`pnpm test:pgbouncer`), горячая реплика — на 16, 17 и 18 (`pnpm test:replica`); Odyssey не проверялся.

## Как подключить

<!-- example: examples/scope.ts -->
```ts
import {
  assertScopeReady,
  defineProjectScope,
  SCOPE_COLUMN_TYPE,
  scopePolicySql,
  withCrossScope,
  withScope,
} from '@hoshinotatsuya/project-scope';
import { eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

// 1. The scope: which transaction setting carries the scope id, which column holds it, which tables it guards.
export const projectScope = defineProjectScope({
  setting: 'app.project_id', // transaction setting, `prefix.name`
  column: 'project_id', // the scope column in every listed table
  columnType: SCOPE_COLUMN_TYPE.uuid, // exactly the column type: uuid | text | varchar | bigint | integer
  tables: ['documents', 'comments'],
  maintenanceRole: 'app_maintenance', // optional: the only role allowed to see all scopes
});

// 2. Migration: ENABLE + FORCE RLS, the scope policy (USING and WITH CHECK), the maintenance policy,
// REVOKE TRUNCATE — for every table of the scope (or `{ tables: [...] }` for a new one).
export const migrationSql = [
  `CREATE TABLE documents (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL,
     title text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX documents_project_id_idx ON documents (project_id)',
  `CREATE TABLE comments (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL,
     document_id uuid NOT NULL,
     body text NOT NULL,
     UNIQUE (project_id, id)
   )`,
  'ALTER TABLE documents ADD UNIQUE (project_id, id)',
  // A foreign key between scope tables carries the scope column too, otherwise it bypasses RLS.
  'ALTER TABLE comments ADD FOREIGN KEY (project_id, document_id) REFERENCES documents (project_id, id)',
  scopePolicySql(projectScope),
].join(';\n');

const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 3. Startup: fail closed if the role, the catalog or the policies do not isolate the scope.
export const startup = async (pool: Pool): Promise<void> => {
  await assertScopeReady(pool, projectScope); // throws ScopeNotReadyError listing every problem
};

// 4. Requests: the scope id lives only for one transaction (SET LOCAL). Check that the user may access the
// project BEFORE this call — RLS separates scopes, it does not know who is asking.
export const listDocuments = (pool: Pool, projectId: string) =>
  withScope(drizzle(pool), projectScope, projectId, (tx) =>
    // The WHERE stays: the policy catches the place where it was forgotten.
    tx.select().from(documents).where(eq(documents.projectId, projectId)),
  );

// 5. Maintenance across all scopes: only through a pool opened under the maintenance role, with a reason.
export const purgeOldDocuments = (maintenancePool: Pool, before: Date) =>
  withCrossScope(
    drizzle(maintenancePool),
    projectScope,
    { reason: 'retention: delete documents older than 90 days' }, // 10-1000 visible characters
    (tx) => tx.delete(documents).where(lt(documents.createdAt, before)),
  );
```

Таблица, колонка и роль — простые идентификаторы в любом регистре (`"Document"`, `"projectId"` у Prisma): в SQL они всегда уходят в кавычках, и имя в описании — ровно имя в базе. `setting` — нижний регистр. `setting`, оканчивающийся на `_maintenance` или `_cross_reason`, — отказ: так называются производные имена другой области. Две области на одной таблице с совпавшим `policyName` (`app.a_b` и `app_a.b`) — отказ сервера при миграции (`42710`), а не тихая подмена.

**Миграция** (SQL-файл или кастомная миграция drizzle-kit):

`scopePolicySql(projectScope)` — все таблицы области (так в примере выше); `scopePolicySql(projectScope, { tables: ['documents'] })` — одна новая таблица (или секция, наследник таблицы области).

Для каждой таблицы:

```sql
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "scope_app_project_id" ON "documents" AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid)
  WITH CHECK ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid);
CREATE POLICY "scope_app_project_id_maintenance" ON "documents" AS PERMISSIVE FOR ALL TO "app_maintenance"
  USING (NULLIF(current_setting('app.project_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.project_id', true), '') IS NULL); -- только если задан maintenanceRole
REVOKE TRUNCATE ON "documents" FROM PUBLIC, CURRENT_USER;
```

Почему именно так:
- **`NULLIF(…, '')`.** `current_setting(…, true)` возвращает NULL, пока параметр в сессии не встречался, и `''` после того, как транзакция с ним закончилась. Оба значения сводятся к NULL, а `колонка = NULL` не истинно ни для одной строки: без контекста — ноль строк на чтении и отказ `42501` на записи, а не «всё». Сентинел «не задано» (NULL) не равен ни одному значению области.
- **WITH CHECK явно.** INSERT строки с чужим значением области и UPDATE, переносящий строку в чужую область, — отказ сервера.
- **FORCE.** Без него владелец таблицы политики не проходит, а роль приложения часто и есть владелец.
- **Одна разрешающая политика на роль.** Разрешающие политики складываются через OR: вторая (`USING (true)` «для отчётов») отменяет изоляцию. `assertScopeReady` отказывает, если на роль действует любая разрешающая политика, кроме политики области; гейт — если такая остаётся к концу истории миграций.
- **Роль сквозного доступа — все строки только БЕЗ контекста.** Её политика ложна, когда контекст области задан: та же роль внутри `withScope` видит одну область, а не все.
- **REVOKE TRUNCATE.** `TRUNCATE` политик не проходит: в работе одной области он стёр бы строки всех. Владелец может отозвать собственное право; остальные роли с `GRANT ALL` ловит `assertScopeReady` (`truncate-privilege`).
- **Наследование — только между таблицами области.** Предок без колонки области (`documents INHERITS (entity)`) читает и меняет строки наследников по СВОИМ политикам, а `TRUNCATE entity` проверяет права только у него: роль приложения не должна иметь к нему прав (`inheritance-ancestor`), гейт такую связь не пропускает.
- **Каскад из общей таблицы.** `docs.author_id REFERENCES users ON DELETE CASCADE`: удаление общей строки из работы области A удаляет строки всех областей. Общую таблицу с каскадом в таблицы области меняет роль сквозного доступа, а у роли приложения права на её изменение нет — иначе `foreign-key-across-scopes`.
- **Внешний ключ между таблицами области — парой колонок области:** `FOREIGN KEY (project_id, parent_id) REFERENCES parents (project_id, id)` (у родителя — `UNIQUE (project_id, id)`). Проверка ключа и каскады идут мимо RLS: ключ только по `parent_id` позволил бы области A каскадом менять и удалять строки B, а вставке B — узнавать, есть ли строка A.
- **Представление над таблицей области — `WITH (security_invoker = true)`**, иначе политики применяются к его владельцу. **Материализованных представлений над данными области нет:** у них нет RLS, и `REFRESH` в работе области сохраняет её строки для всех.

**drizzle-kit:** `pgTable('documents', {...}, () => scopePgPolicies(projectScope)).enableRLS()` — drizzle-kit сгенерирует политики и `ENABLE ROW LEVEL SECURITY`, но **не FORCE и не отзыв TRUNCATE**: допишите `ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;` и `REVOKE TRUNCATE ON "documents" FROM PUBLIC, CURRENT_USER;` в ту же миграцию. Пропуск FORCE ловят гейт и `assertScopeReady`, право TRUNCATE — `assertScopeReady`.

<!-- example: examples/drizzle-schema.ts -->
```ts
import { defineProjectScope, SCOPE_COLUMN_TYPE } from '@hoshinotatsuya/project-scope';
import { scopePgPolicies } from '@hoshinotatsuya/project-scope/drizzle';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const tenantScope = defineProjectScope({
  setting: 'app.tenant_id',
  column: 'tenant_id',
  columnType: SCOPE_COLUMN_TYPE.uuid,
  tables: ['invoices'],
});

// drizzle-kit generates the policies and ENABLE ROW LEVEL SECURITY, but NOT `FORCE ROW LEVEL SECURITY`
// and NOT `REVOKE TRUNCATE`: add both to the same migration by hand
//   ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
//   REVOKE TRUNCATE ON "invoices" FROM PUBLIC, CURRENT_USER;
// (the coverage gate and assertScopeReady catch a missing FORCE, assertScopeReady a TRUNCATE privilege).
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    number: text('number').notNull(),
  },
  () => scopePgPolicies(tenantScope),
).enableRLS();
```

**Работа с данными:**

Чтение и запись — `listDocuments` в примере выше: `withScope(db, projectScope, projectId, (tx) => …)`; принадлежность проекта пользователю — проверить ДО этого вызова.


- значение уходит `set_config('app.project_id', id, true)` тем же запросом, что таймауты pg-runtime (`localSettings`) — на транзакцию, не на сессию: следующий владелец соединения пула (и сосед под PgBouncer/Odyssey в transaction mode) контекста не видит;
- значение проверяется по типу колонки до запроса: пустое, не uuid, вне диапазона `integer`/`bigint`, управляющие и невидимые символы (NUL, пробел нулевой ширины, BOM, заполнители вроде U+3164), одиночный суррогат UTF-16 (Node отправил бы его как U+FFFD, и `'a\ud800b'` с `'a\udc00b'` стали бы одной областью), пробел по краям, запись не в NFKC (разложенные, полноширинные символы) — отказ; типы тоже: значение — `ScopeId<тип колонки>`, для uuid, text и varchar — только строка (число отвергает компилятор); целое приводится к одной записи (`-0` → `0`), uuid — к нижнему регистру. Само значение в текст отказа не попадает (он уходит в логи);
- к концу работы, до COMMIT, контекст обязан остаться тем же, а причины сквозного доступа — не быть: работа (или вложенная работа), сменившая `app.project_id` или задавшая причину, получает `ScopeConflictError`, и транзакция откатывается вместе со своими `SET`. Затем, до COMMIT, сессионные значения обоих параметров сбрасывает pg-runtime (`resetAppSettings`, нужен ≥ 0.7.1) к значению по умолчанию сессии — тому, что видит свежая сессия: `set_config(…, false)` или `SET` из работы не достаётся следующему владельцу соединения. Сброс идёт и под `transactionPooler`: его шлёт сам pg-runtime, а та же форма из работы — по-прежнему `PoolerIncompatibleError`. Это единственное, что снимает значение, оставленное работой в обход фильтра (`EXECUTE` в DO, функция): своих параметров сверка pg-runtime не видит. Свои имена в `resetAppSettings` вызывающий передаёт как есть — пакет добавляет к ним параметры области. Запрос, отложенный работой (`setImmediate`, незаждённый промис), после её возврата — `TransactionClientMisuseError`, как у pg-runtime после конца работы: иначе он попал бы в транзакцию между проверкой и COMMIT. Без пулера после транзакции соединение чистится целиком (`resetSession`; `resetSession` — только `true`, `false` отвергают типы и рантайм; что это значит для параметров соединения — «Чего это НЕ делает»);
- вложенный `withScope` той же области на том же пуле — точка сохранения во внешней транзакции; на другом пуле — своя транзакция на своём соединении; другое значение (на любом пуле), другая область на том же пуле, сквозной доступ — `ScopeConflictError`;
- остальные опции — опции `transactionKeepingFailure` (`statementTimeoutMs`, `retry`, `transactionPooler`, …), кроме `nested`. В `localSettings` нельзя параметры области и причины (в любом регистре: Postgres имена параметров регистр не различает) и смену роли транзакции (`role`, `session_authorization`).

**Старт приложения:**

```ts
await assertScopeReady(pool, projectScope); // pool — тот, под чьей ролью работает приложение (db.$client)
await assertScopeReady(replicaPool, projectScope, { canonicalFrom: primaryPool, timeoutMs: 10_000 }); // опции — ScopeReadyOptions
```

Проверка судит не список, а **каталог**: один проход находит всё, что касается данных области, — таблицы списка, их секции и наследников (все уровни `pg_inherits`), их ПРЕДКОВ по наследованию, любую таблицу или представление с колонкой области в любой схеме (созданные мимо списка, в том числе `DO $$ … EXECUTE`), представления и материализованные представления над всем этим (рекурсивно через `pg_depend`, даже без колонки области), внешние ключи на защищённые таблицы, правила. Роли — обе: `current_user` и `session_user` (вход под одной ролью с `ALTER ROLE вход SET role = приложение`: `SET ROLE NONE` возвращает к роли входа). Отношение вне защиты не судится, только если ДОКАЗАНО, что оно недоступно: ни у одной роли, чьими правами сессия может воспользоваться (от `current_user` и `session_user`: наследование или `SET ROLE` — то есть и при NOINHERIT; с Postgres 16 членство `WITH INHERIT FALSE, SET FALSE` не даёт ни того, ни другого и не считается, а членство с ADMIN OPTION считается — им роль выдаёт себе `SET`), нет ни одного права на строки — чтения или записи — ни на таблицу, ни на её колонки (`GRANT SELECT (колонка)`). REFERENCES и TRIGGER строк не отдают и доступом не считаются (см. «Чего это НЕ делает»). Право TRUNCATE, политики «на роль» и членства в ролях с особыми атрибутами считаются по тем же ролям. Кроме отношений, судятся пути мимо таблиц: функции с правами владельца, параметр области в определении функции, LEAKPROOF вне `pg_catalog`, сопоставления пользователей внешних серверов. Представление без `security_invoker`, владелец которого — сама роль сессии, допустимо: оно проходит её же политики под FORCE.

Отказ — `ScopeNotReadyError` с полным перечнем причин (`problems: { code, table, detail }[]`, коды — `SCOPE_PROBLEM`):

| Код | Что не так |
|---|---|
| `superuser`, `bypass-rls` | текущая роль или роль входа обходит RLS целиком |
| `escalation` | роль с REPLICATION (слот логического декодирования отдаёт строки всех областей); роль с CREATEROLE на Postgres ниже 16 (выдаёт себе членство в любой роли без суперправ; с 16 — только в созданные ею); роль входит в роль с суперправами, BYPASSRLS, REPLICATION, CREATEROLE (ниже 16), во встроенную `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files`; роль может исполнять функции чтения файлов сервера (`pg_read_file`, `pg_read_binary_file`, `pg_stat_file`, `pg_ls_dir`, `lo_import`, `lo_export`) |
| `maintenance-role`, `member-of-maintenance-role` | пул открыт под ролью сквозного доступа или роль приложения в неё входит |
| `context-outside-transaction` | параметр области задан вне транзакции: сессионный `SET`, `ALTER ROLE/DATABASE … SET` — запрос «без контекста» видел бы область; причина сквозного доступа задана так же — каждая работа `withScope` падала бы `ScopeConflictError` |
| `table-missing`, `column-mismatch` | нет таблицы (или это не таблица — внешняя таблица RLS не поддерживает); нет колонки или тип не тот (сравнивается тип без длины: `varchar(64)` — `varchar`; домен — не тот тип) |
| `nondeterministic-collation` | колонка области с недетерминированной колацией: `acme` и `ACME` — одна область для сравнения |
| `rls-disabled`, `rls-not-forced`, `owner-without-force` | RLS выключен; нет FORCE (для владельца — изоляции нет прямо сейчас) |
| `policy-missing`, `policy-mismatch` | нет политики области; она (или политика сквозного доступа) не та: выражение отличается от эталона, не ALL, RESTRICTIVE, не на те роли |
| `foreign-policy` | на роль действует другая разрешающая политика |
| `truncate-privilege` | у роли сессии есть TRUNCATE на таблицу области |
| `unlisted-table` | таблица с колонкой области не в списке и не секция/наследник таблицы списка |
| `materialized-view` | материализованное представление над данными области |
| `view-not-invoker` | представление над данными области без `security_invoker = true`, владелец — не роль сессии |
| `inheritance-ancestor` | доступный предок по наследованию без колонки области |
| `foreign-key-across-scopes` | внешний ключ на таблицу области без пары колонок области; каскад (`CASCADE`, `SET NULL`, `SET DEFAULT`) в таблицу области из общей таблицы, которую роль сессии может менять |
| `rewrite-rule` | правило (`CREATE RULE`) на данных области — его действие исполняется правами владельца таблицы правила |
| `security-definer` | функция или процедура `SECURITY DEFINER` вне `pg_catalog`, до которой сессия дотягивается (EXECUTE, триггер на отношении, которое она меняет, событийный триггер), а владелец обходит политики: суперпользователь, BYPASSRLS, член такой роли, роль сквозного доступа или член её |
| `routine-sets-scope` | функция, до которой сессия дотягивается, задаёт параметр области или причины в своём определении (`CREATE FUNCTION … SET app.project_id = …`): внутри неё другая область, а сверка контекста к концу работы этого не видит |
| `leakproof-function` | функция LEAKPROOF вне `pg_catalog`, которую сессия может вызвать: её условие вычисляется ДО политик, на строках всех областей, и notice или ошибка выносят значения |
| `user-mapping` | сопоставление пользователя внешнего сервера для роли сессии или PUBLIC: внешняя таблица этого сервера читает данные под ролью сопоставления (в том числе таблицы области этой же базы); куда смотрит сервер, проверка не судит |
| `undetermined` | проверку не удалось выполнить или она не уложилась в `timeoutMs` — это отказ, а не «готово» |

Эталон выражений политик берётся у самого сервера: те же политики создаются на временной таблице в откатываемой транзакции `READ WRITE` и печатаются `pg_get_expr` — роли нужно право `TEMP` на базу (по умолчанию оно у PUBLIC). Пул с `default_transaction_read_only = on` проверку проходит; реплика в восстановлении не пишет вовсе — для неё эталон строится на основном: `canonicalFrom`. `canonicalFrom` — тот же пул — то же соединение (пул из одного соединения не ждёт сам себя). Потолок всей проверки — `timeoutMs` (по умолчанию 30 000, не больше 2^31−1: таймер Node дольше срабатывает сразу): занятый пул или блокировка каталога дают `undetermined`, соединение проверки уничтожается, а не возвращается в пул посреди запроса.

**Сквозной доступ** — для очистки, миграций данных, отчётов по всем проектам:

```sql
CREATE ROLE app_maintenance LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS; -- отдельный вход
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO app_maintenance;
```

Работа сквозного доступа — `purgeOldDocuments` в примере выше: `withCrossScope(maintenanceDb, projectScope, { reason }, (tx) => …)`.


Не флаг в запросе: политику «все строки» получает только роль `maintenanceRole`, и база обязана быть открыта под ней — под ролью приложения отказ `CrossScopeRefusedError` ДО работы (иначе задача «отработала» бы на пустом множестве). Политика роли действует только без контекста области: та же роль в `withScope` видит одну область. Причина (10–1000 символов, без NUL и одиночных суррогатов UTF-16) уходит в параметр транзакции `scope.reasonSetting` (`app.project_id_cross_reason`) — триггер аудита читает её `current_setting(…, true)` и сверяет `current_user`. Работа сквозного доступа, задавшая контекст области или подменившая причину, — `ScopeConflictError` и откат. Роль приложения не должна входить в роль сквозного доступа (`assertScopeReady`: `member-of-maintenance-role`).

**Гейт покрытия.** Вход `/gate` — функции без раннера тестов (сервис, CLI, vitest); вход `/gate/jest` — готовая спека jest:

<!-- example: examples/scope-coverage.spec.ts -->
```ts
// A jest spec in your project: the schema and every migration keep the scope covered.
import { join } from 'node:path';

import { MIGRATION_LAYOUT } from '@hoshinotatsuya/project-scope/gate';
import { scopeCoverageGate } from '@hoshinotatsuya/project-scope/gate/jest';

import * as schema from './drizzle-schema';
import { tenantScope } from './drizzle-schema';

scopeCoverageGate({
  scope: tenantScope,
  schema, // drizzle tables (the module's exports)
  migrations: join(__dirname, '../drizzle'), // the migrations directory
  migrationLayout: MIGRATION_LAYOUT.drizzle, // drizzle | flyway | golang-migrate | dbmate
  minSchemaTables: 1, // the selection must not degenerate: "0 violations" over 0 tables means nothing
  casing: 'snake_case', // the same `casing` as drizzle(pool, { casing })
});
```

- выборка не выродилась: таблиц схемы и миграций не меньше порогов, таблицы с колонкой области найдены (иначе «нарушений ноль» ничего не значит);
- **схема:** каждая таблица drizzle с колонкой области — в списке области, каждая таблица списка — в схеме с этой колонкой. Имя колонки — то, что уходит в SQL: с `casing` базы drizzle (`drizzle(pool, { casing })`) поле `projectId: uuid()` — это `project_id`. Поле без явного имени, которое колонкой области становится только при `casing`, без переданного `casing` — нарушение. Материализованное представление над данными области и представление над ними без `.with({ securityInvoker: true })` — нарушения, кроме записанных в `notScoped` с причиной (`.existing()` представление — объект вне миграций drizzle, его судит `assertScopeReady`). «Над данными области» — колонка области в выборке ИЛИ запрос представления читает таблицу области: `count(*) FROM items` колонки не выводит, а сводит строки всех областей. Запрос читается по объектам drizzle (таблица, подзапрос, другое представление схемы) и по тексту `sql\`…\`` (имена таблиц области и представлений схемы). Причина `notScoped` короче порога и ненужная запись — нарушения и при прямом вызове `schemaScopeViolations`; в покрытии запись «лишняя», только если не понадобилась ни схеме, ни миграциям, а короткая причина — одна строка;
- **состав и порядок миграций каталога — как у самого инструмента** (`migrationLayout`, `MIGRATION_LAYOUT`). Правила сверены с настоящими инструментами: фикстуры `src/testing/layout-oracle` применены golang-migrate 4.18.3, dbmate 2.38.1 и Flyway OSS 11.20.3 к Postgres (`scripts/layout-oracle.sh`), их ответы записаны в `answers.json`, и спека требует от гейта тех же путей в том же порядке:
  - `drizzle` — по `meta/_journal.json`; `when` записей обязан строго расти (мигратор drizzle-orm на существующей базе применяет только `when` больше последнего применённого — запись с меньшим пропускается молча, проверено настоящим мигратором); файл вне журнала — отказ; без журнала — каталоги `<время>_имя/migration.sql`;
  - `flyway` — всё дерево каталога; `V<версия>__` (префикс с учётом регистра, суффикс `.sql` в любом) по версии числами (`V2` раньше `V10`, `1.0` = `1` = `01` — повтор версии отказ, как у Flyway); `R__` — последними, по описанию (`_` → пробел, порядок строк Java); `U…` (откат) не применяется;
  - `golang-migrate` — только верхний уровень (подкаталоги не читает); `<номер>_<имя>.up.<любое расширение>` (`2_x.up.SQL`, `3_x.up.psql`, `4_x.up.sql.bak` — тоже миграции) по номеру; `1_` и `0001_` — одна версия, отказ;
  - `dbmate` — только верхний уровень; `<цифры>….sql` в порядке ИМЁН ФАЙЛОВ строкой (`10_` раньше `2_`), секция `-- migrate:up` (маркер с начала строки; без него или с операторами до него dbmate файл не применяет — отказ); одинаковые цифры — отказ.
  Раскладка не угадывается: есть журнал drizzle — она, иначе без `migrationLayout` — отказ, а не сортировка имён. Файл, похожий на миграцию (`.sql` в любом регистре или имя по шаблону раскладки), которого инструмент не применит, — отказ (гейт строже инструмента: колбэк Flyway `afterMigrate.sql`, `v2__…`, файл в подкаталоге у golang-migrate и dbmate); символическая ссылка на каталог — отказ. Другая раскладка — готовый список `MigrationFile[]` в порядке применения;
- **миграции**: миграция, в которой таблица получила колонку области (CREATE TABLE, ADD COLUMN, RENAME COLUMN, секция или наследник таблицы области), включает к своему концу ENABLE, FORCE и политику области; защита, бывшая полной, не снимается позже (DISABLE, NO FORCE, DROP POLICY без нового CREATE POLICY, ALTER POLICY, SET SCHEMA, переименование); политика области — ровно та, что строит пакет (предложения политики разбираются по тексту с литералами: эталон, спрятанный в литерал, не засчитывается); `ALTER POLICY … TO … USING … WITH CHECK`, `ALTER POLICY … RENAME TO …` и `DROP POLICY … CASCADE` (так их пишет drizzle-kit — проверено на выводе drizzle-kit 0.31.10, `src/testing/drizzle-kit-fixture`) меняют форму политики, и судится то, что получилось; к концу истории каждая таблица списка защищена, а таблиц с колонкой вне списка нет;
- **к концу истории** наследник таблицы области не наследует таблицу без колонки области; на таблице области нет чужой разрешающей политики и политики сквозного доступа не той формы; нет материализованного представления и представления без `security_invoker` над данными области; нет правила на них; внешний ключ на таблицу области — парой колонок области (без списка колонок родителя — по его первичному ключу из миграций). Всё это можно исправить поздней миграцией (DROP и CREATE заново);
- **сразу нарушение:** членство в роли сквозного доступа или встроенной роли доступа к файлам сервера (`GRANT`, `CREATE ROLE … IN ROLE`, `CREATE ROLE <она> ROLE/ADMIN/USER …`, `ALTER GROUP <она> ADD USER`), `BYPASSRLS`/`SUPERUSER`/`REPLICATION`/`CREATEROLE` роли (CREATEROLE — эскалация ниже Postgres 16, а версию сервера гейт не знает), `GRANT EXECUTE` на функции чтения файлов сервера (`pg_read_binary_file`, `lo_import`… или `ALL FUNCTIONS IN SCHEMA pg_catalog`), `SECURITY DEFINER` над таблицей области (`ALTER … SECURITY DEFINER` — всегда: тела не видно), `ALTER FUNCTION … OWNER TO` функции, созданной не в этих миграциях (исполняется ли она правами владельца над данными области, не определить) или функции `SECURITY DEFINER`, касающейся области, `search_path` без `public` первым (`SET`, `set_config`, `ALTER ROLE/DATABASE … SET`: имена без схемы сервер разрешает не туда, куда их читает гейт) и то, что разбор заведомо прочёл бы не так, как сервер: элементы `CREATE SCHEMA … CREATE TABLE`, `ROLLBACK`, смена `standard_conforming_strings`, `UESCAPE`;
- **к концу истории** функция `SECURITY DEFINER`, которая касается данных области через ДРУГИЕ функции миграций (в любом порядке создания: имя функции в тексте — вызов), или чьё тело не прочесть (динамический `EXECUTE`, язык кроме `sql` и `plpgsql`), — нарушение: «не определить» — отказ; `EXPLAIN ANALYZE` исполняет оператор, и `CREATE TABLE … AS` или `CREATE MATERIALIZED VIEW` под ним судятся как без него (просто `EXPLAIN` — нет);
- комментарии вырезаются (закомментированный FORCE не считается), литералы и тела `$$…$$` не читаются как SQL; юникодные имена `U&"proj\0065ct_id"` раскрываются так же, как на сервере; `CREATE TABLE IF NOT EXISTS` существующей таблицы её состояние не сбрасывает;
- `CREATE TABLE … AS`/`LIKE`/`OF тип` и `SELECT … INTO` разбор не понимает: такая таблица либо в списке области (тогда защита обязательна), либо в `notScoped` с причиной — иначе нарушение; `notScoped` принимает и материализованное представление (например, читаемое только ролью сквозного доступа);
- `adoptedLater: { таблица: причина }` — таблицы, созданные до пакета: защита в поздней миграции (см. «Перевод существующих таблиц»). Лишняя запись — нарушение. Длина причины допущений (`adoptedLater`, `notScoped`) и сквозного доступа — по ВИДИМЫМ знакам: пробелы нулевой ширины, BOM, заполнители (U+3164) и пробелы подряд её не набирают.
- Тело `BEGIN ATOMIC … END` функции и процедуры — часть своего оператора (как у psql и сервера): `SECURITY DEFINER` с таблицей области во втором операторе тела — нарушение. Незакрытое тело — «SQL не разобран». Секция при `RENAME`/`SET SCHEMA` (своём или родителя) остаётся секцией; `DETACH PARTITION` делает её самостоятельной таблицей (с колонкой области — в список или `notScoped`); `DROP TABLE` секционированной таблицы уносит секции. Журнал drizzle с BOM или не JSON — отказ с причиной (drizzle-orm на таком журнале тоже отказывает).

Предел гейта: тела `DO $$…$$` и динамический SQL не читаются. Таблицу или представление с колонкой области, созданные так, находит `assertScopeReady` проходом по каталогу; функции с правами владельца — он же, по владельцу.

## Цена

Замер `bench/policy-cost.cjs`: Postgres 17 (docker, ноутбук), таблица 1 000 000 строк, 1000 областей по 1000 строк, B-tree по `project_id`, роль приложения без суперправ; время исполнения сервера (`EXPLAIN ANALYZE`), 300 запросов со случайной областью.

| Запрос | План | Строк | Медиана, мс | p95, мс |
|---|---|---|---|---|
| **до**, RLS выключен: `count(*) WHERE project_id = $1` | Aggregate → Index Only Scan | 1 (из 1000) | 0.122 | 0.156 |
| **до**: страница 50 строк `WHERE project_id = $1 ORDER BY id` | Limit → Sort → Index Scan | 50 | 0.112 | 0.138 |
| **после**, политика + фильтр в запросе | Aggregate → Result → Index Only Scan | 1 | 0.160 | 0.238 |
| **после**, политика, WHERE ЗАБЫТ: `count(*)` | Aggregate → Index Only Scan | 1 | 0.112 | 0.146 |
| **после**, WHERE забыт: страница 50 строк | Limit → Sort → Index Scan | 50 | 0.106 | 0.133 |
| **после**, без контекста: `count(*)` | Aggregate → Index Only Scan (условие NULL) | 0 строк в счёте | 0.010 | 0.019 |

Выражение политики STABLE (`current_setting`) и становится условием индекса: запрос без `WHERE` идёт тем же индексным планом, что запрос с фильтром, — полного прохода по миллиону строк нет. Фильтр в запросе и политика вместе стоят ~0.04 мс на медиане (лишний узел Result с проверкой одного и того же условия). Без индекса по колонке области политика превратила бы каждый запрос в полный проход — индекс по ней (или ведущей колонкой составного) обязателен.

`withScope` и `withCrossScope` с 0.2.0 делают на один запрос больше (проверка контекста к концу работы, см. выше) — одно обращение к базе на транзакцию.

## Перевод существующих таблиц

Порядок важен: политика без контекста отдаёт ноль строк, поэтому код должен научиться задавать контекст РАНЬШЕ, чем включится RLS.

1. Колонка области в каждой таблице списка: `ADD COLUMN project_id uuid` → заполнить (пачками) → `SET NOT NULL` (на больших таблицах — через `CHECK … NOT VALID` и `VALIDATE`) → индекс `CREATE INDEX CONCURRENTLY` по колонке области (или ведущей колонкой составного). Внешние ключи между таблицами области — перевести на пары колонок области.
2. Код: весь доступ к таблицам области — в `withScope` (до включения RLS контекст ничего не меняет), обслуживающие задачи — `withCrossScope` под отдельной ролью. Роль сквозного доступа заводится и получает GRANT.
3. Миграция: `scopePolicySql(scope)` для этих таблиц. `ALTER TABLE … ENABLE/FORCE` и `CREATE POLICY` берут ACCESS EXCLUSIVE ненадолго — с `lock_timeout` и повтором, как любой DDL на горячей таблице. В гейте эти таблицы — в `adoptedLater` с причиной.
4. Старт: `assertScopeReady(pool, scope)` — после того, как миграция дошла до всех баз.

Откат — `ALTER TABLE … DISABLE ROW LEVEL SECURITY` (код с `withScope` продолжает работать).

## Проверка

- `pnpm test` — группы jest-groups на одноразовом Postgres 17 в docker (`scripts/with-postgres.sh`; в CI — сервис). Наборы с базой работают под РОЛЬЮ ПРИЛОЖЕНИЯ без суперправ и BYPASSRLS, которая ещё и владелец таблиц (самая строгая раскладка: без FORCE она политик не проходила бы). Отдельная проверка показывает, что под суперпользователем изоляция не проверяется (он видит все строки без контекста), и `assertScopeReady` это ловит. Набор каталога (`catalog.db.spec.ts`) строит каждый обход — таблицу через `DO $$`, материализованное представление с `REFRESH` в области, внешний ключ с каскадом, `TRUNCATE`, роль входа с BYPASSRLS, `pg_execute_server_program`, недетерминированную колацию, наследника, правило — и показывает и сам обход, и то, что проверка его называет.
- Тот же набор — на Postgres 15, 16 и 18 (`PG_TEST_IMAGE=postgres:15-alpine pnpm test`): CREATEROLE ниже 16 (в том числе через членство) проверяется настоящим сервером 15, членство без INHERIT и SET — 16+. Набор прав владельца (`owner-rights.db.spec.ts`) строит каждый обход настоящим — функцию `SECURITY DEFINER` суперпользователя, процедуру, функцию роли сквозного доступа, триггер и событийный триггер, параметр области в определении функции, LEAKPROOF с notice, внешнюю таблицу через сопоставление пользователя — и чистую базу с 30+ расширениями contrib, где отказа быть не должно.
- Раскладки миграций — по ответам самих инструментов: `scripts/layout-oracle.sh` (docker, внутренняя сеть) применяет фикстуры `src/testing/layout-oracle` golang-migrate, dbmate и Flyway к Postgres и записывает, что применено и в каком порядке; `read-migration-files.oracle.spec.ts` сверяет с этим гейт без docker. Журнал drizzle — настоящим мигратором drizzle-orm (`drizzle-journal.db.spec.ts`).
- Договор типов — `type-contract.spec.ts`: компилятор на `src/testing/type-contract/usage.ts` (число для uuid-области, `resetSession: false` — ошибки типов).
- `pnpm test:pgbouncer` — настоящий PgBouncer в transaction mode (`scripts/with-pgbouncer.sh`, одно серверное соединение на всех клиентов): соседи по соединению видят только свою область; `set_config(…, false)` параметром и литералом — отказ pg-runtime до отправки, в обход фильтра (`EXECUTE` в DO) — не доживает до соседа (сброс `resetAppSettings` pg-runtime); временная таблица без `ON COMMIT DROP` — отказ до отправки, в обход фильтра — `SessionStateLeakError` после COMMIT, и соседу она видна (поэтому под пулером только `ON COMMIT DROP`).
- `pnpm test:replica` — основной сервер и горячая реплика (`scripts/with-replica.sh`, потоковая репликация): на реплике эталон не построить — `undetermined`, с `canonicalFrom` основного — готово; `withScope` на реплике читает только свою область.
- Замёрзшая сеть (`FaultProxy` из `@hoshinotatsuya/fault-kit`) и блокировка каталога — потолок `timeoutMs`; внешняя таблица `postgres_fdw` — RLS не поддерживает, проверка это называет.
- `pnpm test:consumers` — собранный пакет в проектах commonjs, node16, nodenext, bundler+ESM, nodenext+ESM: tsc, рантайм входов (`/gate` — вне jest), ts-jest (`/gate/jest`).

Мутации (каждая — снятая правка, прогон своих спек):

| Дефект | Мутация (снятая правка) | Спека | Красных |
|---|---|---|---|
| внешний ключ мимо RLS | проверка «ключ в паре колонок области» в проходе по каталогу / в гейте | каталог / обходы гейта | 1 из 15 / 1 из 16 |
| материализованное представление, представление без `security_invoker`, цепочка представлений, правило | каждое снято в каталоге; в гейте; в гейте схемы | каталог / обходы гейта / гейт схемы | ≥ 1 каждая |
| `SELECT … INTO` | гейт не видит оператор | обходы гейта | 1 из 16 |
| таблица мимо списка (`DO $$`) | отношения с колонкой области не выбираются / фильтр «есть доступ» снят | каталог | 1 / 2 из 15 |
| TRUNCATE | нет проверки права / нет `REVOKE` в `scopePolicySql` | каталог / изоляция | 2 из 15 / 1 из 21 |
| `session_user` | проверяется только `current_user` / политика «на роль» — только для него | каталог | 1 / 1 из 15 |
| `pg_*_server_*` | встроенные роли не считаются эскалацией | каталог | ≥ 1 из 15 |
| недетерминированная колация | проверка снята | каталог | 1 из 15 |
| роль сквозного доступа в `withScope` | политика сквозного доступа `true`; её форма не сверяется в `assertScopeReady`; в гейте | изоляция / каталог / обходы гейта | 4 из 21 / 1 из 15 / 2 из 16 |
| `casing` drizzle | имя по ключу поля; без отказа на неоднозначность | гейт схемы | 1 / 1 из 5 |
| `/gate` тянет `@jest/globals` | `scopeCoverageGate` снова в `/gate` | входы вне jest | 1 из 4 |
| гейт миграций: чужая политика, текст целиком, `standard_conforming_strings`, ROLLBACK, элементы `CREATE SCHEMA`, UESCAPE, `U&"…"`, SET SCHEMA, GRANT, BYPASSRLS, SECURITY DEFINER, IF NOT EXISTS | каждое снято по отдельности | обходы гейта | 4 / 1 / 1 / 1 / 1 / 1 / 1 / 1 / 1 / 1 / 1 / 1 из 16 |
| сессионный `SET` в работе | сброс сессионных значений снят (`withScope` / `withCrossScope`) | изоляция / сквозной доступ | 1 из 21 / 1 из 7 |
| смена контекста и причины в работе | проверка контекста / причины снята; проверка в `withCrossScope` снята; транзакция с пойманной ошибкой | изоляция / сквозной доступ | 1 / 2 из 21 / 2 из 7 / 1 из 21 |
| `localSettings` | регистр имени / `role` и `session_authorization` не запрещены | изоляция | 1 / 1 из 21 |
| наследники | `pg_inherits` не обходится | каталог | 1 из 15 |
| пул только для чтения, реплика | `BEGIN` без `READ WRITE` / `canonicalFrom` не читается | каталог | 1 / 1 из 15 |
| имена производных от `setting` | суффиксы не запрещены | описание области | 2 из 15 |
| значение области | невидимые символы / `-0` / значение в тексте отказа (scopeIdText, `assertScopeReady`, `ScopeConflictError`) | значение / готовность / изоляция | 5 / 1 / 1 из 25, 1 из 13, 1 из 21 |
| потолок `assertScopeReady` | потолок 60 с вместо `timeoutMs` / соединение не уничтожается по потолку / выданное после потолка не уничтожается | каталог | 1 / 1 / 1 из 15 |
| отказ с пустым перечнем читался как «готово» | `assertScopeReady` бросает всегда | готовность | 6 из 13 |
| RENAME/DROP COLUMN колонки области | снятие колонки не снимает «таблица области» | обходы гейта | 1 / 1 из 16 |
| вложенный `withScope` на другом пуле | любая рамка считается внешней | изоляция | 1 из 21 |
| предок по наследованию без колонки области | предки не обходятся (каталог) / связь INHERITS и ALTER TABLE … INHERIT не судится (гейт) | пути доступа / обходы гейта | 1 из 13 / 1 и 1 из 21 |
| права на колонки, роль без INHERIT (SET ROLE) | `has_any_column_privilege` снят / права только `current_user` | пути доступа | 1 / 1 из 13 |
| REPLICATION, CREATEROLE ниже 16, EXECUTE на функции чтения файлов | у самой роли / у роли, в которую она входит / в гейте; CREATEROLE — на Postgres 15; функции — пустой список | пути доступа / обходы гейта | 1 / 1 из 13, 1 из 21; 1 из 13 (15); 1 из 13 |
| каскад из общей таблицы | каскады не читаются / любое право на общую таблицу считается правом изменения | пути доступа | 1 / 1 из 13 |
| представление роли сессии | безопасное отвергается / чужое считается своим | пути доступа | 1 / 1 из 13 |
| varchar, имена в смешанном регистре | тип сверяется без `regtype` / имена только в нижнем регистре | пути доступа | 1 / 1 из 13 |
| политика сквозного доступа на чужие роли | роли не сверяются | пути доступа | 1 из 13 |
| временные таблицы и курсоры между областями | нет `resetSession` / `resetSession: false` принимается | изоляция | 1 / 1 из 24 |
| запрос, отложенный работой | ограда снята / свойство `query` не возвращается | изоляция | 2 / 21 из 24 |
| сессионный `set_config` под пулером | сброс только без пулера | изоляция | 1 из 24 |
| уборка стирала параметры connect (pg-runtime 0.6.0, `RESET ALL`) | pg-runtime 0.6.0 вместо 0.7.0 / пакет задаёт `sessionBaseline: 'defaults'` | изоляция | 2 из 28 / 2 из 28 |
| сброс под пулером отвергался фильтром pg-runtime 0.7.0 (любой `withScope` под `transactionPooler` — `PoolerIncompatibleError`); теперь сброс — `resetAppSettings` pg-runtime 0.7.1 | `resetAppSettings` снят в `withScope` / в `withCrossScope` / параметры области не добавляются к именам вызывающего | изоляция / PgBouncer | 1 из 37 и 2 из 5 / 0 из 37 (без пулера уборку делает `resetSession`) и 1 из 5 / 1 из 37 и 3 из 5 |
| значение, оставленное в обход фильтра (`EXECUTE` в DO) | сброс сессионных значений снят (`withScope` и `withCrossScope`) | изоляция / PgBouncer | 1 из 28 / 3 из 5 |
| контекст сессии сквозного доступа до вызова | проверка снята | сквозной доступ | 1 из 8 |
| состав и порядок миграций | журнал drizzle не соблюдается / файл вне журнала принимается / версии Flyway строками / U… читается / *.down.sql читается / dbmate целиком / без раскладки — сортировка | раскладки миграций | 1 / 1 / 3 / 1 / 1 / 1 / 1 из 7 |
| ALTER POLICY (вывод drizzle-kit 0.31.10) | ALTER POLICY не меняет форму политики | раскладки миграций / обходы гейта | 1 из 7 / 1 из 21 |
| notScoped в гейте схемы | допущение не читается / «не понадобилось» не снимается | гейт схемы / покрытие | 1 из 6 / 1 из 6 |
| CREATE ROLE … IN ROLE, ALTER GROUP … ADD USER | формы не читаются | обходы гейта | 1 / 1 из 21 |
| внешний ключ без колонок родителя | первичный ключ родителя не учитывается | обходы гейта | 2 из 21 |
| `timeoutMs` > 2^31−1, `canonicalFrom` — тот же пул | потолок не проверяется / второе соединение того же пула | пути доступа | 1 / 1 из 13 |
| значение области | пробел по краям / не NFKC / Default_Ignorable | значение | 2 / 2 / 1 из 32 |
| ALTER VIEW SET/RESET, правило на таблице и на представлении, короткая причина | каждое снято | обходы гейта | 2 / 1 / 1 / 1 из 21 |
| внешняя таблица в списке | relkind не сверяется | пути доступа | 1 из 13 |
| SECURITY DEFINER в каталоге | ветка триггера / изменяемость по любому праву / владелец-суперпользователь и BYPASSRLS / владелец — член роли сквозного доступа / событийный триггер | права владельца | 1 / 1 / 1 / 1 / 1 из 12 |
| параметр области в определении функции, LEAKPROOF, сопоставление пользователя | параметр не сверяется / без `lower` / LEAKPROOF не читается / сопоставления не читаются / без PUBLIC | права владельца | 1 / 1 / 1 / 1 / 1 из 12 |
| причина на роли, CREATEROLE через членство, `USING (false)`, REFERENCES/TRIGGER | проверка причины снята / CREATEROLE через членство (Postgres 15) / политика «ничего не открывает» снова чужая / REFERENCES, TRIGGER — снова доступ | права владельца | 1 / 1 / 1 / 1 из 12 |
| членство Postgres 16+ | любое членство как доступ / ADMIN OPTION не считается (Postgres 17) | права владельца | 1 / 1 из 12 |
| гейт: права владельца | итог по цепочке вызовов / EXPLAIN ANALYZE / `SET search_path` / `set_config` / GRANT EXECUTE / CREATEROLE / OWNER TO / динамический SQL / язык тела | права владельца в гейте | 3 / 1 / 1 / 1 / 1 / 1 / 1 / 1 / 1 из 7 |
| раскладки против ответов инструментов | обход подкаталогов / расширения golang-migrate / dbmate числами / `1.0` = `1` / R__ по пути / `_` в описании / суффикс в регистре / повтор версии / якоря `^` и `$` (golang-migrate, dbmate, Flyway) / файл в подкаталоге / чужое имя | ответы инструментов | 2 / 1 / 2 / 1 / 2 / 1 / 1 / 6 / по 1 / 2 / 7 из 36 |
| журнал drizzle, dbmate без маркера, неизвестная раскладка, ссылка на каталог | `when` не строго / `when` не число / маркер не обязателен / операторы до маркера / раскладка не сверяется / ссылка разрешена | раскладки миграций | по 1 из 10 |
| значение и причина | одиночный суррогат / пустое text, varchar / суррогат в причине | значение / сквозной доступ | 2 / 2 из 36, 1 из 8 |
| другая область на том же пуле; сессионная причина под пулером | проверка снята / сброс причины в `withCrossScope` снят | изоляция / PgBouncer | 1 из 26 / 1 из 5 |
| договор типов | `ScopeId` пропускает число / `resetSession: boolean` / `ScopeReadyOptions` не экспортирован | договор типов | 1 / 1 / 1 из 1 |

Спеки мутаций 0.1.0 (генератор без FORCE, `WITH CHECK (true)`, политика без `NULLIF`, сессионный `SET`, каждая проверка `assertScopeReady` и гейта) остаются в наборе. Перед правками 0.2.0 новые спеки прогнаны на коде 0.1.0: 51 красный из 146. Второй круг: новые и изменённые спеки на первой редакции 0.2.0 — 28 красных из 145.

## Лицензия

[MIT](LICENSE) © 2026 Hoshino Tatsuya
