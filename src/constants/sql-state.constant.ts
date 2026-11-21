import { deepFreeze } from '../deep-freeze';

/** Коды SQLSTATE, по которым пакет принимает решения. */
export const SQL_STATE = {
  /** Транзакция прервана ошибкой: COMMIT станет откатом. */
  inFailedTransaction: '25P02',
} as const;

deepFreeze(SQL_STATE);
