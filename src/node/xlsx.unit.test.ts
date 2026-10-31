import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { collect, workbook } from "../test-support/archives";
import { zipSync } from "fflate";
import { sheetToCsv, unpack, unpackMembers } from "../archive";
import { sheetNames } from "./xlsx";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const csv = (parts: Parameters<typeof workbook>[0], sheet = "Data"): string => text(sheetToCsv(workbook(parts), { kind: "xlsx", sheet }));

/** A cell with a shared string, a number, an inline string, a boolean, a formula's text result and an error. */
const cell = (reference: string, type: string | undefined, value: string, style?: number): string => `<c r="${reference}"${type === undefined ? "" : ` t="${type}"`}${style === undefined ? "" : ` s="${String(style)}"`}><v>${value}</v></c>`;

/** Excel's serial numbers for 14 November 2023 and the same day at 22:13:20, and the 1904-system serial of 1 January 2000. */
const SERIAL_2023_11_14 = 45_244;
const SERIAL_2023_11_14_EVENING = 45_244.925_925_925_9;
const SERIAL_2000_01_01_IN_1904_SYSTEM = 35_063;
const SERIAL_EARLY_1900 = 59;
const SERIAL_FALSE_LEAP_DAY = 60;
const SERIAL_NOON = 0.5;
/** The style indexes the tests give cells, the built-in short date format they point at, and the ids of the custom formats they define. */
const STYLE = { general: 0, shortDate: 1, customDateTime: 2, customTime: 3 } as const;
const SHORT_DATE_FORMAT = 14;
const CUSTOM_DATE_TIME = 164;
const CUSTOM_TIME = 165;
const SHARED_STRING_MISSING = 9;

describe("sheetToCsv", () => {
  it("writes the named sheet as CSV: shared strings, numbers as stored, inline strings, booleans, formula results and entities", () => {
    const rows = [
      `<row r="1">${cell("A1", "s", "0")}${cell("B1", "s", "1")}${cell("C1", "s", "2")}</row>`,
      `<row r="2">${cell("A2", "s", "3")}${cell("B2", undefined, "12.50")}<c r="C2" t="inlineStr"><is><t>inline &amp; more</t></is></c></row>`,
      `<row r="3">${cell("A3", "b", "1")}${cell("B3", "str", "formula text")}${cell("C3", "e", "#N/A")}</row>`,
    ];
    expect(csv({ sheets: { Data: rows.join("") }, sharedStrings: ["case", "amount", "note", 'He said "go", twice'] })).toBe('case,amount,note\n"He said ""go"", twice",12.50,inline & more\nTRUE,formula text,#N/A\n');
  });

  it("joins the runs of a rich text string and leaves out its phonetic runs", () => {
    const rich = "<r><t>Fish </t></r><r><t>&amp; chips</t></r><rPh sb=\"0\" eb=\"1\"><t>phonetic</t></rPh>";
    expect(csv({ sheets: { Data: `<row r="1">${cell("A1", "s", "0")}</row>` }, sharedStrings: [rich] })).toBe("Fish & chips\n");
  });

  it("keeps the row numbers as lines, empty rows included, so the lines above the header are the rows an editor shows", () => {
    const rows = `<row r="1">${cell("A1", "s", "0")}</row><row r="4">${cell("A4", "s", "1")}${cell("B4", "s", "2")}</row><row r="5">${cell("A5", undefined, "1")}${cell("B5", undefined, "2")}</row>`;
    expect(csv({ sheets: { Data: rows }, sharedStrings: ["Title row", "a", "b"] })).toBe("Title row,\n,\n,\na,b\n1,2\n");
  });

  it("places a cell by its reference, leaving the cells between empty, and pads every line to the widest row", () => {
    const rows = `<row r="1">${cell("A1", "s", "0")}${cell("D1", "s", "1")}</row><row r="2"/><row r="3">${cell("B3", undefined, "7")}</row>`;
    expect(csv({ sheets: { Data: rows }, sharedStrings: ["a", "d"] })).toBe("a,,,d\n,,,\n,7,,\n");
  });

  it("ends at the last row holding a value, leaving out the formatted but empty rows after it", () => {
    const rows = `<row r="1">${cell("A1", undefined, "1")}${cell("B1", undefined, "2")}</row><row r="2"><c r="A2" s="1"/><c r="B2" s="1"/></row><row r="3"/>`;
    expect(csv({ sheets: { Data: rows } })).toBe("1,2\n");
  });

  it("writes a date-styled number as ISO 8601: a date, a date and time, and a time alone, by built-in and custom formats", () => {
    const rows = `<row r="1">${cell("A1", undefined, String(SERIAL_2023_11_14), STYLE.shortDate)}${cell("B1", undefined, String(SERIAL_2023_11_14_EVENING), STYLE.customDateTime)}${cell("C1", undefined, String(SERIAL_NOON), STYLE.customTime)}${cell("D1", undefined, String(SERIAL_2023_11_14), STYLE.general)}${cell("E1", undefined, String(SERIAL_EARLY_1900), STYLE.shortDate)}</row>`;
    expect(csv({ sheets: { Data: rows }, styles: { cellFormats: [STYLE.general, SHORT_DATE_FORMAT, CUSTOM_DATE_TIME, CUSTOM_TIME], custom: { [CUSTOM_DATE_TIME]: "dd/mm/yyyy\\ hh:mm:ss", [CUSTOM_TIME]: '"at "hh:mm' } } })).toBe("2023-11-14,2023-11-14T22:13:20,12:00:00,45244,1900-02-28\n");
  });

  it("does not take a number format for a date because of a letter in quoted text, an escape or a colour", () => {
    const rows = `<row r="1">${cell("A1", undefined, "5", STYLE.shortDate)}${cell("B1", undefined, "6", STYLE.customDateTime)}</row>`;
    expect(csv({ sheets: { Data: rows }, styles: { cellFormats: [STYLE.general, CUSTOM_DATE_TIME, CUSTOM_TIME], custom: { [CUSTOM_DATE_TIME]: '0.00" days"', [CUSTOM_TIME]: "[Red]\\d0.0" } } })).toBe("5,6\n");
  });

  it("counts days from 1904 in a workbook that says so, and refuses the false 29th of February 1900", () => {
    const rows = `<row r="1">${cell("A1", undefined, String(SERIAL_2000_01_01_IN_1904_SYSTEM), STYLE.shortDate)}</row>`;
    expect(csv({ sheets: { Data: rows }, styles: { cellFormats: [STYLE.general, SHORT_DATE_FORMAT] }, date1904: true })).toBe("1999-12-31\n");
    expect(() => csv({ sheets: { Data: `<row r="1">${cell("A1", undefined, String(SERIAL_FALSE_LEAP_DAY), STYLE.shortDate)}</row>` }, styles: { cellFormats: [STYLE.general, SHORT_DATE_FORMAT] } })).toThrow(/29 February 1900/);
  });

  it("reads the sheet it is named, in a workbook of several", () => {
    const sheets = { Notes: `<row r="1"><c r="A1" t="inlineStr"><is><t>explanation</t></is></c></row>`, Data: `<row r="1"><c r="A1" t="inlineStr"><is><t>values</t></is></c></row>` };
    expect(csv({ sheets }, "Data")).toBe("values\n");
    expect(csv({ sheets }, "Notes")).toBe("explanation\n");
  });

  it("refuses a sheet the workbook lacks, a shared string it lacks, and bytes that are not a workbook", () => {
    expect(() => csv({ sheets: { Data: "" } }, "Missing")).toThrow(/has no sheet Missing; it has Data/);
    expect(() => csv({ sheets: { Data: `<row r="1">${cell("A1", "s", String(SHARED_STRING_MISSING))}</row>` }, sharedStrings: ["a"] })).toThrow(new RegExp(`shared string ${String(SHARED_STRING_MISSING)}`));
    expect(() => sheetToCsv(new TextEncoder().encode("not a zip"), { kind: "xlsx", sheet: "Data" })).toThrow(ArchiveError);
  });
});

describe("unpack for a workbook", () => {
  it("yields the sheet as CSV and names the sheet as the member", async () => {
    const unpacked = await unpack(workbook({ sheets: { Data: `<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>` } }), { kind: "xlsx", sheet: "Data" });
    expect(text(unpacked.bytes)).toBe("x\n");
    expect(unpacked.member).toBe("Data");
  });
});

describe("unpackMembers for the sheets of workbooks", () => {
  const inline = (value: string): string => `<row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row>`;
  const archive = zipSync({
    "SSSTW/A.xlsm": workbook({ sheets: { A2: inline("a2"), A1: inline("a1") } }),
    "MSMTW/J.xlsm": workbook({ sheets: { J1: inline("j1"), J5: inline("j5") } }),
    "notes.docx": new TextEncoder().encode("not a workbook"),
  });

  it("names the sheets in the workbook's order and yields each matched workbook's sheets as CSV, members in path order", async () => {
    expect(sheetNames(workbook({ sheets: { A2: "", A1: "" } }))).toEqual(["A2", "A1"]);
    const files = await collect(unpackMembers(archive, { kind: "zip", members: { extensions: [".xlsm"] }, inner: { kind: "xlsx" } }));
    expect(files.map((file) => [file.path, text(file.bytes)])).toEqual([
      ["MSMTW/J.xlsm/J1", "j1\n"],
      ["MSMTW/J.xlsm/J5", "j5\n"],
      ["SSSTW/A.xlsm/A2", "a2\n"],
      ["SSSTW/A.xlsm/A1", "a1\n"],
    ]);
  });

  it("reads only the sheets the pattern matches in full, and refuses a workbook left with none and a member that is not a workbook", async () => {
    expect((await collect(unpackMembers(archive, { kind: "zip", members: { extensions: [".xlsm"] }, inner: { kind: "xlsx", sheets: "(?!J5$).+" } }))).map((file) => file.path)).toEqual(["MSMTW/J.xlsm/J1", "SSSTW/A.xlsm/A2", "SSSTW/A.xlsm/A1"]);
    await expect(collect(unpackMembers(archive, { kind: "zip", members: { extensions: [".xlsm"] }, inner: { kind: "xlsx", sheets: "A." } }))).rejects.toThrow(/MSMTW\/J.xlsm has no sheet matching A\./);
    await expect(collect(unpackMembers(archive, { kind: "zip", members: { extensions: [".docx"] }, inner: { kind: "xlsx" } }))).rejects.toThrow(/member notes.docx: not a valid workbook/);
  });
});
