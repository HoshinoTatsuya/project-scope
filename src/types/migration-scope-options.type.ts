/** Допущения гейта миграций: таблица → причина (не короче 20 символов). */
export interface MigrationScopeOptions {
  /**
   * Таблицы, созданные раньше пакета: RLS для них включает ПОЗДНЯЯ миграция, а
   * не та, что их создала. Запись, которая не понадобилась, — нарушение.
   */
  readonly adoptedLater?: Readonly<Record<string, string>>;
  /**
   * Таблицы, чей CREATE TABLE разбор не понял (`AS SELECT`, `LIKE`, `OF тип`),
   * а колонки области в них нет. Без записи такой CREATE — нарушение:
   * «не разобрал» не значит «защищать не нужно».
   */
  readonly notScoped?: Readonly<Record<string, string>>;
}
