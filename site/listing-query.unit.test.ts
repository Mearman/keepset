import { describe, expect, it } from "vitest";
import { EMPTY_LISTING_QUERY, facetQuery, matchesFacets, parseListingQuery, serialiseListingQuery, type ListingQuery } from "./listing-query";

const full: ListingQuery = {
  text: "lead time & cost",
  facets: { kind: ["graph", "tasks"], domain: ["facility-location", "supply-chain-planning"], subject: ["operations-research"], tag: ["Lead_Time", "weight"], namespace: ["suitesparse/gset"] },
  minEntities: 10,
  maxEntities: 5000,
};

describe("the listing query in the URL", () => {
  it("writes each attribute's values joined by commas, then the bounds, then the text", () => {
    expect(serialiseListingQuery(full)).toBe("?kind=graph,tasks&domain=facility-location,supply-chain-planning&subject=operations-research&tag=Lead_Time,weight&namespace=suitesparse/gset&min-entities=10&max-entities=5000&q=lead%20time%20%26%20cost");
  });

  it("reads back exactly the query it wrote", () => {
    expect(parseListingQuery(serialiseListingQuery(full))).toEqual(full);
    expect(parseListingQuery(serialiseListingQuery(EMPTY_LISTING_QUERY))).toEqual(EMPTY_LISTING_QUERY);
  });

  it("writes nothing for a query that filters nothing, and leaves out every empty part", () => {
    expect(serialiseListingQuery(EMPTY_LISTING_QUERY)).toBe("");
    expect(serialiseListingQuery({ ...EMPTY_LISTING_QUERY, text: "   " })).toBe("");
    expect(serialiseListingQuery(facetQuery("subject", ["network-science"]))).toBe("?subject=network-science");
  });

  it("encodes a value holding the separator or a character the query string reserves, so it reads back whole", () => {
    const awkward = facetQuery("domain", ["a,b", "c&d=e", "50% off", "x+y", "#hash", "café", "plain"]);
    const written = serialiseListingQuery(awkward);
    expect(written).toBe("?domain=a%2Cb,c%26d%3De,50%25%20off,x%2By,%23hash,caf%C3%A9,plain");
    expect(parseListingQuery(written)).toEqual(awkward);
  });

  it("ignores parameters it does not know, empty values and malformed encodings", () => {
    expect(parseListingQuery("?utm_source=x&kind=&domain=,,a,&tag=%E0%A4,ok&q=%&min-entities=ten&max-entities=-1")).toEqual({ ...EMPTY_LISTING_QUERY, facets: { ...EMPTY_LISTING_QUERY.facets, domain: ["a"], tag: ["ok"] } });
    expect(parseListingQuery("")).toEqual(EMPTY_LISTING_QUERY);
    expect(parseListingQuery("?")).toEqual(EMPTY_LISTING_QUERY);
  });

  it("gathers an attribute named more than once, each value once in the order first given, and reads a plus as a space", () => {
    expect(parseListingQuery("tag=b,a&tag=a,c&q=two+words").facets.tag).toEqual(["b", "a", "c"]);
    expect(parseListingQuery("q=two+words").text).toBe("two words");
  });
});

describe("matching an entry's attributes", () => {
  const held = { kind: ["graph"], domain: ["Social network"], subject: ["network-science", "social-science"], tag: ["weight"], namespace: ["konect", "konect/social"] };

  it("matches any chosen value of one attribute", () => {
    expect(matchesFacets(held, facetQuery("subject", ["operations-research", "social-science"]).facets)).toBe(true);
    expect(matchesFacets(held, facetQuery("subject", ["operations-research"]).facets)).toBe(false);
  });

  it("requires every attribute with values chosen to match", () => {
    expect(matchesFacets(held, { ...EMPTY_LISTING_QUERY.facets, kind: ["graph"], namespace: ["konect"] })).toBe(true);
    expect(matchesFacets(held, { ...EMPTY_LISTING_QUERY.facets, kind: ["graph"], tag: ["cost"] })).toBe(false);
  });

  it("matches everything when nothing is chosen, and nothing on an attribute the entry does not hold", () => {
    expect(matchesFacets(held, EMPTY_LISTING_QUERY.facets)).toBe(true);
    expect(matchesFacets({ ...held, domain: [] }, facetQuery("domain", ["Social network"]).facets)).toBe(false);
  });
});
