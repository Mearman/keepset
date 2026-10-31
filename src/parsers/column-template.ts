/** One piece of a column template: literal text, or the name of the column whose cell fills that place. */
export type TemplatePart = string | { readonly column: string };

/** What reading a template gives: its parts in order, or why it is not a template. */
export type TemplateReading = { readonly parts: readonly TemplatePart[]; readonly problem?: never } | { readonly problem: string; readonly parts?: never };

/** A placeholder: a column name between braces, which holds no brace. */
const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * Reads a column template: text in which each `{column}` is replaced by that column's cell. A brace that is not part of a placeholder has no escape and is refused, as is a template with no placeholder, which would be the same text in every row. A placeholder's name is taken as written, so whether it names a column is for the caller to check against the columns it has.
 * @param template - The template.
 * @returns The template's parts in order, or the problem with it.
 */
export function readTemplate(template: string): TemplateReading {
  const parts: TemplatePart[] = [];
  let end = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const literal = template.slice(end, match.index);
    if (/[{}]/.test(literal)) {
      return { problem: "a brace outside a placeholder" };
    }
    if (literal !== "") {
      parts.push(literal);
    }
    parts.push({ column: match[1] ?? "" });
    end = match.index + match[0].length;
  }
  const tail = template.slice(end);
  if (/[{}]/.test(tail)) {
    return { problem: "a brace outside a placeholder" };
  }
  if (tail !== "") {
    parts.push(tail);
  }
  if (!parts.some((part) => typeof part !== "string")) {
    return { problem: "no placeholder naming a column" };
  }

  return { parts };
}

/**
 * The columns a template's placeholders name, each once, in order of first appearance.
 * @param parts - The parts of a template read by `readTemplate`.
 * @returns The column names.
 */
export function templateColumns(parts: readonly TemplatePart[]): string[] {
  const names = parts.flatMap((part) => (typeof part === "string" ? [] : [part.column]));

  return [...new Set(names)];
}
