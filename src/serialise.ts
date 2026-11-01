import type { Crosswalk, MoveRule, TwoWayRule } from "crossmap";
import type { Entry } from "./entry";
import type { Manifest } from "./manifest";

/**
 * Copies a JSON value with every object's keys in ascending code-unit order, the order the house JSON lint (`json/sort-keys`) requires of committed JSON. `Object.fromEntries` defines each key as an own data property, so a key such as `__proto__` stays a key.
 * @param value - A JSON value.
 * @returns The same value with sorted keys.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }

  return value;
}

/**
 * Serialises any JSON value in the committed form: two-space indented, keys in ascending order, with a trailing newline.
 * @param value - A JSON value.
 * @returns The file text.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), undefined, 2)}\n`;
}

/** Where the JSON Schema of each catalogue document is published, named by the `$schema` line `serialise` writes: inside the npm package that ships it, which jsDelivr serves at a stable address, since the schemas are generated at build and committed nowhere. */
export const ENTRY_SCHEMA_URL = "https://cdn.jsdelivr.net/npm/keepset/schemas/entry.schema.json";
export const MANIFEST_SCHEMA_URL = "https://cdn.jsdelivr.net/npm/keepset/schemas/manifest.schema.json";
export const CROSSWALK_SCHEMA_URL = "https://cdn.jsdelivr.net/npm/crossmap/schemas/crossmap.schema.json";

/**
 * Whether a rule only carries a path across unchanged, which a crosswalk document writes in its `keep` list instead of as a rule of its own.
 * @param rule - A two-way rule.
 * @returns True for a move of a path to itself with no `when`.
 */
function isKept(rule: TwoWayRule): rule is MoveRule {
  return rule.op === "move" && rule.from === rule.to && rule.when === undefined;
}

/**
 * The document a crosswalk is written as, without a `$schema` of its own (a crosswalk file adds it, and one inside an entry is covered by the entry's): its source and target, the paths it carries unchanged as `keep`, then the rules and one-way rules it has, each list left out when empty because parsing defaults it to empty.
 * @param crosswalk - A parsed crosswalk.
 * @returns The crosswalk document.
 */
function crosswalkDocument(crosswalk: Crosswalk): object {
  const { source, target, rules, oneWay } = crosswalk;
  const kept = rules.filter(isKept);
  const written = rules.filter((rule) => !isKept(rule));

  return {
    source,
    target,
    ...(kept.length > 0 ? { keep: kept.map((rule) => rule.from) } : {}),
    ...(written.length > 0 ? { rules: written } : {}),
    ...(oneWay.length > 0 ? { oneWay } : {}),
  };
}

/**
 * Serialises a catalogue document (an entry, a manifest or a crosswalk file) as its file holds it: two-space indented JSON with keys in ascending order and a trailing newline, naming the JSON Schema it is written against, and for a crosswalk with the paths it carries unchanged as a `keep` list. The form depends only on the document, so equal documents give equal text.
 * @param doc - A parsed entry, manifest or crosswalk.
 * @returns The file text.
 */
export function serialise(doc: Entry | Manifest | Crosswalk): string {
  if ("category" in doc) {
    return canonicalJson({ ...doc, $schema: ENTRY_SCHEMA_URL, crosswalk: "file" in doc.crosswalk ? doc.crosswalk : crosswalkDocument(doc.crosswalk) });
  }
  if ("repository" in doc) {
    return canonicalJson({ ...doc, $schema: MANIFEST_SCHEMA_URL });
  }

  return canonicalJson({ ...crosswalkDocument(doc), $schema: CROSSWALK_SCHEMA_URL });
}
