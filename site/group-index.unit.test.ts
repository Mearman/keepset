import { describe, expect, it } from "vitest";
import { byText, groupLabel, matchingGroups, orderGroups } from "./group-index";

const groups = [
  { label: "weight", path: "weight/", count: 2 },
  { label: "Cost", path: "cost/", count: 3 },
  { label: "rare", path: "rare/", count: 1 },
  { label: "area", path: "area/", count: 3 },
];

describe("the index of listing pages", () => {
  it("orders by label in code unit order, whatever the locale", () => {
    expect(orderGroups(groups, "label").map((group) => group.label)).toEqual(["Cost", "area", "rare", "weight"]);
  });

  it("orders by count with the most first and ties by label", () => {
    expect(orderGroups(groups, "count").map((group) => group.label)).toEqual(["Cost", "area", "weight", "rare"]);
  });

  it("leaves the given array as it was", () => {
    const before = groups.map((group) => group.label);
    orderGroups(groups, "count");
    expect(groups.map((group) => group.label)).toEqual(before);
  });

  it("matches text anywhere in a label, ignoring letter case and surrounding space, and blank text matches every group", () => {
    expect(matchingGroups(groups, " CO ").map((group) => group.label)).toEqual(["Cost"]);
    expect(matchingGroups(groups, "ar").map((group) => group.label)).toEqual(["rare", "area"]);
    expect(matchingGroups(groups, "  ")).toEqual(groups);
    expect(matchingGroups(groups, "nothing")).toEqual([]);
  });

  it("joins a page's several labels into the one label its index shows", () => {
    expect(groupLabel(["Weight", "weight"])).toBe("Weight, weight");
    expect(byText("Weight", "weight")).toBeLessThan(0);
  });
});
