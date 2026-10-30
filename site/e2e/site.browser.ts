/* Browser tests of the built site. Every request the site makes to another origin is answered here: a source host with the file and the CORS header a host that allows browsers sends, the Wayback Machine's replay failing as a browser's cross-origin read of it does, since it sends no CORS header, its availability API with CORS, and Save Page Now with an opaque answer. */

import { expect, test, type Page, type Route } from "@playwright/test";

const CORS = { "access-control-allow-origin": "*" };

/** A Pajek file of a handful of vertices, standing in for a dead source's snapshot that the page cannot read. */
const PAJEK = '*Vertices 4\n1 "a"\n2 "b"\n3 "c"\n4 "d"\n*Edges\n1 2\n2 3\n3 4\n';

/** The rows of a tasks table with a latitude and a longitude, which the preview draws as a map. */
const TOWS_CSV = "Latitude,Longitude,Tow_Date,Tow_Description\n42.88,-78.87,2026-01-01,Illegal parking\n42.9,-78.85,2026-01-02,Abandoned vehicle\n";

/** How many vertices the Pajek file holds, which is how many rows the preview shows. */
const PAJEK_VERTICES = 4;
const PAJEK_EDGES = 3;

/** More rows than a page would render at once, so the table must show only a window of them. */
const MANY_ROWS = 5000;

/** Where the generated tows start, near Buffalo. */
const BUFFALO_LATITUDE = 42;
const BUFFALO_LONGITUDE = -78;

const TOWS_URL = "https://data.buffalony.gov/api/views/pamv-gash/rows.csv?accessType=DOWNLOAD";

const FILE_NAMES = (page: Page): { requested: string[] } => {
  const requested: string[] = [];
  page.on("request", (request) => {
    requested.push(new URL(request.url()).pathname.split("/").pop() ?? "");
  });

  return { requested };
};

/** Answers the Wayback Machine as it answers a browser: the availability API with CORS and no capture, a replay with no CORS header, and Save Page Now with a page the browser cannot read. Returns the capture requests it saw. */
async function wayback(page: Page): Promise<string[]> {
  const captures: string[] = [];
  await page.route("https://archive.org/wayback/available**", async (route: Readonly<Route>) => {
    await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ archived_snapshots: {} }) });
  });
  // Playwright's fulfil does not enforce CORS, so a replay's missing CORS header is reproduced as the failure a browser gives such a request: the fetch rejects.
  await page.route("https://web.archive.org/web/**", async (route: Readonly<Route>) => {
    await route.abort("failed");
  });
  await page.route("https://web.archive.org/save/**", async (route: Readonly<Route>) => {
    captures.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" });
  });

  return captures;
}

test("the listing renders only the rows near the viewport and reaches the last one", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("#island-root tbody tr[data-index]");
  await expect(rows.first()).toBeVisible();
  const total = Number((await page.locator("#island-root .mantine-Badge-root").textContent())?.split(" of ")[1]);
  expect(await rows.count()).toBeLessThan(total);
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await expect(rows.last()).toHaveAttribute("data-index", String(total - 1));
});

test("no count or size in the listing is cut off, at any width the table fits", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#island-root.island-live")).toBeVisible();
  const cut = await page.evaluate(() => {
    const content = new Set(["Kind", "Entities", "Size"]);
    const headers = [...document.querySelectorAll("#island-root .table-wrap.listing thead th")].map((header) => header.textContent.trim());

    return [...document.querySelectorAll<HTMLTableCellElement>("#island-root .table-wrap.listing tbody tr:not([aria-hidden]) td")].filter((cell) => content.has(headers[cell.cellIndex] ?? "") && cell.scrollWidth > cell.clientWidth).map((cell) => cell.textContent);
  });
  expect(cut).toEqual([]);
});

test("a minimum entity count filters the listing and the count says how many remain", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator("#island-root .mantine-Badge-root");
  await expect(badge).toBeVisible();
  const [, total] = ((await badge.textContent()) ?? "").split(" of ");
  await page.getByLabel("Minimum entities").fill("1000000");
  await expect(badge).not.toHaveText(new RegExp(`^${String(total)} of`));
  expect(Number(((await badge.textContent()) ?? "").split(" of ")[0])).toBeGreaterThan(0);
});

test("every filter has an accessible name and a column sorts from the keyboard", async ({ page }) => {
  await page.goto("/");
  const names = ["Search the catalogue", "Kind", "Domain", "Minimum entities", "Maximum entities"];
  await Promise.all(names.map(async (name) => expect(page.getByLabel(name, { exact: true }).first()).toBeVisible()));
  const entities = page.locator("#island-root thead th", { hasText: "Entities" });
  await expect(entities).toHaveAttribute("aria-sort", "none");
  await entities.getByRole("button").focus();
  // A numeric column sorts largest first, then smallest first.
  await page.keyboard.press("Enter");
  await expect(entities).toHaveAttribute("aria-sort", "descending");
  await page.keyboard.press("Enter");
  await expect(entities).toHaveAttribute("aria-sort", "ascending");
});

test("the listing loads neither the preview nor the map, and an entry page loads the preview but not the map", async ({ page }) => {
  const listing = FILE_NAMES(page);
  await page.goto("/");
  await expect(page.locator("#island-root tbody tr[data-index]").first()).toBeVisible();
  expect(listing.requested.some((name) => name.startsWith("preview-") || name.startsWith("point-map-"))).toBe(false);

  const entry = FILE_NAMES(page);
  await page.goto("/datasets/divorce/");
  await expect(page.getByRole("button", { name: "Fetch and preview" })).toBeVisible();
  expect(entry.requested.some((name) => name.startsWith("preview-"))).toBe(true);
  expect(entry.requested.some((name) => name.startsWith("point-map-"))).toBe(false);
});

test("a source the page cannot read offers the file drop, and the dropped file previews with its checksum", async ({ page }) => {
  const captures = await wayback(page);
  await page.goto("/datasets/divorce/");
  await page.getByRole("button", { name: "Fetch and preview" }).click();
  await expect(page.getByText("The page could not read this source")).toBeVisible();
  await expect(page.getByLabel("Downloaded file")).toBeVisible();
  await page.getByLabel("Downloaded file").setInputFiles({ name: "divorce.net", mimeType: "text/plain", buffer: Buffer.from(PAJEK, "latin1") });
  await expect(page.locator(".preview-result table tbody tr")).toHaveCount(PAJEK_VERTICES);
  await expect(page.locator(".preview-provenance")).toContainText("SHA-256");
  expect(captures).toEqual([]);
  await page.getByText("Edges (3)").click();
  await expect(page.locator(".preview-result table thead th")).toHaveText(["source", "target"]);
  await expect(page.locator(".preview-result table tbody tr")).toHaveCount(PAJEK_EDGES);
  await page.getByText("Meta", { exact: true }).click();
  await expect(page.locator(".preview-meta")).toContainText("divorce");
});

test("a star set on an entry page survives a reload and shows in the listing's starred filter", async ({ page }) => {
  await page.goto("/datasets/divorce/");
  const star = page.getByRole("button", { name: /^Star / });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Star / })).toHaveAttribute("aria-pressed", "true");

  await page.goto("/");
  const badge = page.locator("#island-root .mantine-Badge-root");
  await expect(badge).toBeVisible();
  await page.getByRole("button", { name: "Starred (1)" }).click();
  await expect(badge).toHaveText(/^1 of /);
  await expect(page.locator("#island-root tbody tr").filter({ has: page.locator("code", { hasText: /^divorce$/ }) })).toHaveCount(1);
});

test("a pinned snapshot's page link and raw link each copy their own URL", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/datasets/divorce/");
  const pageLink = page.locator(".snapshot-link a").first();
  const rawLink = page.locator(".snapshot-link a", { hasText: "raw" });
  const pageUrl = await pageLink.getAttribute("href");
  const rawUrl = await rawLink.getAttribute("href");
  expect(rawUrl).toMatch(/^https:\/\/web\.archive\.org\/web\/\d+id_\//);
  expect(pageUrl).toMatch(/^https:\/\/web\.archive\.org\/web\/\d+\//);
  await page.getByRole("button", { name: "Copy the raw snapshot link" }).click();
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(rawUrl);
  await page.getByRole("button", { name: "Copy the snapshot page link" }).click();
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(pageUrl);
});

test("a result of thousands of rows is browsable to its last row with only a window of it in the page", async ({ page }) => {
  await wayback(page);
  const rows = Array.from({ length: MANY_ROWS }, (_, index) => `${String(BUFFALO_LATITUDE + index / MANY_ROWS)},${String(BUFFALO_LONGITUDE + index / MANY_ROWS)},2026-01-01,Tow ${String(index)}`);
  await page.route(TOWS_URL, async (route: Readonly<Route>) => {
    await route.fulfill({ status: 200, headers: CORS, contentType: "text/csv", body: `Latitude,Longitude,Tow_Date,Tow_Description\n${rows.join("\n")}\n` });
  });
  await page.goto("/datasets/buffalo-recent-tows/");
  await page.getByRole("button", { name: "Fetch and preview" }).click();
  await expect(page.getByText(`Nodes (${MANY_ROWS.toLocaleString("en-GB")})`)).toBeVisible();
  const rendered = page.locator(".preview-table tbody tr[data-index]");
  expect(await rendered.count()).toBeLessThan(MANY_ROWS);
  await page.locator(".preview-table").evaluate((frame) => {
    frame.scrollTo({ top: frame.scrollHeight });
  });
  await expect(rendered.last()).toHaveAttribute("data-index", String(MANY_ROWS - 1));
});

test("a readable live source previews, draws the map from its coordinates and asks the Archive to capture it", async ({ page }) => {
  const captures = await wayback(page);
  const chunks = FILE_NAMES(page);
  await page.route(TOWS_URL, async (route: Readonly<Route>) => {
    await route.fulfill({ status: 200, headers: CORS, contentType: "text/csv", body: TOWS_CSV });
  });
  await page.goto("/datasets/buffalo-recent-tows/");
  await page.getByRole("button", { name: "Fetch and preview" }).click();
  await expect(page.locator(".preview-result table tbody tr")).toHaveCount(2);
  await expect(page.locator(".preview-map .leaflet-container")).toBeVisible();
  expect(chunks.requested.some((name) => name.startsWith("point-map-"))).toBe(true);
  await expect(page.locator(".preview-capture")).toBeVisible();
  expect(captures).toEqual([`https://web.archive.org/save/${TOWS_URL}`]);
});

test("a new service worker fills its cache from the network and not from the browser's HTTP cache", async ({ page, request }) => {
  // The server lets the browser reuse app.js for ten minutes and counts the requests it gets. A service worker that filled its cache through the HTTP cache would not ask again when it updates, and would store the previous build's app.js under the new version's name.
  const hitsOnAppJs = async (): Promise<number> => Number(await (await request.get("/__hits/app.js")).text());
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const beforeUpdate = await hitsOnAppJs();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await expect.poll(hitsOnAppJs).toBeGreaterThan(beforeUpdate);
});
