/**
 * Есть ли `security_invoker` истиной в списке параметров `WITH (…)`
 * представления (текст оператора, с литералами): `security_invoker`,
 * `security_invoker = true|on|yes|1|'true'`. Нет параметров — ложь.
 */
export function viewIsInvoker(options: string | undefined): boolean {
  return (options ?? '').split(',').some((option) => {
    const [name, value] = option.split('=').map((part) =>
      part
        .trim()
        .replace(/^'(.*)'$/, '$1')
        .toLowerCase(),
    );
    return (
      name === 'security_invoker' && (value === undefined || /^(?:t|tr|tru|true|y|ye|yes|on|1)$/.test(value))
    );
  });
}
