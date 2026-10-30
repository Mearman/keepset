/* The client island, now a React application: the whole script the site runs. On a page with a dataset listing it mounts a Mantine-controlled, TanStack-table view over the generated search index (the static table and form stay in the HTML as the no-JS baseline and are hidden once the island is live); on every page it turns each copy mount (a fetch command, a snapshot link) into a Mantine copy control; everywhere it registers the service worker. Every page still works without it: listings are static, commands are plain text. */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ActionIcon, Badge, Button, CopyButton, MantineProvider, NumberInput, Select, Table as MantineTable, TextInput, Tooltip } from "@mantine/core";
import "@mantine/core/styles.css";
// Imported here and not by the map, because the stylesheet of a lazily loaded chunk is never linked to the page.
import "leaflet/dist/leaflet.css";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { type ColumnDef, createSortedRowModel, rowSortingFeature, tableFeatures, useTable } from "@tanstack/react-table";
import { entitiesText, entityTotal, sizeText, type Dimensions } from "../dimensions";
import { listingColumnWidths } from "../listing-columns";
import { registerServiceWorker } from "./service-worker";
import { siteRoot } from "./site-root";
import { StarToggle, useStarred } from "./star";
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

/** The bounds the entities filter sets on an entry's entity total (the sum its Entities column sorts by), each unset until the visitor types one. */
interface EntityBounds {
  readonly min: number | undefined;
  readonly max: number | undefined;
}

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

/** The interactive listing: filter inputs over the search index and a sortable table of what matches. */
function Listing({ records }: { readonly records: readonly SearchRecord[] }): ReactNode {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [bounds, setBounds] = useState<EntityBounds>({ min: undefined, max: undefined });
  const [onlyStarred, setOnlyStarred] = useState(false);
  const starred = useStarred();

  const kinds = useMemo(() => [...new Set(records.map((record) => record.kind))].sort(), [records]);
  const domains = useMemo(() => [...new Set(records.flatMap((record) => (record.domain === undefined ? [] : [record.domain])))].sort(), [records]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();

    return records.filter((record) => {
      if (onlyStarred && !starred.has(record.id)) {
        return false;
      }
      if (kind !== null && record.kind !== kind) {
        return false;
      }
      if (domain !== null && record.domain !== domain) {
        return false;
      }
      if (!within(entityTotal(record), bounds.min, bounds.max)) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const haystack = [record.id, record.namespace, ...(record.aliases ?? []), record.name, record.description, record.domain, ...(record.subjects ?? []), ...record.tags].filter((field): field is string => field !== undefined);

      return haystack.some((field) => field.toLowerCase().includes(needle));
    });
  }, [records, text, kind, domain, bounds, onlyStarred, starred]);

  // Column definitions are written as plain literals against the hook's own column type, not built through createColumnHelper: the helper infers each accessor over its own value type, which does not inter-type with the widened union under exactOptionalPropertyTypes. The order matches the static table's Name, Id, Kind, Domain so the two views of the listing read the same way.
  const columns: readonly ColumnDef<ListingFeatures, SearchRecord>[] = [
    { accessorKey: "name", header: "Name", cell: (info) => (
        <span className="star-name">
          <StarToggle id={info.row.original.id} name={info.row.original.name} />
          <a href={`datasets/${info.row.original.id}/`}>{info.row.original.name}</a>
        </span>
      ),
    },
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
        <TextInput className="island-search" aria-label="Search the catalogue" placeholder="search the catalogue" value={text} onChange={(event) => { setText(event.currentTarget.value); }} />
        <Select className="island-filter" aria-label="Kind" placeholder="kind" data={kinds} value={kind} onChange={(value) => { setKind(value); }} clearable searchable />
        <Select className="island-filter" aria-label="Domain" placeholder="domain" data={domains} value={domain} onChange={(value) => { setDomain(value); }} clearable searchable />
        <div className="island-range" role="group" aria-label="Entities">
          <span className="island-range-label" aria-hidden="true">Entities</span>
          {(["min", "max"] as const).map((key) => (
            <NumberInput key={key} className="island-bound" aria-label={`${key === "min" ? "Minimum" : "Maximum"} entities`} placeholder={key} min={0} allowNegative={false} allowDecimal={false} value={bounds[key] ?? ""} onChange={(value) => { setBounds((current) => ({ ...current, [key]: typeof value === "number" ? value : undefined })); }} />
          ))}
        </div>
        <Button aria-pressed={onlyStarred} color={onlyStarred ? "yellow" : "gray"} variant={onlyStarred ? "light" : "default"} onClick={() => { setOnlyStarred((current) => !current); }}>
          Starred ({String(starred.size)})
        </Button>
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
  const response = await fetch(`${root}search-index.json`);
  const parsed: unknown = await response.json();
  if (!Array.isArray(parsed) || !parsed.every(isSearchRecord)) {
    throw new Error("search-index.json is not a list of search records");
  }
  createRoot(mount).render(
    <MantineProvider defaultColorScheme="auto">
      <Listing records={parsed} />
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

for (const mount of document.querySelectorAll<HTMLElement>("[data-star-id]")) {
  const { starId, starName } = mount.dataset;
  if (starId === undefined || starName === undefined) {
    throw new Error("a star mount has no dataset to star");
  }
  createRoot(mount).render(
    <MantineProvider defaultColorScheme="auto">
      <StarToggle id={starId} name={starName} />
    </MantineProvider>,
  );
}

registerServiceWorker(root);
