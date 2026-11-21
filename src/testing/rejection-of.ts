/** Отказ промиса → сам отказ; успех — ошибка проверки. */
export const rejectionOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => {
      throw new Error('ожидался отказ');
    },
    (error: unknown) => error,
  );
