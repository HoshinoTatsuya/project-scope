/** Подпрограмма или сопоставление пользователя, через которые сессия выходит из-под политик области. */
export interface OwnerRightsFacts {
  /** `routine` — функция или процедура (`regprocedure`), `mapping` — сопоставление пользователя. */
  kind: 'routine' | 'mapping';
  /** Подпись функции или имя внешнего сервера. */
  name: string;
  /** Владелец функции или роль сопоставления (`PUBLIC`). */
  owner: string;
  /** Как сессия до неё дотягивается: `execute`, `trigger`, `event-trigger`. */
  paths: string[];
  /** SECURITY DEFINER, и владелец обходит политики области. */
  definer: boolean;
  /** Определение задаёт параметр области или причины (`proconfig`). */
  sets_scope: boolean;
  leakproof: boolean;
}
