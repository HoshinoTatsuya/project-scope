/** Внешний ключ из таблицы области на общую таблицу с каскадом, которую роль сессии может менять. */
export interface SharedCascadeFacts {
  name: string;
  child: string;
  parent: string;
  /** Действия ключа: `ON DELETE …`, `ON UPDATE …` — те, что меняют строки ребёнка. */
  actions: string[];
}
