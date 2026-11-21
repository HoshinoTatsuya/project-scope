import { deepFreeze } from '../deep-freeze';

/**
 * Встроенные роли Postgres, которые читают данные мимо RLS: программа на
 * сервере (`COPY … FROM PROGRAM 'psql …'`) и файлы данных напрямую. Членство в
 * них для роли приложения — та же эскалация, что членство в роли с BYPASSRLS.
 */
export const SERVER_FILE_ROLES = [
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
] as const;

deepFreeze(SERVER_FILE_ROLES);
