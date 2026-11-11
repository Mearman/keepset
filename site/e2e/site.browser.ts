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
  const names = ["Search the catalogue", "Kind", "Domain", "Subject", "Tag", "Namespace", "Minimum entities", "Maximum entities"];
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

/** The listing's count badge, as "<shown> of <total>". */
async function shownOf(page: Page): Promise<{ shown: number; total: number }> {
  const [shown, total] = ((await page.locator("#island-root .mantine-Badge-root").textContent()) ?? "").split(" of ").map(Number);

  return { shown: shown ?? Number.NaN, total: total ?? Number.NaN };
}

test("the filters are read from the URL, and every change is written back to it in place", async ({ page }) => {
  await page.goto("/?kind=graph&utm_source=elsewhere");
  await expect(page.locator("#island-root .mantine-Pill-root", { hasText: "graph" })).toBeVisible();
  const byKind = await shownOf(page);
  expect(byKind.shown).toBeLessThan(byKind.total);
  const entries = await page.evaluate(() => window.history.length);
  await page.getByLabel("Search the catalogue").pressSequentially("karate");
  await expect(page).toHaveURL(/\/\?kind=graph&q=karate$/);
  expect(await page.evaluate(() => window.history.length)).toBe(entries);
  const searched = await shownOf(page);
  expect(searched.shown).toBeLessThan(byKind.shown);

  await page.reload();
  await expect(page.getByLabel("Search the catalogue")).toHaveValue("karate");
  expect(await shownOf(page)).toEqual(searched);
});

for (const url of ["/", "/?kind=graph", "/?kind=graph,resources&domain=Social%20network&tag=url"]) {
  test(`every filter keeps the height of the search box whatever it holds: ${url}`, async ({ page }) => {
    await page.goto(url);
    await expect(page.getByLabel("Search the catalogue")).toBeVisible();
    const measured = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#island-root .island-controls .island-search input, #island-root .island-controls .island-filter .mantine-MultiSelect-input")].map((control) => Math.round(control.getBoundingClientRect().height)));
    expect(measured.length).toBeGreaterThan(2);
    expect(new Set(measured).size, measured.join(", ")).toBe(1);
  });
}

test("a chosen value leads its dropdown, ticked, and a click on it clears it", async ({ page }) => {
  await page.goto("/?kind=resources");
  const kind = page.getByRole("combobox", { name: "Kind", exact: true });
  await kind.click();
  const options = page.getByRole("option");
  await expect(options.first()).toContainText("resources");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(1)).not.toHaveAttribute("aria-selected", "true");
  await options.first().click();
  await expect(page).not.toHaveURL(/kind=/);
  await expect(page.locator("#island-root .island-filter .mantine-Pill-root")).toHaveCount(0);
});

test("a chosen filter value is shown whole, never clipped inside its control", async ({ page }) => {
  await page.goto("/?kind=graph,resources&domain=Social%20network&tag=social");
  await expect(page.locator("#island-root .island-filter .mantine-Pill-label").first()).toBeVisible();
  const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#island-root .island-filter .mantine-Pill-label")].filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent));
  expect(clipped).toEqual([]);
  const overflowing = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#island-root .island-filter .mantine-Pill-root")].filter((pill) => pill.getBoundingClientRect().right > (pill.closest(".mantine-MultiSelect-input")?.getBoundingClientRect().right ?? 0)).map((pill) => pill.textContent));
  expect(overflowing).toEqual([]);
});

test("a tag page mounts the home page's listing with its tag chosen, and any change gives the view as a home listing link", async ({ page }) => {
  await page.goto("/tags/");
  await expect(page.locator("#groups-root.island-live")).toBeVisible();
  await page.locator("#groups-root ul.groups a").first().click();
  await expect(page.locator("#island-root.island-live")).toBeVisible();
  const rows = await page.locator(".table-wrap.listing.island-baseline tbody tr").count();
  await expect(page.locator(".island-baseline", { hasText: "Filter these datasets further in the full listing" })).toBeHidden();
  await expect(page.locator(".table-wrap.listing.island-baseline")).toBeHidden();
  await expect(page.locator("#island-root .mantine-Pill-root").first()).toBeVisible();
  expect((await shownOf(page)).shown).toBe(rows);
  await expect(page).toHaveURL(/\/tags\/[^/?]+\/$/);
  await page.getByLabel("Search the catalogue").pressSequentially("zzz-no-such-dataset");
  await expect(page).toHaveURL(new RegExp(`/\\?tag=[^&]+&q=zzz-no-such-dataset$`));
  await expect(page.getByText("No datasets match these filters.")).toBeVisible();
});

test("a kind page starts from its kind, and its rows link to the entry pages from its own depth", async ({ page }) => {
  await page.goto("/kinds/resources/");
  await expect(page.locator("#island-root .mantine-Pill-root", { hasText: "resources" })).toBeVisible();
  const { shown, total } = await shownOf(page);
  expect(shown).toBeLessThan(total);
  expect(shown).toBe(await page.locator(".table-wrap.listing.island-baseline tbody tr").count());
  await page.locator("#island-root tbody tr[data-index] a").first().click();
  await expect(page).toHaveURL(/\/datasets\/[^/]+\/$/);
});

test("an index of listing pages filters by text, orders by name or count, and keeps the text in the URL", async ({ page }) => {
  await page.goto("/tags/");
  const badge = page.locator("#groups-root .mantine-Badge-root");
  await expect(badge).toBeVisible();
  const counts = async (): Promise<number[]> => (await page.locator("#groups-root ul.groups li").allTextContents()).map((text) => Number(/\((\d+)\)$/.exec(text)?.[1]));
  const byCount = await counts();
  expect(byCount).toEqual([...byCount].sort((left, right) => right - left));
  await page.getByText("By name").click();
  const labels = (await page.locator("#groups-root ul.groups a").allTextContents());
  expect(labels).toEqual([...labels].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  const [, total] = ((await badge.textContent()) ?? "").split(" of ");
  await page.getByLabel("Filter the tags").pressSequentially("weight");
  await expect(page).toHaveURL(/\/tags\/\?q=weight$/);
  await expect(badge).not.toHaveText(new RegExp(`^${String(total)} of`));
  for (const label of await page.locator("#groups-root ul.groups a").allTextContents()) {
    expect(label.toLowerCase()).toContain("weight");
  }
});

test.describe("without scripts", () => {
  test.use({ javaScriptEnabled: false });

  test("a tag page shows its static listing and links into the listing filtered by its tag", async ({ page }) => {
    await page.goto("/tags/");
    await page.locator("ul.groups a").first().click();
    await expect(page.locator(".table-wrap.listing tbody tr").first()).toBeVisible();
    await page.getByRole("link", { name: "Filter these datasets further in the full listing" }).click();
    await expect(page).toHaveURL(/\/\?tag=/);
  });
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
