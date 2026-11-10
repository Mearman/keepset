/* The interactive listing's filter state and its form in the URL's query string, which is the state's single source of truth: the island reads it on load and writes it back on every change, so any filtered view is a link that can be shared. The generator writes the same links from its listing pages into the filtered listing. Pure, with no DOM and no Node, so the generator, the client island and the tests share it. */

/** The attributes the listing filters by, in the order the query string writes them; each is also the name of its URL parameter. Several values of one attribute match an entry holding any of them, and several attributes must all match. */
export const FACETS = ["kind", "domain", "subject", "tag", "namespace"] as const;

/** One of the attributes the listing filters by. */
export type Facet = (typeof FACETS)[number];

/** The values chosen for each attribute; an attribute with none does not filter. */
export type FacetValues = Readonly<Record<Facet, readonly string[]>>;

/** Everything the listing filters by. */
export interface ListingQuery {
  /** The free text an entry's names, description, domain, subjects or tags must contain; empty or blank for none. */
  readonly text: string;
  readonly facets: FacetValues;
  /** The least entity total an entry may have, when set. */
  readonly minEntities: number | undefined;
  /** The greatest entity total an entry may have, when set. */
  readonly maxEntities: number | undefined;
}

/** The URL parameters of the scalar parts of the query; each attribute's parameter is its own name. */
const TEXT_PARAMETER = "q";
const MIN_PARAMETER = "min-entities";
const MAX_PARAMETER = "max-entities";

/** What separates the values of one attribute in its parameter; a value holding it is percent-encoded, so the separator is never ambiguous. */
const VALUE_SEPARATOR = ",";

/**
 * Builds a record with one value for each attribute.
 * @param value - The value for an attribute.
 * @returns The record.
 */
export function mapFacets<T>(value: (facet: Facet) => T): Readonly<Record<Facet, T>> {
  return { kind: value("kind"), domain: value("domain"), subject: value("subject"), tag: value("tag"), namespace: value("namespace") };
}

/** The query that filters nothing. */
export const EMPTY_LISTING_QUERY: ListingQuery = { text: "", facets: mapFacets(() => []), minEntities: undefined, maxEntities: undefined };

/**
 * The query that selects the entries holding any of some values of one attribute, which is the link a listing page of that attribute gives into the filtered listing.
 * @param facet - The attribute.
 * @param values - The values.
 * @returns The query.
 */
export function facetQuery(facet: Facet, values: readonly string[]): ListingQuery {
  return { ...EMPTY_LISTING_QUERY, facets: { ...EMPTY_LISTING_QUERY.facets, [facet]: values } };
}

function isFacet(name: string): name is Facet {
  return FACETS.some((facet) => facet === name);
}

/**
 * Decodes one percent-encoded component of a query string, reading `+` as a space as a submitted form writes it.
 * @param component - The encoded text.
 * @returns The text, or undefined where the encoding is malformed (a stray `%` or bytes that are not UTF-8), which a hand-edited link can hold.
 */
function decode(component: string): string | undefined {
  try {
    return decodeURIComponent(component.replaceAll("+", " "));
  } catch (error) {
    if (error instanceof URIError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Percent-encodes a value for a query string, leaving the characters a query may hold as they are where that keeps a namespace path or a URL-like value readable. The separator, `&`, `=`, `+`, `#`, `%` and spaces are always encoded.
 * @param value - The value.
 * @returns The encoded value.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/").replaceAll("%3A", ":").replaceAll("%40", "@");
}

/**
 * Reads a bound on the entity total: a whole number of decimal digits.
 * @param text - The parameter's value.
 * @returns The bound, or undefined where the text is not one.
 */
function bound(text: string): number | undefined {
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * Reads the listing's filters from a URL's query string. Parameters the listing does not know, empty values and malformed encodings are ignored; an attribute named more than once takes every value its parameters give, each once, in the order first given.
 * @param search - The query string, with or without its leading `?`.
 * @returns The query.
 */
export function parseListingQuery(search: string): ListingQuery {
  const facets = new Map<Facet, string[]>();
  let text = "";
  let minEntities: number | undefined;
  let maxEntities: number | undefined;
  for (const pair of search.replace(/^\?/, "").split("&")) {
    const at = pair.indexOf("=");
    const name = decode(at === -1 ? pair : pair.slice(0, at));
    const raw = at === -1 ? "" : pair.slice(at + 1);
    if (name === undefined) {
      continue;
    }
    if (isFacet(name)) {
      const values = facets.get(name) ?? [];
      for (const value of raw.split(VALUE_SEPARATOR).map(decode)) {
        if (value !== undefined && value !== "" && !values.includes(value)) {
          values.push(value);
        }
      }
      facets.set(name, values);
    } else if (name === TEXT_PARAMETER) {
      text = decode(raw) ?? text;
    } else if (name === MIN_PARAMETER) {
      minEntities = bound(raw) ?? minEntities;
    } else if (name === MAX_PARAMETER) {
      maxEntities = bound(raw) ?? maxEntities;
    }
  }

  return {
    text,
    facets: mapFacets((facet) => facets.get(facet) ?? []),
    minEntities,
    maxEntities,
  };
}

/**
 * Writes the listing's filters as a URL's query string: each attribute that has values as one parameter of them separated by commas, then the entity bounds that are set, then the free text unless it is blank. Parsing the result gives the same query back.
 * @param query - The query.
 * @returns The query string with its leading `?`, or the empty string for a query that filters nothing.
 */
export function serialiseListingQuery(query: ListingQuery): string {
  const parameters = [
    ...FACETS.flatMap((facet) => (query.facets[facet].length === 0 ? [] : [`${facet}=${query.facets[facet].map(encode).join(VALUE_SEPARATOR)}`])),
    ...(query.minEntities === undefined ? [] : [`${MIN_PARAMETER}=${String(query.minEntities)}`]),
    ...(query.maxEntities === undefined ? [] : [`${MAX_PARAMETER}=${String(query.maxEntities)}`]),
    ...(query.text.trim() === "" ? [] : [`${TEXT_PARAMETER}=${encode(query.text)}`]),
  ];

  return parameters.length === 0 ? "" : `?${parameters.join("&")}`;
}

/**
 * Whether an entry's attributes match the chosen values: for every attribute with values chosen, the entry holds at least one of them.
 * @param held - The values the entry holds for each attribute.
 * @param facets - The chosen values.
 * @returns True when every attribute with values chosen matches.
 */
export function matchesFacets(held: FacetValues, facets: FacetValues): boolean {
  return FACETS.every((facet) => facets[facet].length === 0 || facets[facet].some((value) => held[facet].includes(value)));
}
