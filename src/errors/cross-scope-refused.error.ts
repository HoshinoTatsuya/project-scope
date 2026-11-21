/** Сквозной доступ не разрешён: нет роли, нет причины или сессия не под ролью сквозного доступа. */
export class CrossScopeRefusedError extends Error {
  override readonly name = 'CrossScopeRefusedError';
}
