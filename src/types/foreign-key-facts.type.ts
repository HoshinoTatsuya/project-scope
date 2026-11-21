/** Внешний ключ, ссылающийся на таблицу области. */
export interface ForeignKeyFacts {
  name: string;
  child: string;
  parent: string;
  /** Колонка области ссылающейся таблицы стоит в ключе в паре с колонкой области родителя. */
  paired: boolean;
}
