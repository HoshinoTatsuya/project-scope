import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeTransactionOptions } from '../types/scope-transaction-options.type';

/**
 * Свои параметры, которые pg-runtime сбрасывает к значению по умолчанию сессии
 * в конце самой внешней работы области (`resetAppSettings`, pg-runtime ≥ 0.7.1):
 * параметры вызывающего плюс контекст и причина области. Сброс идёт и под
 * `transactionPooler` — его шлёт сам pg-runtime, мимо фильтра текста, который
 * отвергает ту же форму из работы. Это единственное, что снимает значение,
 * оставленное работой в обход фильтра (`EXECUTE` в DO, функция): своих
 * параметров сверка состояния pg-runtime не видит.
 */
export function scopeAppSettings(scope: ProjectScope, options: ScopeTransactionOptions): readonly string[] {
  return [...(options.resetAppSettings ?? []), scope.setting, scope.reasonSetting];
}
