import { deepFreeze } from '../deep-freeze';

/**
 * Функции `pg_catalog`, которые читают файлы сервера (в том числе файлы данных
 * таблиц — по относительному пути) мимо RLS. По умолчанию EXECUTE на них нет
 * ни у кого, кроме суперпользователя; выданный роли приложения — эскалация.
 */
export const SERVER_FILE_FUNCTIONS = [
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'pg_ls_dir',
  'lo_import',
  'lo_export',
] as const;

deepFreeze(SERVER_FILE_FUNCTIONS);
