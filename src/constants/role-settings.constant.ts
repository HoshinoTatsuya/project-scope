import { deepFreeze } from '../deep-freeze';

/**
 * Параметры смены роли транзакции: в `localSettings` работы области — отказ.
 * Роль, в которую входит роль приложения, могла бы нести другие политики.
 */
export const ROLE_SETTINGS = ['role', 'session_authorization'] as const;

deepFreeze(ROLE_SETTINGS);
