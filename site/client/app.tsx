/* The client island, now a React application: the whole script the site runs. On every page with a dataset listing (the home page, and each domain, subject, kind, tag and namespace page, which starts from its own filter) it mounts a Mantine-controlled, TanStack-table view over the generated search index; on an index of those pages it mounts the same controls over the index's list. The static table or list, and any link into the filtered listing, stay in the HTML as the no-JS baseline and are hidden once the island is live. On every page it turns each copy mount (a fetch command, a snapshot link) into a Mantine copy control; everywhere it registers the service worker. Every page still works without it: listings are static, commands are plain text. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ActionIcon, Badge, Button, type ComboboxRenderPillInput, CopyButton, MantineProvider, MultiSelect, NumberInput, Pill, SegmentedControl, Table as MantineTable, TextInput, Tooltip } from "@mantine/core";
import "@mantine/core/styles.css";
// Imported here and not by the map, because the stylesheet of a lazily loaded chunk is never linked to the page.
import "leaflet/dist/leaflet.css";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { type ColumnDef, createSortedRowModel, rowSortingFeature, tableFeatures, useTable } from "@tanstack/react-table";
import { entitiesText, entityTotal, sizeText, type Dimensions } from "../dimensions";
import { listingColumnWidths } from "../listing-columns";
import { matchingGroups, orderGroups, type GroupLink, type GroupOrder } from "../group-index";
import { EMPTY_LISTING_QUERY, FACETS, initialListingQuery, listingLocation, mapFacets, matchesFacets, parseListingQuery, type Facet, type FacetValues } from "../listing-query";
import { siteRoot } from "./site-root";
import "../styles.css";

/** A row of search-index.json, as site/build-site.ts writes it. */
interface SearchRecord extends Dimensions {
  readonly id: string;
  readonly namespace?: string;
  readonly aliases?: readonly string[];
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly kind: string;
  readonly subjects?: readonly string[];
  readonly tags: readonly string[];
  readonly namespaces?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchRecord(value: unknown): value is SearchRecord {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["kind"] === "string" && Array.isArray(value["tags"]);
}

/** The table's opt-in features, outside the component so the factories are created once: sorting is all the interactive listing needs, because filtering happens on the records before they reach the table. */
const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });

type ListingFeatures = typeof features;

/**
 * Whether a recorded count lies inside the bounds set on it. A count the entry does not record is inside no bound, so setting one hides the entries that cannot answer it.
 * @param count - The count, or undefined where the entry records none.
 * @param min - The least wanted, when set.
 * @param max - The most wanted, when set.
 * @returns True when the count passes every bound that is set.
 */
function within(count: number | undefined, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }

  return count !== undefined && (min === undefined || count >= min) && (max === undefined || count <= max);
}

/** A first-paint estimate of a listing row's height in pixels; every rendered row is measured, so the estimate only sizes the scrollbar until the first rows exist. */
const ESTIMATED_ROW_HEIGHT = 41;

/** How many rows beyond the viewport are rendered on each side, so a fast scroll does not show blank space. */
const ROW_OVERSCAN = 12;

/**
 * The values a record holds for each attribute the listing filters by.
 * @param record - The record.
 * @returns Its kind, domain, subjects, tags and namespaces, each empty where it holds none.
 */
function heldBy(record: SearchRecord): FacetValues {
  return { kind: [record.kind], domain: record.domain === undefined ? [] : [record.domain], subject: record.subjects ?? [], tag: record.tags, namespace: record.namespaces ?? [] };
}

/** Each attribute's filter as the controls show it: its accessible name, its placeholder, and whether its options list the most common first (tags, most of which name a field of one source only) or in label order. */
/** A filter holds one line whatever is chosen: only the first chosen value is drawn, carrying a count of the others. */
function facetPill(chosen: readonly string[], { value, onRemove, disabled }: ComboboxRenderPillInput): ReactElement | null {
  const [first] = chosen;
  if (value === undefined || value !== first) {
    return null;
  }

  return <Pill withRemoveButton={disabled !== true} {...(onRemove === undefined ? {} : { onRemove })}>{chosen.length > 1 ? `${value} +${String(chosen.length - 1)}` : value}</Pill>;
}

const FACET_CONTROLS: Readonly<Record<Facet, { readonly label: string; readonly placeholder: string; readonly byCount: boolean }>> = {
  kind: { label: "Kind", placeholder: "kind", byCount: false },
  domain: { label: "Domain", placeholder: "domain", byCount: false },
  subject: { label: "Subject", placeholder: "subject", byCount: false },
  tag: { label: "Tag", placeholder: "tag", byCount: true },
  namespace: { label: "Namespace", placeholder: "namespace", byCount: false },
};

/**
 * One attribute's options: every value a record holds, labelled with how many records hold it, and every value the query already chose, so a value from a shared link that no record holds still shows as chosen and can be removed.
 * @param records - Every record.
 * @param facet - The attribute.
 * @param chosen - The values already chosen.
 * @returns The chosen values first, then the rest, each group in the attribute's order.
 */
function facetOptions(records: readonly SearchRecord[], facet: Facet, chosen: readonly string[]): { value: string; label: string }[] {
  const counts = new Map<string, number>(chosen.map((value) => [value, 0]));
  for (const record of records) {
    for (const value of new Set(heldBy(record)[facet])) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const byLabel = [...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const ordered = FACET_CONTROLS[facet].byCount ? byLabel.sort(([, left], [, right]) => right - left) : byLabel;
  const picked = new Set(chosen);

  // The chosen values lead, in the attribute's own order, so they sit where a finger or the keyboard lands first and a click on one clears it.
  return [...ordered.filter(([value]) => picked.has(value)), ...ordered.filter(([value]) => !picked.has(value))].map(([value, count]) => ({ value, label: `${value} (${String(count)})` }));
}

/** Where a listing sits: the path back to the site root, the page's own filter as a query string (absent on the home listing), and the page's and the home listing's paths. */
interface ListingPlace {
  readonly root: string;
  readonly own: string | undefined;
  readonly here: string;
  readonly home: string;
}

/**
 * Writes a location into the page's URL in place, without a reload or a new history entry, so the address bar always holds a link to the view on screen.
 * @param location - The path and query string.
 */
function writeLocation(location: string): void {
  window.history.replaceState(window.history.state, "", `${location}${window.location.hash}`);
}

/** The interactive listing: filter inputs over the search index and a sortable table of what matches. The filters start from the page's own filter on a listing page and from the URL's query string on the home listing, and are written back to the URL on every change (see listingLocation). */
function Listing({ records, place }: { readonly records: readonly SearchRecord[]; readonly place: ListingPlace }): ReactNode {
  const [query, setQuery] = useState(() => initialListingQuery(place.own, window.location.search));
  useEffect(() => {
    writeLocation(listingLocation(query, place.own, place.here, place.home));
  }, [query, place]);

  const options = useMemo(() => mapFacets((facet) => facetOptions(records, facet, query.facets[facet])), [records, query.facets]);

  const filtered = useMemo(() => {
    const needle = query.text.trim().toLowerCase();

    return records.filter((record) => {
      if (!matchesFacets(heldBy(record), query.facets)) {
        return false;
      }
      if (!within(entityTotal(record), query.minEntities, query.maxEntities)) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const haystack = [record.id, record.namespace, ...(record.aliases ?? []), record.name, record.description, record.domain, ...(record.subjects ?? []), ...record.tags].filter((field): field is string => field !== undefined);

      return haystack.some((field) => field.toLowerCase().includes(needle));
    });
  }, [records, query]);

  // Column definitions are written as plain literals against the hook's own column type, not built through createColumnHelper: the helper infers each accessor over its own value type, which does not inter-type with the widened union under exactOptionalPropertyTypes. The order matches the static table's Name, Id, Kind, Domain so the two views of the listing read the same way.
  const columns: readonly ColumnDef<ListingFeatures, SearchRecord>[] = [
    { accessorKey: "name", header: "Name", cell: (info) => <a href={`${place.root}datasets/${info.row.original.id}/`}>{info.row.original.name}</a> },
    { accessorKey: "id", header: "Id", cell: (info) => <code>{info.row.original.id}</code> },
    { accessorKey: "kind", header: "Kind" },
    { accessorKey: "domain", header: "Domain" },
    /* Sorts by the sum of the recorded counts and shows each with its noun; an entry with no count sorts after every other, whichever way the column is sorted. */
    { id: "entities", accessorFn: (row) => entityTotal(row), header: "Entities", sortUndefined: "last", cell: (info) => entitiesText(info.row.original) },
    { id: "size", accessorFn: (row) => row.bytes, header: "Size", sortUndefined: "last", cell: (info) => sizeText(info.row.original) },
    { id: "tags", accessorFn: (row) => row.tags.join(", "), header: "Tags" },
  ];

  const table = useTable({ key: "listing", features, data: filtered, columns });
  // Sized from every record, not the filtered ones, so a filter never moves a column.
  const widths = useMemo(() => listingColumnWidths(records), [records]);

  // Only the rows near the viewport are rendered: the table is tall, and the page scrolls (not the table), so the virtualiser follows the window and is told where the table starts in the document.
  const rows = table.getRowModel().rows;
  const wrap = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    setScrollMargin((wrap.current?.getBoundingClientRect().top ?? 0) + window.scrollY);
  }, []);
  const virtualiser = useWindowVirtualizer({ count: rows.length, estimateSize: () => ESTIMATED_ROW_HEIGHT, overscan: ROW_OVERSCAN, scrollMargin });
  const items = virtualiser.getVirtualItems();
  const spaceAbove = items.length === 0 ? 0 : (items[0]?.start ?? 0) - scrollMargin;
  const spaceBelow = items.length === 0 ? 0 : virtualiser.getTotalSize() - (items.at(-1)?.end ?? 0);

  return (
    <>
      <div className="island-controls">
        <TextInput className="island-search" aria-label="Search the catalogue" placeholder="search the catalogue" value={query.text} onChange={(event) => {
          const text = event.currentTarget.value;
          setQuery((current) => ({ ...current, text }));
        }} />
        {FACETS.map((facet) => (
          <MultiSelect key={facet} className="island-filter" aria-label={FACET_CONTROLS[facet].label} placeholder={FACET_CONTROLS[facet].placeholder} data={options[facet]} value={[...query.facets[facet]]} onChange={(values) => { setQuery((current) => ({ ...current, facets: { ...current.facets, [facet]: values } })); }} clearable searchable renderPill={(pill) => facetPill(query.facets[facet], pill)} />
        ))}
        <div className="island-range" role="group" aria-label="Entities">
          <span className="island-range-label" aria-hidden="true">Entities</span>
          {([["min", "minEntities"], ["max", "maxEntities"]] as const).map(([key, field]) => (
            <NumberInput key={key} className="island-bound" aria-label={`${key === "min" ? "Minimum" : "Maximum"} entities`} placeholder={key} min={0} allowNegative={false} allowDecimal={false} value={query[field] ?? ""} onChange={(value) => { setQuery((current) => ({ ...current, [field]: typeof value === "number" ? value : undefined })); }} />
          ))}
        </div>
        <Badge variant="light" size="lg">
          {String(filtered.length)} of {String(records.length)}
        </Badge>
      </div>
      {/* The wrapper carries the same classes as the static listing's, so the mobile scroll and the desktop sticky header style both views identically. */}
      <div className="table-wrap listing" ref={wrap}>
        <MantineTable highlightOnHover>
          <MantineTable.Thead>
            {table.getHeaderGroups().map((group) => (
              <MantineTable.Tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();

                  return (
                    <MantineTable.Th key={header.id} className="sortable" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"} style={{ width: widths[header.index] }}>
                      {/* A button, so a header is reachable and sortable from the keyboard; the mark shows which way the column is sorted, or that it can be. */}
                      <button type="button" className="sort-button" onClick={header.column.getToggleSortingHandler()}>
                        <table.FlexRender header={header} />
                        <span className="sort-mark" aria-hidden="true">{sorted === false ? " ↕" : sorted === "asc" ? " ↑" : " ↓"}</span>
                      </button>
                    </MantineTable.Th>
                  );
                })}
              </MantineTable.Tr>
            ))}
          </MantineTable.Thead>
          <MantineTable.Tbody>
            {rows.length === 0 ? <tr><td className="island-empty" colSpan={columns.length}>No datasets match these filters.</td></tr> : null}
            {spaceAbove > 0 ? <tr aria-hidden="true" style={{ height: spaceAbove }} /> : null}
            {items.map((item) => {
              const row = rows[item.index];
              if (row === undefined) {
                return null;
              }

              // Stripes follow the row's place in the whole listing, not its place among the rendered rows, which changes as the window moves.
              return (
                <MantineTable.Tr key={row.id} data-index={item.index} ref={virtualiser.measureElement} style={item.index % 2 === 0 ? undefined : { background: "var(--table-striped-color)" }}>
                  {row.getAllCells().map((cell) => {
                    const value = cell.getValue();

                    // Cells are cut to one line with an ellipsis, so a string value is also the cell's title, which is how the full text is read.
                    return (
                      <MantineTable.Td key={cell.id} title={typeof value === "string" ? value : undefined}>
                        <table.FlexRender cell={cell} />
                      </MantineTable.Td>
                    );
                  })}
                </MantineTable.Tr>
              );
            })}
            {spaceBelow > 0 ? <tr aria-hidden="true" style={{ height: spaceBelow }} /> : null}
          </MantineTable.Tbody>
        </MantineTable>
      </div>
    </>
  );
}

/** The interactive index of listing pages: a text filter over the labels, a choice of order and the list of what matches. The text is read from the URL's query string when the index mounts and written back to it on every change, as the listing's is. */
function GroupIndex({ groups, noun, initialOrder }: { readonly groups: readonly GroupLink[]; readonly noun: string; readonly initialOrder: GroupOrder }): ReactNode {
  const [text, setText] = useState(() => parseListingQuery(window.location.search).text);
  const [order, setOrder] = useState(initialOrder);
  useEffect(() => {
    writeLocation(listingLocation({ ...EMPTY_LISTING_QUERY, text }, undefined, window.location.pathname, window.location.pathname));
  }, [text]);
  const shown = useMemo(() => orderGroups(matchingGroups(groups, text), order), [groups, text, order]);

  return (
    <>
      <div className="island-controls">
        <TextInput className="island-search" aria-label={`Filter the ${noun}`} placeholder={`filter the ${noun}`} value={text} onChange={(event) => {
          setText(event.currentTarget.value);
        }} />
        <SegmentedControl aria-label="Order" value={order} onChange={(value) => {
          if (isGroupOrder(value)) {
            setOrder(value);
          }
        }} data={[{ value: "label", label: "By name" }, { value: "count", label: "Most datasets first" }]} />
        <Badge variant="light" size="lg">
          {String(shown.length)} of {String(groups.length)}
        </Badge>
      </div>
      {shown.length === 0 ? <p className="island-empty">No {noun} match this filter.</p> : <ul className="groups">{shown.map((group) => <li key={group.path}><a href={group.path}>{group.label}</a> ({group.count})</li>)}</ul>}
    </>
  );
}

/**
 * Reads an index's groups back from its static list, which carries each one's link, label and count, so the page does not hold them twice.
 * @param mount - The index island's mount, which the list follows.
 * @returns The groups, in the list's order.
 */
function staticGroups(mount: HTMLElement): GroupLink[] {
  return [...(mount.parentElement?.querySelectorAll<HTMLLIElement>("ul.groups.island-baseline > li") ?? [])].map((item) => {
    const link = item.querySelector("a");
    const { count } = item.dataset;
    const path = link?.getAttribute("href");
    if (link === null || path === null || path === undefined || count === undefined) {
      throw new Error("an index list item has no link or no count");
    }

    return { label: link.textContent, path, count: Number(count) };
  });
}

function isGroupOrder(value: string): value is GroupOrder {
  return value === "label" || value === "count";
}

/** How a copy mount is drawn: a labelled button, as for a fetch command, or a bare icon, as beside a link. */
type CopyStyle = "button" | "icon";

function isCopyStyle(value: string): value is CopyStyle {
  return value === "button" || value === "icon";
}

/** The two-sheet copy glyph, or a tick once the text is on the clipboard. */
function CopyGlyph({ copied }: { readonly copied: boolean }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {copied ? (
        <path d="M5 12l5 5L20 7" />
      ) : (
        <>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </>
      )}
    </svg>
  );
}

/** One copy affordance, rendered where the generator left a mount naming the text to copy and how to draw it. */
function CopyText({ text, label, style }: { readonly text: string; readonly label: string; readonly style: CopyStyle }): ReactNode {
  return (
    <CopyButton value={text} timeout={2000}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : label} withArrow>
          {style === "icon" ? (
            <ActionIcon aria-label={label} color={copied ? "teal" : "accent"} size="sm" variant="subtle" onClick={copy}>
              <CopyGlyph copied={copied} />
            </ActionIcon>
          ) : (
            <Button color={copied ? "teal" : "accent"} size="compact-xs" variant="light" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </Tooltip>
      )}
    </CopyButton>
  );
}

async function mountListing(root: string, mount: HTMLElement): Promise<void> {
  const { listingQuery } = mount.dataset;
  const place: ListingPlace = { root, own: listingQuery, here: window.location.pathname, home: new URL(root, window.location.href).pathname };
  const response = await fetch(`${root}search-index.json`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed) || !parsed.every(isSearchRecord)) {
    throw new Error("search-index.json is not a list of search records");
  }
  createRoot(mount).render(
    <MantineProvider defaultColorScheme="auto">
      <Listing records={parsed} place={place} />
    </MantineProvider>,
  );
}

const root = siteRoot();

const listing = document.querySelector<HTMLElement>("#island-root");
if (listing !== null) {
  void mountListing(root, listing).then(() => {
    // Only now does the interactive view take over: the live class shows the mount, and the stylesheet hides the static listing that follows it.
    listing.classList.add("island-live");
  });
}

const index = document.querySelector<HTMLElement>("#groups-root");
if (index !== null) {
  const { noun, order } = index.dataset;
  if (noun === undefined || order === undefined || !isGroupOrder(order)) {
    throw new Error("the index mount names no noun or no known order");
  }
  createRoot(index).render(
    <MantineProvider defaultColorScheme="auto">
      <GroupIndex groups={staticGroups(index)} noun={noun} initialOrder={order} />
    </MantineProvider>,
  );
  index.classList.add("island-live");
}

// The preview and its helpers load only on a page that has a preview mount; the listing and the other pages never fetch them.
if (document.querySelector("[data-preview-id]") !== null) {
  void import("./preview").then(({ mountPreviews }) => {
    mountPreviews();
  });
}

for (const mount of document.querySelectorAll<HTMLElement>("[data-copy-text]")) {
  const { copyText, copyLabel = "Copy", copyStyle = "button" } = mount.dataset;
  if (copyText === undefined) {
    throw new Error("a copy mount has no text to copy");
  }
  if (!isCopyStyle(copyStyle)) {
    throw new Error(`a copy mount asks for the unknown style ${copyStyle}`);
  }
  createRoot(mount).render(
    <MantineProvider defaultColorScheme="auto">
      <CopyText text={copyText} label={copyLabel} style={copyStyle} />
    </MantineProvider>,
  );
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register(`${root}sw.js`, { scope: root === "" ? "./" : root });
}
