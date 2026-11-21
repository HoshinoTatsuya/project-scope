/** Зачем обслуживающей работе все области: попадает в параметр транзакции для аудита. */
export interface CrossScopeReason {
  readonly reason: string;
}
