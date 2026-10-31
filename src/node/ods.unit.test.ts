import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { odsSpreadsheet, zip } from "../test-support/archives";
import { sheetToCsv, unpack } from "../archive";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const csv = (tables: Readonly<Record<string, string>>, sheet = "Data"): string => text(sheetToCsv(odsSpreadsheet(tables), { kind: "ods", sheet }));

/** A string cell, as LibreOffice and the Environment Agency's exporter write one. */
const string = (paragraphs: string): string => `<table:table-cell office:value-type="string"><text:p>${paragraphs}</text:p></table:table-cell>`;
/** The filler an exporter writes after a row's last cell, out to the sheet's last column. */
const FILLER_CELLS = '<table:table-cell table:number-columns-repeated="16379"/>';
/** The filler row an exporter writes after the last row, out to the sheet's last row. */
const FILLER_ROWS = '<table:table-row table:number-rows-repeated="962582"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>';

describe("sheetToCsv for an OpenDocument spreadsheet", () => {
  it("reads the Environment Agency's flood warnings table: its header, a date and time, text with a leading space, and none of the filler cells and rows", () => {
    const header = `<table:table-row>${["DATE", "AREA", "CODE", "WARNING / ALERT AREA NAME", "TYPE"].map(string).join("")}${FILLER_CELLS}</table:table-row>`;
    const first = `<table:table-row><table:table-cell office:value-type="date" office:date-value="2006-01-31T13:55:34"><text:p>31/01/2006</text:p></table:table-cell>${string("SW - Devon")}${string("113WACT2a")}${string("Devon Coast (North)")}${string("Flood Watch")}${FILLER_CELLS}</table:table-row>`;
    const last = `<table:table-row><table:table-cell office:value-type="date" office:date-value="2026-06-25T17:45:57"><text:p>25/06/2026</text:p></table:table-cell>${string("East Midlands")}${string("<text:s/>034WAF408")}${string("River Wye in Derbyshire")}${string("Flood alert")}${FILLER_CELLS}</table:table-row>`;
    expect(csv({ tblAllData: `${header}${first}${last}${FILLER_ROWS}` }, "tblAllData")).toBe("DATE,AREA,CODE,WARNING / ALERT AREA NAME,TYPE\n2006-01-31T13:55:34,SW - Devon,113WACT2a,Devon Coast (North),Flood Watch\n2026-06-25T17:45:57,East Midlands, 034WAF408,River Wye in Derbyshire,Flood alert\n");
  });

  it("writes numbers as stored, booleans, times and dates by their value types, ignoring the text a cell shows for them", () => {
    const row = [
      '<table:table-cell office:value-type="float" office:value="12.5"><text:p>12.50</text:p></table:table-cell>',
      '<table:table-cell office:value-type="percentage" office:value="0.25"><text:p>25%</text:p></table:table-cell>',
      '<table:table-cell office:value-type="currency" office:currency="GBP" office:value="3"><text:p>£3.00</text:p></table:table-cell>',
      '<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>',
      '<table:table-cell office:value-type="time" office:time-value="PT13H05M09.6S"><text:p>13:05</text:p></table:table-cell>',
      '<table:table-cell office:value-type="date" office:date-value="2023-11-14"><text:p>14 Nov</text:p></table:table-cell>',
    ].join("");
    expect(csv({ Data: `<table:table-row>${row}</table:table-row>` })).toBe("12.5,0.25,3,TRUE,13:05:10,2023-11-14\n");
  });

  it("writes a repeated cell or row that holds a value as often as it repeats, and keeps the empty rows between values", () => {
    const rows = `<table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="float" office:value="1" table:number-columns-repeated="3"/></table:table-row><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="5"/></table:table-row><table:table-row><table:covered-table-cell/>${string("after a covered cell")}</table:table-row>`;
    expect(csv({ Data: rows })).toBe("1,1,1\n1,1,1\n,,\n,,\n,after a covered cell,\n");
  });

  it("joins a cell's paragraphs with line breaks and keeps its spans, runs of spaces, tabs and escaped characters", () => {
    const cell = `<table:table-cell office:value-type="string"><text:p>Fish <text:span text:style-name="T1">&amp;</text:span><text:s text:c="2"/>chips</text:p><text:p>"quoted"<text:tab/>tabbed<text:line-break/>broken</text:p><office:annotation><text:p>a note</text:p></office:annotation></table:table-cell>`;
    expect(csv({ Data: `<table:table-row>${cell}</table:table-row>` })).toBe('"Fish &  chips\n""quoted""\ttabbed\nbroken"\n');
  });

  it("reads the table it is named in a spreadsheet of several, and refuses one it lacks and bytes that are not a spreadsheet", () => {
    const tables = { Notes: `<table:table-row>${string("explanation")}</table:table-row>`, Data: `<table:table-row>${string("values")}</table:table-row>` };
    expect(csv(tables, "Data")).toBe("values\n");
    expect(csv(tables, "Notes")).toBe("explanation\n");
    expect(() => csv(tables, "Missing")).toThrow(/has no table Missing; it has Notes, Data/);
    expect(() => sheetToCsv(zip([{ path: "mimetype", text: "x" }]), { kind: "ods", sheet: "Data" })).toThrow(/no content.xml/);
    expect(() => sheetToCsv(new TextEncoder().encode("not a zip"), { kind: "ods", sheet: "Data" })).toThrow(ArchiveError);
    expect(() => csv({ Data: '<table:table-row table:number-rows-repeated="0"/>' })).toThrow(/not a positive whole number/);
  });
});

describe("unpack for a spreadsheet inside an archive", () => {
  it("reads the sheet of the member an extension selects, naming the member and the sheet", async () => {
    const spreadsheet = odsSpreadsheet({ tblAllData: `<table:table-row>${string("DATE")}</table:table-row>` });
    const bundle = zipSync({ "202607 Historic Flood Warnings Documentation.odt": new TextEncoder().encode("documentation"), "202607 Historic Flood Warnings EA Only.ods": spreadsheet });
    const unpacked = await unpack(bundle, { kind: "zip", member: { extensions: [".ods"] }, inner: { kind: "ods", sheet: "tblAllData" } });
    expect(text(unpacked.bytes)).toBe("DATE\n");
    expect(unpacked.member).toBe("202607 Historic Flood Warnings EA Only.ods/tblAllData");
  });
});
