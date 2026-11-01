import { ruleSides, type OneWayRule, type TwoWayRule } from "crossmap";

/** A crosswalk rule seen the same way whatever its operation: what it reads, what it writes and the direction it applies in. */
export interface RuleView {
  readonly op: string;
  /** The paths the rule reads when it encodes. */
  readonly from: readonly string[];
  /** The paths the rule writes when it encodes. */
  readonly to: readonly string[];
  /** The direction the rule applies in: both for a two-way rule, the one named for a one-way rule. */
  readonly direction: "both" | "encode" | "decode";
  /** What the operation adds to its paths (a default's value as JSON, an aggregate's function), when it has something to add. */
  readonly detail?: string;
}

/**
 * Describes a crosswalk rule by the paths it reads and writes, so a consumer that only needs the paths (the separability check, the command line's and the site's rule listings) covers every operation the format has, without its own list of which field of which operation holds a path.
 * @param rule - A two-way or one-way rule.
 * @returns The rule as a view.
 */
export function describeRule(rule: TwoWayRule | OneWayRule): RuleView {
  switch (rule.op) {
    case "drop":
      return { op: rule.op, from: [rule.from], to: [], direction: rule.direction };
    case "default":
      return { op: rule.op, from: [], to: [rule.to], direction: rule.direction, detail: JSON.stringify(rule.value) };
    case "aggregate":
      return { op: rule.op, from: [rule.from], to: [rule.to], direction: rule.direction, detail: rule.fn };
    case "move":
    case "scale":
    case "enum":
    case "format":
    case "split":
    case "template":
    case "copy":
      return { op: rule.op, ...ruleSides(rule), direction: "both" };
    default:
      return rule satisfies never;
  }
}
