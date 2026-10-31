import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { unpack } from "../archive";
import { pointShapefileToCsv, type ShapefileParts } from "./shapefile";

/** The `.prj` of the Sitadel housing permits shapefile, as published: RGF93 Lambert-93 in ESRI's spelling. */
const LAMBERT_93 =
  'PROJCS["RGF_1993_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",44.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]';
const WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** A dBASE field as a test writes it: name, type letter, width, and the value of each record as its text before padding. */
interface TestField {
  readonly name: string;
  readonly type: string;
  readonly length: number;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const SHAPE = { null: 0, point: 1, pointZ: 11, polygon: 5 } as const;
/** The `.shp` layout (ESRI Shapefile Technical Description, 1998): the file code, length in 16-bit words and version in the 100-byte header, then per record its number and content length before the content, a point being its type and two coordinates and a PointZ adding z and a measure. */
const SHP = { fileCode: 9994, version: 1000, headerBytes: 100, lengthOffset: 24, versionOffset: 28, typeOffset: 32, recordHeader: 8, contentLengthOffset: 4, xOffset: 4, yOffset: 12, wordBytes: 2 } as const;
const CONTENT = { null: 4, point: 20, pointZ: 36 } as const;
/** The dBASE III layout: version byte, record count, header and record lengths, then 32-byte field descriptors from byte 32 with the type at 11 and the width at 16, a carriage return ending them, and the end-of-file byte after the records. */
const DBF = { version: 0x03, countOffset: 4, headerLengthOffset: 8, recordLengthOffset: 10, firstField: 32, fieldBytes: 32, typeOffset: 11, lengthOffset: 16, terminator: 0x0d, endOfFile: 0x1a, space: 0x20, deleted: 0x2a } as const;

/**
 * Writes a `.shp` of the given shapes: a header of the layer's type and a record each, numbered from 1.
 * @param layerType - The header's shape type.
 * @param shapes - Each record: a point's x and y, or a bare shape type for a null or other shape.
 * @returns The file's bytes.
 */
function shp(layerType: number, shapes: readonly ({ readonly x: number; readonly y: number; readonly type?: number } | number)[]): Uint8Array {
  const lengths = shapes.map((shape) => (typeof shape === "number" ? CONTENT.null : shape.type === SHAPE.pointZ ? CONTENT.pointZ : CONTENT.point));
  const bytes = new Uint8Array(SHP.headerBytes + lengths.reduce((total, length) => total + SHP.recordHeader + length, 0));
  const view = new DataView(bytes.buffer);
  view.setInt32(0, SHP.fileCode, false);
  view.setInt32(SHP.lengthOffset, bytes.length / SHP.wordBytes, false);
  view.setInt32(SHP.versionOffset, SHP.version, true);
  view.setInt32(SHP.typeOffset, layerType, true);
  let at = SHP.headerBytes;
  shapes.forEach((shape, index) => {
    const length = lengths[index] ?? CONTENT.null;
    view.setInt32(at, index + 1, false);
    view.setInt32(at + SHP.contentLengthOffset, length / SHP.wordBytes, false);
    const content = at + SHP.recordHeader;
    if (typeof shape === "number") {
      view.setInt32(content, shape, true);
    } else {
      view.setInt32(content, shape.type ?? SHAPE.point, true);
      view.setFloat64(content + SHP.xOffset, shape.x, true);
      view.setFloat64(content + SHP.yOffset, shape.y, true);
    }
    at = content + length;
  });

  return bytes;
}

/**
 * Writes a dBASE III table: the header, the field descriptors and terminator, then each record with its deletion flag and its values left-padded with spaces to the field's width (encoded first, so a multi-byte character counts its bytes).
 * @param fields - The fields.
 * @param records - Each record's values, one per field, and whether it is marked deleted.
 * @param encodeValue - Encodes a value, in UTF-8 unless a test writes another encoding.
 * @returns The file's bytes.
 */
function dbf(fields: readonly TestField[], records: readonly { readonly values: readonly string[]; readonly deleted?: boolean }[], encodeValue = (value: string): Uint8Array => new TextEncoder().encode(value)): Uint8Array {
  const headerLength = DBF.firstField + fields.length * DBF.fieldBytes + 1;
  const recordLength = 1 + fields.reduce((total, field) => total + field.length, 0);
  const bytes = new Uint8Array(headerLength + records.length * recordLength + 1).fill(DBF.space, headerLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = DBF.version;
  view.setUint32(DBF.countOffset, records.length, true);
  view.setUint16(DBF.headerLengthOffset, headerLength, true);
  view.setUint16(DBF.recordLengthOffset, recordLength, true);
  fields.forEach((field, index) => {
    const at = DBF.firstField + index * DBF.fieldBytes;
    bytes.set(new TextEncoder().encode(field.name), at);
    bytes[at + DBF.typeOffset] = field.type.charCodeAt(0);
    bytes[at + DBF.lengthOffset] = field.length;
  });
  bytes[headerLength - 1] = DBF.terminator;
  records.forEach((record, index) => {
    const start = headerLength + index * recordLength;
    bytes[start] = record.deleted === true ? DBF.deleted : DBF.space;
    let offset = start + 1;
    fields.forEach((field, column) => {
      const encoded = encodeValue(record.values[column] ?? "");
      bytes.set(encoded, offset + field.length - encoded.length);
      offset += field.length;
    });
  });
  bytes[bytes.length - 1] = DBF.endOfFile;

  return bytes;
}


/** The first record of the Sitadel housing permits shapefile, as published: some of its attribute fields with their real widths, and its Lambert-93 position, whose RGF93 longitude and latitude PROJ 9.8.1 gives as 2.951894 and 48.951285. */
const SITADEL_FIELDS: readonly TestField[] = [
  { name: "id", type: "N", length: 10 },
  { name: "reg_libell", type: "C", length: 14 },
  { name: "type_dau", type: "C", length: 2 },
  { name: "etat_dau", type: "N", length: 10 },
  { name: "date_reell", type: "D", length: 8 },
  { name: "date_ree_2", type: "D", length: 8 },
  { name: "cj_dem", type: "N", length: 10 },
  { name: "surf_hab_c", type: "N", length: 24 },
];
const SITADEL_VALUES = ["29406", "Île-de-France", "PC", "2", "20190702", "00000000", "**********", "136.000000000000000"];
const SITADEL_POINT = { x: 696_476.697_469_719_7, y: 6_872_370.315_696_111 };
const SITADEL_POSITION = { latitude: 48.951_285, longitude: 2.951_894 };
/** How many cells of a written row are the table's, before its position cells. */
const ATTRIBUTE_CELLS = SITADEL_FIELDS.length;
const DEGREE_DIGITS = 8;

/**
 * The parts of a shapefile with the given geometry and table.
 * @param overrides - Parts to replace.
 * @returns The parts.
 */
function parts(overrides: Partial<ShapefileParts> = {}): ShapefileParts {
  return { shp: shp(SHAPE.point, [SITADEL_POINT]), dbf: dbf(SITADEL_FIELDS, [{ values: SITADEL_VALUES }]), prj: encode(LAMBERT_93), cpg: encode("UTF-8"), ...overrides };
}

describe("pointShapefileToCsv", () => {
  it("writes the attribute table and each point's stored and WGS84 position, from a real Sitadel record", () => {
    const [header = "", row = ""] = text(pointShapefileToCsv(parts())).split("\n");
    expect(header).toBe("id,reg_libell,type_dau,etat_dau,date_reell,date_ree_2,cj_dem,surf_hab_c,geometry_x,geometry_y,geometry_latitude,geometry_longitude");
    const cells = row.split(",");
    expect(cells.slice(0, ATTRIBUTE_CELLS)).toEqual(["29406", "Île-de-France", "PC", "2", "2019-07-02", "", "", "136.000000000000000"]);
    const [x, y, latitude, longitude] = cells.slice(ATTRIBUTE_CELLS);
    expect([x, y]).toEqual([String(SITADEL_POINT.x), String(SITADEL_POINT.y)]);
    expect(Number(latitude)).toBeCloseTo(SITADEL_POSITION.latitude, DEGREE_DIGITS);
    expect(Number(longitude)).toBeCloseTo(SITADEL_POSITION.longitude, DEGREE_DIGITS);
  });

  it("leaves a null shape's position empty, reads a PointZ's x and y, logicals and an ISO-8859-1 table (byte 0x92 is U+0092, not the windows-1252 quote), and quotes a cell with a comma", () => {
    const fields = [
      { name: "name", type: "C", length: 12 },
      { name: "open", type: "L", length: 1 },
    ];
    const latin1 = dbf(fields, [{ values: ["Caf\u00e9, Nord", "T"] }, { values: ["", "?"] }, { values: ["x\u0092", "n"] }], (value) => Uint8Array.from(value, (character) => character.charCodeAt(0)));
    const csv = text(pointShapefileToCsv({ shp: shp(SHAPE.point, [{ x: -1.5, y: 52.25, type: SHAPE.pointZ }, SHAPE.null, { x: 0, y: 0 }]), dbf: latin1, prj: encode(WGS84), cpg: encode("ISO-8859-1") }));
    expect(csv).toBe('name,open,geometry_x,geometry_y,geometry_latitude,geometry_longitude\n"Café, Nord",true,-1.5,52.25,52.25,-1.5\n,,,,,\nx\u0092,false,0,0,0,0\n');
  });

  it("refuses a polygon layer, a count that does not pair, a deleted record, a memo field, a position-named field and an unread encoding", () => {
    expect(() => pointShapefileToCsv(parts({ shp: shp(SHAPE.polygon, [SHAPE.null]) }))).toThrow(/type 5, not points/);
    expect(() => pointShapefileToCsv(parts({ shp: shp(SHAPE.point, [SITADEL_POINT, SITADEL_POINT]) }))).toThrow(/holds 2 records and the .dbf 1/);
    expect(() => pointShapefileToCsv(parts({ dbf: dbf(SITADEL_FIELDS, [{ values: SITADEL_VALUES, deleted: true }]) }))).toThrow(/record 1 is marked deleted/);
    expect(() => pointShapefileToCsv(parts({ dbf: dbf([{ name: "note", type: "M", length: 10 }], [{ values: ["1"] }]) }))).toThrow(/field note has the type "M"/);
    expect(() => pointShapefileToCsv(parts({ dbf: dbf([{ name: "geometry_x", type: "N", length: 4 }], [{ values: ["1"] }]) }))).toThrow(/named geometry_x/);
    expect(() => pointShapefileToCsv(parts({ cpg: encode("SHIFT_JIS") }))).toThrow(/"SHIFT_JIS"/);
    expect(() => pointShapefileToCsv(parts({ dbf: dbf([{ name: "when", type: "D", length: 8 }], [{ values: ["2019-7-2"] }]) }))).toThrow(/date "2019-7-2"/);
    expect(() => pointShapefileToCsv(parts({ shp: encode("not a shapefile") }))).toThrow(ArchiveError);
  });
});

describe("unpack for a shapefile", () => {
  it("reads the .shp the selector names with the parts of exactly the same name beside it, whatever the case of their extensions", async () => {
    const archive = zipSync({
      "dataset/LAYER.shp": parts().shp,
      "dataset/LAYER.DBF": parts().dbf,
      "dataset/LAYER.prj": parts().prj,
      "dataset/LAYER.cpg": parts().cpg,
      "dataset/OTHER.dbf": dbf([{ name: "other", type: "C", length: 1 }], [{ values: ["z"] }]),
      "dataset/LAYER_2.dbf": dbf([{ name: "other", type: "C", length: 1 }], [{ values: ["z"] }]),
      "dataset/metadata.xml": encode("<metadata/>"),
    });
    const unpacked = await unpack(archive, { kind: "shapefile", member: { extensions: [".shp"] } });
    expect(unpacked.member).toBe("dataset/LAYER.shp");
    expect(text(unpacked.bytes).startsWith("id,reg_libell,")).toBe(true);
  });

  it("refuses a member that is not a .shp and a shapefile missing a part", async () => {
    const archive = zipSync({ "LAYER.shp": parts().shp, "LAYER.dbf": parts().dbf, "LAYER.prj": parts().prj });
    await expect(unpack(archive, { kind: "shapefile", member: { path: "LAYER.dbf" } })).rejects.toThrow(/LAYER.dbf is not a .shp/);
    await expect(unpack(archive, { kind: "shapefile", member: { path: "LAYER.shp" } })).rejects.toThrow(/expected one .cpg beside LAYER.shp, found 0/);
  });
});
