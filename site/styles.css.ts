/* The site's whole stylesheet, as a vanilla-extract module: a theme contract of colour tokens with a dark-mode override, then one globalStyle rule per element selector the generator's HTML uses. The generator emits plain semantic HTML with no class names of its own, so global styling is the whole surface and nothing has to thread generated class names into the page templates. The module is imported for its side effects by the client entry, so its CSS is compiled into the emitted stylesheet at build time and nothing runs in the browser. */

import { globalStyle } from "@vanilla-extract/css";
import { LISTING_FLOOR_WIDTH } from "./listing-columns";

/* The colour tokens are written as real custom properties rather than a createGlobalTheme contract: the contract form emits hashed internal names, and the rules below reference var(--border) and friends literally, which then only resolve where a rule happens to define the plain name. Light is the default; the dark override follows the media query rather than a toggle, matching MantineProvider's defaultColorScheme "auto" so the island and the static page never disagree. The border and stripe tokens are Mantine's table colours (gray-3/gray-0 light, dark-4/dark-6 dark) so a static table and the island's Mantine table beside each other read as one system. */
globalStyle(":root", {
  vars: {
    "--accent": "#1f4e79",
    "--bg": "#ffffff",
    "--fg": "#1c1e21",
    "--muted": "#5b616a",
    "--border": "#dee2e6",
    "--stripe": "#f8f9fa",
    "--codeBg": "rgb(0 0 0 / 4%)",
  },
});

globalStyle(":root", {
  "@media": {
    "(prefers-color-scheme: dark)": {
      vars: {
        "--accent": "#82b8f0",
        "--bg": "#1a1b1e",
        "--fg": "#c9cdd3",
        "--muted": "#9099a4",
        "--border": "#424242",
        "--stripe": "#2e2e2e",
        "--codeBg": "rgb(255 255 255 / 8%)",
      },
    },
  },
});

/* Wide tables scroll sideways inside this wrapper rather than stretching the page; the listing opts out at desktop width so its header can stick to the viewport instead. */
globalStyle(".table-wrap", {
  overflowX: "auto",
  margin: "0.5rem 0 1.5rem",
});

globalStyle(".table-wrap table", {
  margin: 0,
});

globalStyle(":root", {
  colorScheme: "light dark",
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.55,
});

globalStyle("body", {
  margin: "0 auto",
  maxWidth: "72rem",
  padding: "0 1rem",
  background: "var(--bg)",
  color: "var(--fg)",
});

/* A page with a listing is a wide table, not prose, so it takes more of a large screen than the 72rem measure the prose pages keep; the description above it has its own measure. */
globalStyle("body:has(.table-wrap.listing)", {
  maxWidth: "100rem",
});

globalStyle("a", {
  color: "var(--accent)",
});

globalStyle("a:focus-visible", {
  outline: "2px solid var(--accent)",
  outlineOffset: "2px",
  borderRadius: "2px",
});

globalStyle("code", {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "0.875em",
});

globalStyle("header", {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem 1.5rem",
  alignItems: "center",
  padding: "1rem 0",
  borderBottom: "1px solid var(--border)",
});

globalStyle("header .home", {
  fontWeight: 700,
  fontSize: "1.25rem",
  color: "var(--accent)",
  textDecoration: "none",
});

globalStyle("nav", {
  display: "flex",
  gap: "1rem",
  flexWrap: "wrap",
  marginInlineStart: "auto",
});

globalStyle("h1", {
  fontSize: "clamp(1.5rem, 3vw, 1.875rem)",
  lineHeight: 1.25,
  margin: "1.5rem 0 0.5rem",
});

globalStyle("h2", {
  fontSize: "1.125rem",
  lineHeight: 1.3,
  margin: "2rem 0 0.5rem",
});

globalStyle(".description", {
  fontSize: "1.0625rem",
  color: "var(--muted)",
  maxWidth: "50rem",
});

/* Static tables take Mantine's own measurements (14px text on its line height, 0.7x/1x spacing-xs cells), with plain-value fallbacks, so a dataset page's tables and the island's Mantine table share one scale. Mantine's own table class outranks these element rules on the island, so the duplication never fights. */
globalStyle("table", {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "var(--mantine-font-size-sm, 0.875rem)",
  lineHeight: "var(--mantine-line-height, 1.55)",
});

globalStyle("th, td", {
  textAlign: "left",
  padding: "calc(var(--mantine-spacing-xs, 0.625rem) * 0.7) var(--mantine-spacing-xs, 0.625rem)",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
  overflowWrap: "anywhere",
});

globalStyle("thead th", {
  whiteSpace: "nowrap",
  color: "var(--muted)",
});

globalStyle("tbody tr:nth-child(even)", {
  backgroundColor: "var(--stripe)",
});

/* The listing's header sticks to the viewport at desktop width, where the wrapper no longer scrolls and sticky has a page scroll to react to; the background must be opaque or rows show through as they pass under. */
globalStyle(".table-wrap.listing", {
  "@media": {
    "(min-width: 48em)": {
      overflowX: "visible",
    },
  },
});

/* A sortable header's button fills the cell, so the whole header is the click target; it inherits the header's look and alignment, and a mark beside the label says which way the column sorts. */
globalStyle("th.sortable", {
  padding: 0,
});
globalStyle(".sort-button", {
  display: "block",
  width: "100%",
  padding: "calc(var(--mantine-spacing-xs, 0.625rem) * 0.7) var(--mantine-spacing-xs, 0.625rem)",
  border: 0,
  background: "none",
  color: "inherit",
  font: "inherit",
  textAlign: "inherit",
  whiteSpace: "inherit",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "pointer",
});
globalStyle(".sort-button:focus-visible", {
  outline: "2px solid var(--accent)",
  outlineOffset: "-2px",
});
globalStyle(".sort-mark", {
  opacity: 0.55,
});
globalStyle("th[aria-sort=ascending] .sort-mark, th[aria-sort=descending] .sort-mark", {
  opacity: 1,
  color: "var(--accent)",
});

globalStyle(".listing thead th", {
  "@media": {
    "(min-width: 48em)": {
      position: "sticky",
      top: 0,
      zIndex: 1,
      backgroundColor: "var(--bg)",
    },
  },
});

/* Every listing row stays on one line: a fixed layout gives each column a set width, and text that does not fit is cut with an ellipsis instead of wrapping (the full value is each cell's title and the entry page's own). The static table and the island's Mantine table share the wrapper's classes, so both get this. */
globalStyle(".table-wrap.listing table", {
  tableLayout: "fixed",
});

globalStyle(".table-wrap.listing th, .table-wrap.listing td", {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  overflowWrap: "normal",
});

/* The wrapper is the container the column widths' container query unit refers to (see listing-columns.ts). */
globalStyle(".table-wrap.listing", {
  containerType: "inline-size",
});

/* The content columns hold short values sized to fit, so they are never cut; digits are tabular so equal-length counts line up. */
globalStyle(".table-wrap.listing td:nth-child(3), .table-wrap.listing td:nth-child(5), .table-wrap.listing td:nth-child(6)", {
  overflow: "visible",
  textOverflow: "clip",
  fontVariantNumeric: "tabular-nums",
});

/* The size column (the sixth) holds a number with its unit, which reads right-aligned; the entities column (the fifth) is a phrase and reads left-aligned. */
globalStyle(".table-wrap.listing th:nth-child(6), .table-wrap.listing td:nth-child(6)", { textAlign: "right" });

/* Below desktop width the shares would leave columns too narrow to read, so the table keeps a floor width and the wrapper scrolls sideways instead. */
globalStyle(".table-wrap.listing table", {
  "@media": {
    "(max-width: 47.99em)": {
      minWidth: LISTING_FLOOR_WIDTH,
    },
  },
});

globalStyle("table.facts th", {
  "@media": {
    "(min-width: 48em)": {
      width: "12rem",
    },
  },
});

/* Below desktop width the facts table stops being a table: each row becomes a stacked label and value, because a two-column layout with a fixed label width does not fit a phone. */
for (const selector of ["table.facts", "table.facts tbody", "table.facts tr", "table.facts th", "table.facts td"]) {
  globalStyle(selector, {
    "@media": {
      "(max-width: 47.99em)": {
        display: "block",
        width: "auto",
      },
    },
  });
}

globalStyle("table.facts tr", {
  "@media": {
    "(max-width: 47.99em)": {
      paddingBlock: "0.5rem",
    },
  },
});

globalStyle("table.facts th", {
  "@media": {
    "(max-width: 47.99em)": {
      padding: "0 0 0.125rem",
      borderBottom: "none",
    },
  },
});

globalStyle("table.facts td", {
  "@media": {
    "(max-width: 47.99em)": {
      padding: "0 0 0.375rem",
    },
  },
});

/* The command and its copy button sit on one row that wraps as a whole, and the command itself wraps at spaces, breaking inside a word only when a single word cannot fit the line. */
globalStyle(".command", {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  margin: "1rem 0",
});

globalStyle(".command code", {
  padding: "0.375rem 0.625rem",
  border: "1px solid var(--border)",
  borderRadius: "0.375rem",
  backgroundColor: "var(--codeBg)",
  overflowWrap: "break-word",
});

/* A pinned snapshot's two links sit side by side in their cell, each followed by its copy icon, and wrap as whole links, never between a link and its icon. */
globalStyle(".snapshot-links", {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  columnGap: "0.75rem",
});

globalStyle(".snapshot-link", {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.125rem",
});

/* A dataset's star sits before its name in the listing and after it in the entry page's heading, and stays on the name's line. */
globalStyle(".star-name", {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
});

globalStyle(".star-mount", {
  display: "inline-flex",
  verticalAlign: "middle",
});

/* The link that skips the site header is off screen until the keyboard focuses it. */
globalStyle(".skip-link", {
  position: "absolute",
  left: "-100vw",
});
globalStyle(".skip-link:focus", {
  position: "static",
  display: "inline-block",
  padding: "0.5rem 0",
});

/* The trail above an entry's title: the listings it belongs to, each a link, separated by a mark the stylesheet draws so a screen reader reads a plain list. */
globalStyle(".breadcrumb ol", {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.25rem",
  margin: "1rem 0 0",
  padding: 0,
  listStyle: "none",
  fontSize: "var(--mantine-font-size-sm, 0.875rem)",
  color: "var(--muted)",
});
globalStyle(".breadcrumb li + li::before", {
  content: '"/"',
  marginRight: "0.25rem",
});

/* An entry's headline figures, each a large number over its label, in the units the listing uses. */
globalStyle(".stats", {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem 2rem",
  margin: "1rem 0",
});
globalStyle(".stats div", {
  display: "flex",
  flexDirection: "column-reverse",
});
globalStyle(".stats dt", {
  color: "var(--muted)",
  fontSize: "var(--mantine-font-size-sm, 0.875rem)",
});
globalStyle(".stats dd", {
  margin: 0,
  fontSize: "1.5rem",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
});

/* The provenance and crosswalk tables hold long URLs and paths, so below desktop width they keep a floor width and scroll sideways inside their wrapper rather than squeezing each column to a few characters; the URL column keeps room to read. */
globalStyle("table.provenance, table.crosswalk", {
  "@media": {
    "(max-width: 47.99em)": {
      minWidth: "44rem",
    },
  },
});
globalStyle("table.provenance td:nth-child(2)", {
  "@media": {
    "(max-width: 47.99em)": {
      minWidth: "16rem",
    },
  },
});

/* The preview's progress line and file chooser sit on one row with their icon or label. */
globalStyle(".preview-working, .preview-file", {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
});

globalStyle(".warning", {
  borderLeft: "3px solid #b35900",
  paddingLeft: "0.75rem",
  color: "var(--muted)",
});

/* auto-fill makes the index responsive without a breakpoint: as many labelled columns as fit, one on a phone. */
globalStyle(".groups", {
  listStyle: "none",
  padding: 0,
  margin: "1rem 0",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(16rem, 1fr))",
  gap: "0.375rem 2rem",
});

/* The island's controls: each input claims a share of the row and wraps whole, so they sit side by side at desktop width and stack on a phone without a second layout. */
globalStyle(".island-controls", {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  margin: "1rem 0",
});

/* The range is a labelled pair of inputs that stays on one row. */
globalStyle(".island-controls .island-range", {
  display: "flex",
  alignItems: "center",
  gap: "0.375rem",
  flex: "1 1 14rem",
});
globalStyle(".island-controls .island-range-label", {
  color: "var(--muted)",
  fontSize: "var(--mantine-font-size-sm, 0.875rem)",
  minWidth: "3.75rem",
});
globalStyle(".island-controls .island-bound", {
  flex: "1 1 0",
  minWidth: 0,
});
globalStyle(".island-controls .island-search", {
  flex: "1 1 16rem",
});

globalStyle(".island-controls .island-filter", {
  flex: "1 1 9rem",
  minWidth: "8rem",
});

globalStyle("footer", {
  margin: "3rem 0 2rem",
  padding: "1rem 0 0",
  borderTop: "1px solid var(--border)",
  fontSize: "0.875rem",
  color: "var(--muted)",
});

/* The interactive listing replaces the static table once the island mounts; until then it must hold no space, so the mount is hidden by the stylesheet itself rather than an inline style the no-JS page would also carry. */
globalStyle("#island-root", {
  display: "none",
});


globalStyle("#island-root.island-live", {
  display: "block",
});

/* The static listing is the island mount's next sibling on the home page, so the live class itself retires it; no script has to find and hide it. */
globalStyle("#island-root.island-live ~ .table-wrap.listing", {
  display: "none",
});
