/** Роль сессии и её членства — для проверки на старте. */
export interface RoleFacts {
  role: string;
  /** Это `current_user` (роль, под которой идут запросы). */
  current: boolean;
  /** Это `session_user` (роль входа: `SET ROLE NONE` возвращает к ней). */
  session: boolean;
  superuser: boolean;
  bypass: boolean;
  replication: boolean;
  /** CREATEROLE на сервере ниже 16 — выдача себе членства в любой роли без суперправ. */
  createrole: boolean;
  escalations: string[];
  /** Функции чтения файлов сервера, которые роль (через любую доступную ей роль) может исполнять. */
  file_functions: string[];
  maintenance: boolean | null;
  context: string | null;
  /** Причина сквозного доступа вне транзакции (сессионный SET, ALTER ROLE/DATABASE … SET). */
  reason: string | null;
}
