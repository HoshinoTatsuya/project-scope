/**
 * Сессионный `set_config(…, false)` из DO-блока через `EXECUTE`: текст вызова —
 * строка внутри тела, и текстовый фильтр пулера pg-runtime его не видит, а
 * сверка состояния серверного соединения не видит своих параметров (`app.*`).
 * Так работа в обход фильтра оставляет значение на сессии — путь, который
 * закрывает только сброс параметров области в конце работы. Значения —
 * константы тестов (кавычек в них нет).
 */
export function sessionSetByExecute(setting: string, value: string): string {
  return `DO $$BEGIN EXECUTE format('SELECT set_config(%L, %L, false)', '${setting}', '${value}'); END$$`;
}
