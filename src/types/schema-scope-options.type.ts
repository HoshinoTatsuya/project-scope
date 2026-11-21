export interface SchemaScopeOptions {
  /**
   * `casing` базы drizzle (`drizzle(pool, { casing })`): имя колонки, заданной
   * без явного имени (`projectId: uuid()`), в базе — ключ поля в этом регистре
   * (`project_id`). Гейт обязан сравнивать то же имя, что уходит в SQL.
   */
  readonly casing?: 'snake_case' | 'camelCase';
  /**
   * Допущения (то же, что у гейта миграций): материализованное представление
   * или представление из этого списка гейт схемы не судит.
   */
  readonly notScoped?: Readonly<Record<string, string>>;
}
