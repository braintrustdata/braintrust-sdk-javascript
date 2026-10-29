export function _urljoin(...parts: string[]): string {
  return parts
    .map((x, i) =>
      x.replace(/^\//, "").replace(i < parts.length - 1 ? /\/$/ : "", ""),
    )
    .filter((x) => x.trim() !== "")
    .join("/");
}

export function capitalize(s: string, sep?: string): string {
  const items = sep ? s.split(sep) : [s];
  return items
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .join(sep || "");
}

export function lowercase(s: string, sep?: string): string {
  const items = sep ? s.split(sep) : [s];
  return items
    .map((s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s))
    .join(sep || "");
}

export function snakeToCamelCase(s: string): string {
  return s
    .split("_")
    .map((s) => capitalize(s))
    .join("");
}

export function snakeToTitleCase(s: string): string {
  return capitalize(s, "_").replace("_", " ");
}

export function camelToSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, (m) => "_" + m.toLowerCase()).replace(/^_/, "");
}

/**
 * Simplified slugify implementation based on the slugify library
 * Original: https://github.com/simov/slugify (MIT License)
 * Simplified to support only the options we use: lower, strict, trim
 */
export function slugify(
  text: string,
  options?: { lower?: boolean; strict?: boolean; trim?: boolean },
): string {
  if (typeof text !== "string") {
    throw new Error("slugify: string argument expected");
  }

  // Basic character map for common Unicode characters
  const charMap: Record<string, string> = {
    // Currency and symbols
    $: "dollar",
    "%": "percent",
    "&": "and",
    // Latin characters
    À: "A",
    Á: "A",
    Â: "A",
    Ã: "A",
    Ä: "A",
    Å: "A",
    Æ: "AE",
    Ç: "C",
    È: "E",
    É: "E",
    Ê: "E",
    Ë: "E",
    Ì: "I",
    Í: "I",
    Î: "I",
    Ï: "I",
    Ñ: "N",
    Ò: "O",
    Ó: "O",
    Ô: "O",
    Õ: "O",
    Ö: "O",
    Ø: "O",
    Ù: "U",
    Ú: "U",
    Û: "U",
    Ü: "U",
    Ý: "Y",
    à: "a",
    á: "a",
    â: "a",
    ã: "a",
    ä: "a",
    å: "a",
    æ: "ae",
    ç: "c",
    è: "e",
    é: "e",
    ê: "e",
    ë: "e",
    ì: "i",
    í: "i",
    î: "i",
    ï: "i",
    ñ: "n",
    ò: "o",
    ó: "o",
    ô: "o",
    õ: "o",
    ö: "o",
    ø: "o",
    ù: "u",
    ú: "u",
    û: "u",
    ü: "u",
    ý: "y",
    ÿ: "y",
  };

  const replacement = "-";
  const trim = options?.trim !== false; // Default to true

  // Normalize and map characters
  let slug = text
    .normalize()
    .split("")
    .reduce((result, ch) => {
      const mapped = charMap[ch] || ch;
      // Replace replacement character with space to be processed later
      const appendChar = mapped === replacement ? " " : mapped;
      return (
        result +
        appendChar
          // Remove characters that aren't word chars, spaces, or basic punctuation
          .replace(/[^\w\s$*_+~.()'"!\-:@]+/g, "")
      );
    }, "");

  // Apply strict mode (only alphanumeric and spaces)
  if (options?.strict) {
    slug = slug.replace(/[^A-Za-z0-9\s]/g, "");
  }

  // Trim whitespace
  if (trim) {
    slug = slug.trim();
  }

  // Replace spaces with replacement character
  slug = slug.replace(/\s+/g, replacement);

  // Apply lowercase
  if (options?.lower) {
    slug = slug.toLowerCase();
  }

  return slug;
}
