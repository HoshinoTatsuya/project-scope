/**
 * Длина текста, как её видит человек: в кодовых точках (эмодзи — один знак, а
 * не два UTF-16), без невидимых (`\p{Cf}`: пробел нулевой ширины, BOM;
 * `Default_Ignorable_Code_Point`: заполнители вроде U+3164) и управляющих
 * символов, пробелы любого вида подряд — один, по краям — ни одного. Причина
 * из десяти пробелов нулевой ширины иначе прошла бы порог длины, ничего не
 * объяснив.
 */
export function visibleLength(text: string): number {
  const visible = text
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ' ')
    .replace(/[\p{Z}\s]+/gu, ' ')
    .trim();
  return [...visible].length;
}
