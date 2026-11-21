import { MIGRATION_STATEMENT } from '../constants/migration-statement.constant';
import { SERVER_FILE_FUNCTIONS } from '../constants/server-file-functions.constant';
import { SERVER_FILE_ROLES } from '../constants/server-file-roles.constant';
import { SQL_NAME_PATTERN } from '../constants/sql-name-pattern.constant';
import { maintenancePredicateSql } from '../scope/maintenance-predicate-sql';
import { scopePredicateSql } from '../scope/scope-predicate-sql';
import type { ForeignKeyDeclaration } from '../types/foreign-key-declaration.type';
import type { MigrationFile } from '../types/migration-file.type';
import type { MigrationScopeOptions } from '../types/migration-scope-options.type';
import type { MigrationScopeReport } from '../types/migration-scope-report.type';
import type { PolicyForm } from '../types/policy-form.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { RoutineFacts } from '../types/routine-facts.type';
import type { ScopeTableState } from '../types/scope-table-state.type';
import { allowanceProblems } from './allowance-problems';
import { definerViolations } from './definer-violations';
import { explainedStatement } from './explained-statement';
import { foreignKeyDeclaration } from './foreign-key-declaration';
import { parenthesizedBody } from './parenthesized-body';
import { policyForm } from './policy-form';
import { policyTail } from './policy-tail';
import { routineReach } from './routine-reach';
import { searchPathMovesNames } from './search-path-moves-names';
import { splitSqlStatements } from './split-sql-statements';
import { splitTopLevelCommas } from './split-top-level-commas';
import { sqlObjectName } from './sql-object-name';
import { viewIsInvoker } from './view-is-invoker';

/**
 * Миграции по порядку применения, с состоянием каждой таблицы: есть ли колонка
 * области, включены ли RLS, FORCE и политика изоляции. Нарушения:
 * - миграция, в которой таблица ПОЛУЧИЛА колонку области (CREATE TABLE с ней,
 *   ADD COLUMN, RENAME COLUMN, секция или наследник таблицы области), не
 *   включает к своему концу все три — кроме таблиц `adoptedLater`;
 * - защита, бывшая полной, снята (DISABLE, NO FORCE, DROP POLICY без новой);
 * - политика области в миграции не та, что строит пакет (сравнивается текст
 *   целиком), или меняется ALTER POLICY;
 * - CREATE TABLE (и SELECT … INTO), колонки которого разбор не понял, — без
 *   записи `notScoped`;
 * - к концу истории: таблица списка не защищена, таблица с колонкой области вне
 *   списка; на таблице области осталась чужая разрешающая политика (или
 *   политика сквозного доступа не той формы); материализованное представление
 *   над данными области или представление без `security_invoker`; правило на
 *   данных области; внешний ключ на таблицу области без пары колонок области;
 *   лишние или необъяснённые допущения;
 * - сразу: GRANT роли сквозного доступа или встроенной роли доступа к файлам
 *   сервера, BYPASSRLS/SUPERUSER роли, SECURITY DEFINER над таблицами области,
 *   и то, что разбор заведомо читает не так, как сервер: элементы
 *   `CREATE SCHEMA`, ROLLBACK, смена `standard_conforming_strings`, UESCAPE.
 *
 * Гейт читает ТЕКСТ — это рубеж против ошибок, а не против умысла: тела
 * `DO $$…$$` и динамический SQL не читаются. Состояние живой базы судит
 * `assertScopeReady` (проход по каталогу).
 */
export function migrationScopeViolations(
  scope: ProjectScope,
  files: readonly MigrationFile[],
  options: MigrationScopeOptions = {},
): MigrationScopeReport {
  const violations: string[] = [];
  const states = new Map<string, ScopeTableState>();
  // Секция → родитель: секции таблицы области защищаются, но в список области не вносятся.
  const parentOf = new Map<string, string>();
  // Политики таблиц по миграциям: форма (null — не разобрана) и файл, где она стала такой.
  const policies = new Map<string, Map<string, { form: PolicyForm | null; file: string }>>();
  // Наследник → предки (INHERITS, ALTER TABLE … INHERIT) с файлом, где связь появилась.
  const inheritsFrom = new Map<string, Map<string, string>>();
  const primaryKeys = new Map<string, readonly string[]>();
  const derived = new Map<string, { kind: 'view' | 'matview'; invoker: boolean; file: string }>();
  const rules = new Map<string, { table: string; name: string; file: string }>();
  const foreignKeys = new Map<string, ForeignKeyDeclaration & { file: string }>();
  // Подпрограммы миграций: права владельца, касание области, читаемость тела.
  const routines = new Map<string, RoutineFacts>();
  const adoptedLater = options.adoptedLater ?? {};
  const notScoped = options.notScoped ?? {};
  const usedAdopted = new Set<string>();
  const usedNotScoped = new Set<string>();
  const predicate = policyTail(scopePredicateSql(scope));
  const maintenancePredicate = policyTail(maintenancePredicateSql(scope));
  /** Политика изоляции ровно той формы, что строит пакет; иначе — что не так. */
  const isolationProblems = (form: PolicyForm | null): string[] =>
    form === null
      ? ['текст политики не разобран']
      : [
          ...(form.permissive ? [] : ['RESTRICTIVE']),
          ...(form.command === 'all' ? [] : [`FOR ${form.command.toUpperCase()}`]),
          ...(form.roles.length === 0 || (form.roles.length === 1 && form.roles[0] === 'public')
            ? []
            : [`TO ${form.roles.join(', ')}`]),
          ...(form.using === predicate && form.check === predicate
            ? []
            : ['выражение не то, что строит пакет (USING и WITH CHECK)']),
        ];
  const maintenanceOk = (form: PolicyForm | null): boolean =>
    form !== null &&
    scope.maintenanceRole !== null &&
    form.permissive &&
    form.command === 'all' &&
    form.roles.length === 1 &&
    form.roles[0] === scope.maintenanceRole &&
    form.using === maintenancePredicate &&
    form.check === maintenancePredicate;
  const anyName = new RegExp(SQL_NAME_PATTERN.qualified, 'g');
  const forbiddenRoles = new Set([
    ...(scope.maintenanceRole === null ? [] : [scope.maintenanceRole]),
    ...SERVER_FILE_ROLES,
  ]);
  const fresh = (scoped: boolean): ScopeTableState => ({
    scoped,
    rls: false,
    force: false,
    policy: false,
    protectedOnce: false,
  });
  const stateOf = (table: string): ScopeTableState => {
    const existing = states.get(table);
    if (existing !== undefined) {
      return existing;
    }
    const created = fresh(false);
    states.set(table, created);
    return created;
  };
  const isScoped = (table: string): boolean => states.get(table)?.scoped ?? scope.tables.includes(table);
  /** Текст ссылается на таблицу области или на представление над её данными. */
  const refersToScope = (sql: string): boolean =>
    (sql.match(anyName) ?? []).map(sqlObjectName).some((name) => isScoped(name) || derived.has(name));
  const keyOf = (table: string, name: string): string => `${table}\u0000${name}`;
  /**
   * Переименование или перенос схемы: всё, что гейт знает об отношении, идёт за
   * ним — и как ключ (состояние, политики, родитель секции, представление), и
   * как значение (родитель у секций и наследников, цель внешних ключей).
   */
  const renameRelation = (from: string, to: string): void => {
    const state = states.get(from);
    if (state !== undefined) {
      states.delete(from);
      states.set(to, state);
    }
    for (const map of [policies, inheritsFrom, parentOf, derived] as Map<string, unknown>[]) {
      const moved = map.get(from);
      if (moved !== undefined) {
        map.delete(from);
        map.set(to, moved);
      }
    }
    for (const parents of inheritsFrom.values()) {
      const file = parents.get(from);
      if (file !== undefined) {
        parents.delete(from);
        parents.set(to, file);
      }
    }
    for (const [partition, parent] of parentOf) {
      if (parent === from) {
        parentOf.set(partition, to);
      }
    }
    const key = primaryKeys.get(from);
    if (key !== undefined) {
      primaryKeys.delete(from);
      primaryKeys.set(to, key);
    }
    for (const [key, declaration] of [...foreignKeys]) {
      if (declaration.table === from || declaration.references === from) {
        foreignKeys.delete(key);
        const moved = {
          ...declaration,
          table: declaration.table === from ? to : declaration.table,
          references: declaration.references === from ? to : declaration.references,
        };
        foreignKeys.set(keyOf(moved.table, moved.name), moved);
      }
    }
    for (const [key, rule] of [...rules]) {
      if (rule.table === from) {
        rules.delete(key);
        rules.set(keyOf(to, rule.name), { ...rule, table: to });
      }
    }
  };
  /** Удаление отношения; секции секционированной таблицы сервер удаляет вместе с ней. */
  const dropRelation = (table: string, depth = 0): void => {
    for (const [partition, parent] of [...parentOf]) {
      if (parent === table && depth < 32) {
        dropRelation(partition, depth + 1);
      }
    }
    states.delete(table);
    parentOf.delete(table);
    policies.delete(table);
    inheritsFrom.delete(table);
    primaryKeys.delete(table);
    derived.delete(table);
    for (const [key, declaration] of [...foreignKeys]) {
      if (declaration.table === table) {
        foreignKeys.delete(key);
      }
    }
    for (const [key, rule] of [...rules]) {
      if (rule.table === table) {
        rules.delete(key);
      }
    }
  };
  const addForeignKey = (file: string, declaration: ForeignKeyDeclaration | null): void => {
    if (declaration !== null) {
      foreignKeys.set(keyOf(declaration.table, declaration.name), { ...declaration, file });
    }
  };

  violations.push(
    ...allowanceProblems('adoptedLater', adoptedLater, null).reasons,
    ...allowanceProblems('notScoped', notScoped, null).reasons,
  );

  for (const file of files) {
    const becameScoped = new Set<string>();
    const markScoped = (table: string): void => {
      const state = stateOf(table);
      if (!state.scoped) {
        state.scoped = true;
        becameScoped.add(table);
      }
    };
    /** Новая таблица, чьи колонки разбор не понял: в списке — защищать; notScoped — допущение; иначе нарушение. */
    const unparsedTable = (table: string, form: string, forms: string): boolean => {
      if (scope.tables.includes(table)) {
        return true;
      }
      if (Object.hasOwn(notScoped, table)) {
        usedNotScoped.add(table);
        return false;
      }
      violations.push(
        `${file.name}: ${form} ${table} не разобран (${forms}) — есть ли колонка ${scope.column}, не определить; ` +
          'внесите таблицу в список области или в notScoped с причиной',
      );
      return false;
    };
    let statements: ReturnType<typeof splitSqlStatements>;
    try {
      statements = splitSqlStatements(file.sql);
    } catch (error) {
      violations.push(
        `${file.name}: SQL не разобран (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (statements.some(({ text }) => MIGRATION_STATEMENT.conformingStrings.test(text))) {
      violations.push(
        `${file.name}: standard_conforming_strings в миграции — от него зависит, где кончается строка, и разбор гейта читал бы не то, что исполнит сервер`,
      );
    }
    for (const statement of statements) {
      // EXPLAIN ANALYZE исполняет оператор — судится он; EXPLAIN без ANALYZE не исполняет ничего.
      const executed = explainedStatement(statement);
      if (executed === null) {
        continue;
      }
      const { text, masked } = executed;
      const path = MIGRATION_STATEMENT.searchPath.exec(text);
      const configuredPath = MIGRATION_STATEMENT.setConfigSearchPath.exec(text);
      if (
        (path !== null && searchPathMovesNames(path[1])) ||
        (configuredPath !== null && searchPathMovesNames(configuredPath[1]?.replaceAll("''", "'")))
      ) {
        violations.push(
          `${file.name}: search_path без public первым — имена без схемы сервер разрешает не в public, а гейт читает их как public; пишите схему явно`,
        );
      }
      if (MIGRATION_STATEMENT.unicodeEscapeClause.test(masked)) {
        violations.push(`${file.name}: UESCAPE — юникодные имена со своим escape-символом гейт не разбирает`);
        continue;
      }
      if (MIGRATION_STATEMENT.createSchemaElements.test(masked)) {
        violations.push(
          `${file.name}: CREATE SCHEMA с элементами (CREATE TABLE … внутри) гейт не разбирает — разнесите на отдельные операторы`,
        );
        continue;
      }
      if (MIGRATION_STATEMENT.rollback.test(masked)) {
        violations.push(
          `${file.name}: ${masked.split(' ')[0]?.toUpperCase()} в миграции — гейт не моделирует откат, и защита, снятая или включённая в откатываемой части, читалась бы неверно`,
        );
        continue;
      }
      const create = MIGRATION_STATEMENT.createTable.exec(masked);
      if (create !== null) {
        if (create[1] !== undefined) {
          continue; // временная таблица живёт до конца сессии мигратора
        }
        const table = sqlObjectName(create[3] ?? '');
        if (create[2] !== undefined && states.has(table)) {
          continue; // IF NOT EXISTS существующей — сервер ничего не делает
        }
        const rest = (create[4] ?? '').trim();
        dropRelation(table);
        states.set(table, fresh(false));
        const partition = MIGRATION_STATEMENT.partitionOf.exec(rest);
        const body = parenthesizedBody(rest);
        let scoped: boolean | null = null;
        if (partition !== null) {
          const parent = sqlObjectName(partition[1] ?? '');
          parentOf.set(table, parent);
          scoped = isScoped(parent);
        } else if (body !== null) {
          const elements = splitTopLevelCommas(body.body);
          for (const element of elements) {
            addForeignKey(file.name, foreignKeyDeclaration(table, element));
            const key = MIGRATION_STATEMENT.primaryKey.exec(element);
            if (key !== null) {
              primaryKeys.set(
                table,
                (key[1] ?? '').split(',').map((column) => sqlObjectName(column.trim())),
              );
            } else if (
              !MIGRATION_STATEMENT.tableConstraint.test(element) &&
              MIGRATION_STATEMENT.columnPrimaryKey.test(element)
            ) {
              primaryKeys.set(table, [
                sqlObjectName(MIGRATION_STATEMENT.columnName.exec(element)?.[1] ?? ''),
              ]);
            }
          }
          if (!elements.some((element) => MIGRATION_STATEMENT.likeElement.test(element))) {
            const columns = elements
              .filter((element) => !MIGRATION_STATEMENT.tableConstraint.test(element))
              .map((element) => sqlObjectName(MIGRATION_STATEMENT.columnName.exec(element)?.[1] ?? ''));
            const parents = (MIGRATION_STATEMENT.inherits.exec(body.rest)?.[1] ?? '')
              .split(',')
              .map((parent) => parent.trim())
              .filter((parent) => parent !== '')
              .map(sqlObjectName);
            if (parents.length > 0) {
              inheritsFrom.set(table, new Map(parents.map((parent) => [parent, file.name])));
            }
            scoped = columns.includes(scope.column) || parents.some(isScoped);
          }
        }
        if (scoped ?? unparsedTable(table, 'CREATE TABLE', 'AS, LIKE, OF')) {
          markScoped(table);
        }
        continue;
      }
      const selectInto = MIGRATION_STATEMENT.selectInto.exec(masked);
      if (selectInto !== null) {
        if (selectInto[1] === undefined) {
          const table = sqlObjectName(selectInto[2] ?? '');
          dropRelation(table);
          states.set(table, fresh(false));
          if (unparsedTable(table, 'SELECT … INTO', 'новая таблица из запроса')) {
            markScoped(table);
          }
        }
        continue;
      }
      const alter = MIGRATION_STATEMENT.alterTable.exec(masked);
      if (alter !== null) {
        let table = sqlObjectName(alter[1] ?? '');
        for (const action of splitTopLevelCommas(alter[2] ?? '')) {
          const state = stateOf(table);
          const added = MIGRATION_STATEMENT.addColumn.exec(action);
          const constraint = MIGRATION_STATEMENT.addConstraint.exec(action);
          const dropped = MIGRATION_STATEMENT.dropColumn.exec(action);
          const droppedConstraint = MIGRATION_STATEMENT.dropConstraint.exec(action);
          const renamedColumn = MIGRATION_STATEMENT.renameColumn.exec(action);
          const renamedTable = MIGRATION_STATEMENT.renameTable.exec(action);
          const movedSchema = MIGRATION_STATEMENT.setSchema.exec(action);
          const attached = MIGRATION_STATEMENT.attachPartition.exec(action);
          const detached = MIGRATION_STATEMENT.detachPartition.exec(action);
          const inherit = MIGRATION_STATEMENT.inherit.exec(action);
          const noInherit = MIGRATION_STATEMENT.noInherit.exec(action);
          const addedKey = MIGRATION_STATEMENT.primaryKey.exec(action.replace(/^ADD /i, ''));
          if (inherit !== null) {
            const parent = sqlObjectName(inherit[1] ?? '');
            const parents = inheritsFrom.get(table) ?? new Map<string, string>();
            parents.set(parent, file.name);
            inheritsFrom.set(table, parents);
            if (isScoped(parent)) {
              markScoped(table);
            }
          } else if (noInherit !== null) {
            inheritsFrom.get(table)?.delete(sqlObjectName(noInherit[1] ?? ''));
          } else if (/^ADD /i.test(action) && addedKey !== null) {
            primaryKeys.set(
              table,
              (addedKey[1] ?? '').split(',').map((column) => sqlObjectName(column.trim())),
            );
          } else if (MIGRATION_STATEMENT.enableRls.test(action)) {
            state.rls = true;
          } else if (MIGRATION_STATEMENT.disableRls.test(action)) {
            state.rls = false;
          } else if (MIGRATION_STATEMENT.forceRls.test(action)) {
            state.force = true;
          } else if (MIGRATION_STATEMENT.noForceRls.test(action)) {
            state.force = false;
          } else if (renamedTable !== null || movedSchema !== null) {
            const short = table.slice(table.lastIndexOf('.') + 1);
            const schema = table.includes('.') ? table.slice(0, table.lastIndexOf('.')) : 'public';
            const quoted = (part: string): string => `"${part.replaceAll('"', '""')}"`;
            const renamed =
              renamedTable !== null
                ? sqlObjectName(`${quoted(schema)}.${quoted(sqlObjectName(renamedTable[1] ?? ''))}`)
                : sqlObjectName(`${quoted(sqlObjectName(movedSchema?.[1] ?? ''))}.${quoted(short)}`);
            renameRelation(table, renamed);
            if (becameScoped.delete(table)) {
              becameScoped.add(renamed);
            }
            table = renamed;
          } else if (renamedColumn !== null) {
            const from = sqlObjectName(renamedColumn[1] ?? '');
            const to = sqlObjectName(renamedColumn[2] ?? '');
            if (to === scope.column) {
              markScoped(table);
            } else if (from === scope.column) {
              state.scoped = false;
            }
          } else if (constraint !== null) {
            addForeignKey(file.name, foreignKeyDeclaration(table, constraint[1] ?? ''));
          } else if (added !== null) {
            addForeignKey(file.name, foreignKeyDeclaration(table, action.replace(/^ADD /i, '')));
            if (sqlObjectName(added[1] ?? '') === scope.column) {
              markScoped(table);
            }
          } else if (droppedConstraint !== null) {
            foreignKeys.delete(keyOf(table, sqlObjectName(droppedConstraint[1] ?? '')));
          } else if (dropped !== null && sqlObjectName(dropped[1] ?? '') === scope.column) {
            state.scoped = false;
          } else if (attached !== null) {
            const partition = sqlObjectName(attached[1] ?? '');
            parentOf.set(partition, table);
            if (state.scoped) {
              markScoped(partition);
            }
          } else if (detached !== null) {
            // Секция с колонкой области стала самостоятельной: в список или в notScoped.
            parentOf.delete(sqlObjectName(detached[1] ?? ''));
          }
        }
        continue;
      }
      const createPolicy = MIGRATION_STATEMENT.createPolicy.exec(masked);
      const alterPolicy = MIGRATION_STATEMENT.alterPolicy.exec(masked);
      const changed = createPolicy ?? alterPolicy;
      if (changed !== null) {
        let name = sqlObjectName(changed[1] ?? '');
        const table = sqlObjectName(changed[2] ?? '');
        const onTable = policies.get(table) ?? new Map<string, { form: PolicyForm | null; file: string }>();
        policies.set(table, onTable);
        // Префикс `… POLICY имя ON таблица` в тексте и маске одинаков: литералов в нём нет.
        const tail = text.slice(changed[0].length).trim();
        const renamed = alterPolicy === null ? null : MIGRATION_STATEMENT.renameTable.exec(tail);
        let form: PolicyForm | null;
        if (renamed !== null) {
          form = onTable.get(name)?.form ?? null;
          onTable.delete(name);
          if (name === scope.policyName) {
            stateOf(table).policy = false;
          }
          name = sqlObjectName(renamed[1] ?? '');
        } else if (alterPolicy !== null) {
          const before = onTable.get(name)?.form;
          form = before === undefined || before === null ? null : policyForm(tail, before);
        } else {
          form = policyForm(tail);
        }
        onTable.set(name, { form, file: file.name });
        if (name === scope.policyName) {
          const problems = isolationProblems(form);
          stateOf(table).policy = problems.length === 0;
          if (problems.length > 0) {
            violations.push(
              `${file.name}: политика ${scope.policyName} на ${table}${alterPolicy === null ? '' : ' после ALTER POLICY'} не та: ${problems.join('; ')}`,
            );
          }
        }
        continue;
      }
      const dropPolicy = MIGRATION_STATEMENT.dropPolicy.exec(masked);
      if (dropPolicy !== null) {
        const name = sqlObjectName(dropPolicy[1] ?? '');
        const table = sqlObjectName(dropPolicy[2] ?? '');
        if (name === scope.policyName) {
          stateOf(table).policy = false;
        }
        policies.get(table)?.delete(name);
        continue;
      }
      const dropTable = MIGRATION_STATEMENT.dropTable.exec(masked);
      if (dropTable !== null) {
        for (const name of dropTable[1]?.match(anyName) ?? []) {
          dropRelation(sqlObjectName(name));
        }
        continue;
      }
      const createView = MIGRATION_STATEMENT.createView.exec(masked);
      if (createView !== null) {
        const name = sqlObjectName(createView[2] ?? '');
        if (createView[1] === undefined && refersToScope(createView[3] ?? '')) {
          derived.set(name, {
            kind: 'view',
            invoker: viewIsInvoker(MIGRATION_STATEMENT.viewOptions.exec(text)?.[1]),
            file: file.name,
          });
        } else {
          derived.delete(name);
        }
        continue;
      }
      const createMaterialized = MIGRATION_STATEMENT.createMaterializedView.exec(masked);
      if (createMaterialized !== null) {
        const name = sqlObjectName(createMaterialized[1] ?? '');
        if (refersToScope(createMaterialized[2] ?? '')) {
          derived.set(name, { kind: 'matview', invoker: false, file: file.name });
        }
        continue;
      }
      const alterView = MIGRATION_STATEMENT.alterView.exec(masked);
      if (alterView !== null) {
        const name = sqlObjectName(alterView[2] ?? '');
        const view = derived.get(name);
        const action = alterView[3] ?? '';
        const options = MIGRATION_STATEMENT.viewSetOptions.exec(
          MIGRATION_STATEMENT.alterView.exec(text)?.[3] ?? action,
        );
        const renamed = MIGRATION_STATEMENT.renameTable.exec(action);
        if (view !== undefined && options !== null && /\bsecurity_invoker\b/i.test(options[2] ?? '')) {
          view.invoker = options[1]?.toUpperCase() === 'SET' && viewIsInvoker(options[2]);
        } else if (view !== undefined && renamed !== null) {
          derived.delete(name);
          derived.set(sqlObjectName(renamed[1] ?? ''), view);
        }
        continue;
      }
      const dropView = MIGRATION_STATEMENT.dropView.exec(masked);
      if (dropView !== null) {
        for (const name of dropView[1]?.match(anyName) ?? []) {
          derived.delete(sqlObjectName(name));
        }
        continue;
      }
      const createRule = MIGRATION_STATEMENT.createRule.exec(masked);
      if (createRule !== null) {
        const name = sqlObjectName(createRule[1] ?? '');
        const table = sqlObjectName(createRule[2] ?? '');
        if (isScoped(table) || derived.has(table) || refersToScope(createRule[3] ?? '')) {
          rules.set(keyOf(table, name), { table, name, file: file.name });
        }
        continue;
      }
      const dropRule = MIGRATION_STATEMENT.dropRule.exec(masked);
      if (dropRule !== null) {
        rules.delete(keyOf(sqlObjectName(dropRule[2] ?? ''), sqlObjectName(dropRule[1] ?? '')));
        continue;
      }
      const grantedRoutine = MIGRATION_STATEMENT.grantRoutine.exec(masked);
      if (grantedRoutine !== null) {
        const fileFunctions = new Set<string>(
          SERVER_FILE_FUNCTIONS.flatMap((name) => [name, `pg_catalog.${name}`]),
        );
        const granted =
          grantedRoutine[1] === undefined
            ? (grantedRoutine[2]?.match(anyName) ?? [])
                .map(sqlObjectName)
                .filter((schema) => schema === 'pg_catalog')
                .map((schema) => `ALL FUNCTIONS IN SCHEMA ${schema}`)
            : grantedRoutine[1]
                .replace(/\([^)]*\)/g, '')
                .split(',')
                .map((name) => sqlObjectName(name.trim()))
                .filter((name) => fileFunctions.has(name))
                .map((name) => name.replace(/^pg_catalog\./, ''));
        for (const name of granted) {
          violations.push(
            `${file.name}: GRANT EXECUTE ON ${name} — функция чтения файлов сервера читает файлы таблиц мимо RLS`,
          );
        }
        continue;
      }
      const grant = MIGRATION_STATEMENT.grantRole.exec(masked);
      if (grant !== null) {
        const granted = (grant[1] ?? '').split(',').map((role) => sqlObjectName(role.trim()));
        for (const role of granted.filter((candidate) => forbiddenRoles.has(candidate))) {
          violations.push(
            `${file.name}: GRANT ${role} — членство в роли сквозного доступа или доступа к файлам сервера снимает изоляцию одной командой`,
          );
        }
        continue;
      }
      const createRole = MIGRATION_STATEMENT.createRole.exec(masked);
      const alterGroup = MIGRATION_STATEMENT.alterGroupAdd.exec(masked);
      if (createRole !== null || alterGroup !== null) {
        const created = sqlObjectName((createRole ?? alterGroup)?.[1] ?? '');
        const rest = createRole?.[2] ?? '';
        const names = (list: string | undefined): string[] => (list?.match(anyName) ?? []).map(sqlObjectName);
        const joins = names(MIGRATION_STATEMENT.roleInRole.exec(rest)?.[1]).filter((role) =>
          forbiddenRoles.has(role),
        );
        const membersOfForbidden =
          forbiddenRoles.has(created) &&
          (alterGroup !== null ||
            MIGRATION_STATEMENT.roleMembers.test(rest.replace(MIGRATION_STATEMENT.roleInRole, '')));
        for (const role of [...joins, ...(membersOfForbidden ? [created] : [])]) {
          violations.push(
            `${file.name}: членство в ${role} (CREATE ROLE … IN ROLE / ROLE, ALTER GROUP … ADD USER) — роль сквозного доступа или доступа к файлам сервера снимает изоляцию одной командой`,
          );
        }
      }
      const attributes = MIGRATION_STATEMENT.roleAttributes.exec(masked);
      if (attributes !== null) {
        const attribute = attributes[1]?.toUpperCase();
        violations.push(
          `${file.name}: роль с ${attribute} — ${
            attribute === 'REPLICATION'
              ? 'слот логического декодирования читает строки всех областей'
              : attribute === 'CREATEROLE'
                ? 'ниже Postgres 16 выдаёт себе членство в любой роли без суперправ (в том числе в роль сквозного доступа)'
                : 'RLS к ней не применяется'
          }`,
        );
        continue;
      }
      const createdRoutine = MIGRATION_STATEMENT.createRoutineName.exec(masked);
      if (createdRoutine !== null) {
        const name = sqlObjectName(createdRoutine[1] ?? '');
        const declared = MIGRATION_STATEMENT.routineLanguage.exec(masked);
        const language = (
          declared?.[1] ??
          (declared === null && /\bBEGIN ATOMIC\b/i.test(masked)
            ? 'sql'
            : (/\bLANGUAGE '([A-Za-z_][A-Za-z0-9_]*)'/i.exec(text)?.[1] ?? ''))
        ).toLowerCase();
        const definer = MIGRATION_STATEMENT.securityDefiner.test(masked);
        const touchesScope = refersToScope(text);
        routines.set(name, {
          definer,
          touchesScope,
          opaque: !['sql', 'plpgsql'].includes(language) || MIGRATION_STATEMENT.dynamicSql.test(text),
          names: [...new Set((text.match(anyName) ?? []).map(sqlObjectName))].filter(
            (other) => other !== name,
          ),
          file: file.name,
          reported: definer && touchesScope,
        });
        if (definer && touchesScope) {
          violations.push(
            `${file.name}: функция SECURITY DEFINER над таблицей области — исполняется правами владельца, который политик не проходит`,
          );
        }
        continue;
      }
      const droppedRoutines = MIGRATION_STATEMENT.dropRoutine.exec(masked);
      if (droppedRoutines !== null) {
        for (const name of (droppedRoutines[1] ?? '').replace(/\([^)]*\)/g, '').split(',')) {
          routines.delete(sqlObjectName(name.trim()));
        }
        continue;
      }
      const renamedRoutine = MIGRATION_STATEMENT.alterRoutineRename.exec(masked);
      if (renamedRoutine !== null) {
        const from = sqlObjectName(renamedRoutine[1] ?? '');
        const routine = routines.get(from);
        routines.delete(from);
        if (routine !== undefined) {
          routines.set(sqlObjectName(renamedRoutine[2] ?? ''), routine);
        }
        continue;
      }
      const ownerChange = MIGRATION_STATEMENT.alterRoutineOwner.exec(masked);
      if (ownerChange !== null) {
        const name = sqlObjectName(ownerChange[1] ?? '');
        const routine = routines.get(name);
        if (routine === undefined) {
          violations.push(
            `${file.name}: ALTER FUNCTION ${name} OWNER TO — функция создана не в этих миграциях: исполняется ли она правами владельца над данными области, не определить`,
          );
        } else if (routine.definer && routineReach(routines, name) !== null) {
          violations.push(
            `${file.name}: ALTER FUNCTION ${name} OWNER TO — функция SECURITY DEFINER касается таблицы области: новый владелец решает, проходит ли она политики`,
          );
        }
        continue;
      }
      if (MIGRATION_STATEMENT.alterRoutine.test(masked) && MIGRATION_STATEMENT.securityDefiner.test(masked)) {
        violations.push(
          `${file.name}: ALTER … SECURITY DEFINER — тело функции здесь не видно; функция с правами владельца обходит RLS области`,
        );
      }
    }
    for (const [table, state] of states) {
      if (!state.scoped) {
        continue;
      }
      const missing = [
        state.rls ? null : 'ENABLE ROW LEVEL SECURITY',
        state.force ? null : 'FORCE ROW LEVEL SECURITY',
        state.policy ? null : `политика ${scope.policyName}`,
      ].filter((item): item is string => item !== null);
      if (missing.length === 0) {
        state.protectedOnce = true;
      } else if (state.protectedOnce) {
        violations.push(`${file.name}: ${table} — защита области снята: нет ${missing.join(', ')}`);
        state.protectedOnce = false;
      } else if (becameScoped.has(table)) {
        if (Object.hasOwn(adoptedLater, table)) {
          usedAdopted.add(table);
        } else {
          violations.push(
            `${file.name}: ${table} получает колонку ${scope.column}, а миграция не включает ${missing.join(', ')}`,
          );
        }
      }
    }
  }

  const scopedTables = [...states].filter(([, state]) => state.scoped).map(([table]) => table);
  for (const table of scope.tables) {
    const state = states.get(table);
    if (state === undefined || !state.scoped) {
      violations.push(
        `${table} в списке области, а ${state === undefined ? 'миграции её не создают' : `колонки ${scope.column} в ней нет`}`,
      );
    } else if (!(state.rls && state.force && state.policy)) {
      violations.push(`${table} в списке области, а к концу миграций защита не полная`);
    }
  }
  const rootOf = (table: string, depth = 0): string => {
    const parent = parentOf.get(table);
    return parent === undefined || depth > 32 ? table : rootOf(parent, depth + 1);
  };
  for (const table of scopedTables) {
    if (!scope.tables.includes(rootOf(table))) {
      violations.push(`${table}: колонка ${scope.column} есть, а в списке области таблицы нет`);
    }
  }
  for (const [table, onTable] of policies) {
    if (!isScoped(table)) {
      continue;
    }
    for (const [name, { form, file }] of onTable) {
      if (name === scope.policyName || form?.permissive === false) {
        continue;
      }
      if (name === scope.maintenancePolicyName && scope.maintenanceRole !== null) {
        if (!maintenanceOk(form)) {
          violations.push(
            `${file}: политика ${name} на ${table} не та, что строит пакет — роль сквозного доступа видит все строки только без контекста области`,
          );
        }
      } else {
        violations.push(
          `${file}: разрешающая политика ${name} на ${table} — складывается с политикой области через OR и расширяет доступ`,
        );
      }
    }
  }
  for (const [child, parents] of inheritsFrom) {
    if (!isScoped(child)) {
      continue;
    }
    for (const [parent, file] of parents) {
      if (!isScoped(parent)) {
        violations.push(
          `${file}: ${child} наследует ${parent} без колонки ${scope.column} — запрос к ${parent} читает и меняет строки ${child} всех областей, TRUNCATE стирает их`,
        );
      }
    }
  }
  for (const [name, relation] of derived) {
    if (relation.kind === 'matview') {
      if (Object.hasOwn(notScoped, name)) {
        usedNotScoped.add(name);
      } else {
        violations.push(
          `${relation.file}: материализованное представление ${name} над данными области — у него нет RLS, REFRESH сохраняет строки, видимые обновившему, для всех`,
        );
      }
    } else if (!relation.invoker) {
      violations.push(
        `${relation.file}: представление ${name} над данными области без security_invoker = true — политики применяются к его владельцу`,
      );
    }
  }
  violations.push(...definerViolations(routines));
  for (const rule of rules.values()) {
    violations.push(
      `${rule.file}: правило ${rule.name} на ${rule.table} касается данных области — исполняется правами владельца таблицы; замените триггером`,
    );
  }
  for (const key of foreignKeys.values()) {
    if (!isScoped(key.references) && !scope.tables.includes(rootOf(key.references))) {
      continue;
    }
    const position = key.columns.indexOf(scope.column);
    const referenced = key.referencedColumns ?? primaryKeys.get(key.references) ?? null;
    if (referenced === null || position === -1 || referenced[position] !== scope.column) {
      violations.push(
        `${key.file}: внешний ключ ${key.name} ${key.table} → ${key.references} без пары колонок ${scope.column}` +
          `${referenced === null ? ' (колонки родителя не указаны, первичный ключ родителя неизвестен)' : ''} — проверка ключа и каскады идут мимо RLS; ` +
          `ключ (${scope.column}, …) REFERENCES ${key.references} (${scope.column}, …)`,
      );
    }
  }
  violations.push(
    ...allowanceProblems('adoptedLater', adoptedLater, usedAdopted).unused,
    ...allowanceProblems('notScoped', notScoped, usedNotScoped).unused,
  );
  return { violations, scopedTables: scopedTables.sort(), usedNotScoped: [...usedNotScoped].sort() };
}
