/**
 * Значение `security_invoker` из параметров представления — истина ли оно так,
 * как его понимает сервер (`parse_bool`: true/on/yes/1 и однозначные префиксы
 * true и yes, без учёта регистра). Пусто — параметр не задан, то есть ложь.
 */
export function isSecurityInvoker(value: string): boolean {
  return /^(?:t|tr|tru|true|y|ye|yes|on|1)$/i.test(value.trim());
}
