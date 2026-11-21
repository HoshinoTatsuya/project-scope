/**
 * Подзапрос `SELECT oid` ролей, чьими правами могут воспользоваться роли
 * `users` (SQL: строки с одной колонкой — имя или oid роли; по умолчанию
 * `current_user` и `session_user`): наследуют их права или входят в них
 * `SET ROLE`. Ниже Postgres 16 это любое членство (`MEMBER`). С 16 членство
 * бывает без обоих (`GRANT … WITH INHERIT FALSE, SET FALSE`) — оно не даёт ни
 * прав, ни `SET ROLE` и не считается; членство с ADMIN OPTION считается: им
 * роль выдаёт себе `SET` и входит в роль. CASE, а не OR: тип права `SET` ниже
 * 16 — ошибка, и порядок вычисления должен быть гарантирован.
 *
 * Один источник для всех проверок доступа: права на отношения, функции,
 * политики «на роль», членства — чтобы они не разошлись в понимании
 * «роль доступна».
 */
export function reachableRolesSql(users = '(VALUES (current_user), (session_user))'): string {
  return `SELECT r.oid FROM pg_roles r, ${users} AS u(member)
   WHERE CASE WHEN current_setting('server_version_num')::int < 160000
              THEN pg_has_role(u.member, r.oid, 'MEMBER')
              ELSE pg_has_role(u.member, r.oid, 'USAGE') OR pg_has_role(u.member, r.oid, 'SET')
                   OR EXISTS (SELECT 1 FROM pg_roles a
                               WHERE pg_has_role(u.member, a.oid, 'MEMBER WITH ADMIN OPTION')
                                 AND pg_has_role(a.oid, r.oid, 'MEMBER'))
         END`;
}
