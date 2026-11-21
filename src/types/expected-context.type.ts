/** Что работа обязана оставить в параметрах области к своему концу. */
export interface ExpectedContext {
  /** Значение области; null — контекст пуст (сквозной доступ). */
  readonly value: string | null;
  /** Причина сквозного доступа; null — причины нет (работа области). */
  readonly reason: string | null;
}
