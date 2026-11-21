import { AsyncLocalStorage } from 'node:async_hooks';

import type { ScopeFrame } from '../types/scope-frame.type';

/**
 * Открытые работы областей в текущей цепочке вызовов. Один экземпляр на копию
 * пакета: две копии в монорепозитории друг друга не видят — известный предел
 * (тот же, что у транзакций pg-runtime).
 */
export const SCOPE_FRAMES = new AsyncLocalStorage<readonly ScopeFrame[]>();
