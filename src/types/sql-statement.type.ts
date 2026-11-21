/** Оператор SQL без комментариев; `masked` — ещё и без содержимого строк и тел в долларовых кавычках. */
export interface SqlStatement {
  readonly text: string;
  readonly masked: string;
}
