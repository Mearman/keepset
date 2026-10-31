import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { docx, wordDoc } from "../test-support/word-fixtures";
import { parseNativeFiles } from "./parse-native";
import { parseWordText } from "./word-text";

const parser = (options: Readonly<Partial<Extract<Parser, { format: "word-text" }>>> = {}): Extract<Parser, { format: "word-text" }> => ({
  format: "word-text",
  encoding: "utf-8",
  idPattern: "(?:.*/)?([^/]+)\\.docx?",
  ...options,
});

const file = (path: string, bytes: Uint8Array): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes });

const run = (text: string): string => `<w:r><w:t>${text}</w:t></w:r>`;

describe("the word-text parser", () => {
  it("reads a .docx's paragraphs, tabs and breaks, and the paragraphs of a table and a hyperlink, in document order", () => {
    const body = [
      `<w:p>${run("Բարեւ")}<w:r><w:tab/></w:r>${run("աշխարհ")}</w:p>`,
      `<w:p><w:hyperlink>${run("a &amp; b")}</w:hyperlink><w:r><w:br/></w:r>${run("c")}</w:p>`,
      "<w:p/>",
      `<w:tbl><w:tr><w:tc><w:p>${run("cell one")}</w:p></w:tc><w:tc><w:p>${run("cell two")}</w:p></w:tc></w:tr></w:tbl>`,
    ].join("");
    expect(parseWordText([file("issue1/article.docx", docx(body))], parser()).nodes).toEqual([{ id: "article", text: "Բարեւ\tաշխարհ\na & b\nc\n\ncell one\ncell two" }]);
  });

  it("lists a paragraph inside a text box as a paragraph of its own, before the one that holds it ends", () => {
    const body = `<w:p>${run("outer")}<w:r><w:txbxContent><w:p>${run("boxed")}</w:p></w:txbxContent></w:r>${run(" end")}</w:p>`;
    expect(parseWordText([file("a.docx", docx(body))], parser()).nodes).toEqual([{ id: "a", text: "boxed\nouter end" }]);
  });

  it("reads a legacy .doc's pieces, one stored a byte a character and one as UTF-16, turning paragraph marks into line feeds", () => {
    const doc = wordDoc([
      { text: "Hello\r", compressed: true },
      { text: "Բարեւ աշխարհ\rTab\there\r", compressed: false },
    ]);
    expect(parseWordText([file("old/greeting.doc", doc)], parser()).nodes).toEqual([{ id: "greeting", text: "Hello\nԲարեւ աշխարհ\nTab\there\n" }]);
  });

  it("keeps a field's displayed result and leaves out its instruction, and turns cell marks into tabs and the non-breaking hyphen into a hyphen", () => {
    const doc = wordDoc([{ text: "see \u0013 HYPERLINK \"x\" \u0014the page\u0015 now\u0007next\u001eone\u000btwo\r", compressed: true }], { tableStream: "0Table" });
    expect(parseWordText([file("a.doc", doc)], parser()).nodes).toEqual([{ id: "a", text: "see the page now\tnext-one\ntwo\n" }]);
  });

  it("tells a .docx from a .doc by the file's bytes, not its name", () => {
    const files = [file("a.doc", docx(`<w:p>${run("from a package")}</w:p>`)), file("b.docx", wordDoc([{ text: "from a binary\r", compressed: true }]))];
    expect(parseNativeFiles(files, parser()).nodes).toEqual([
      { id: "a", text: "from a package" },
      { id: "b", text: "from a binary\n" },
    ]);
  });

  it("refuses an encrypted .doc, a file that is neither format, a package without a main document and two files with one id", () => {
    const message = (files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): string => {
      try {
        parseWordText(files, parser());
      } catch (error) {
        expect(error).toBeInstanceOf(NativeParseError);

        return error instanceof Error ? error.message : "";
      }

      return "no error";
    };
    expect(message([file("a.doc", wordDoc([{ text: "x\r", compressed: true }], { encrypted: true }))])).toContain("encrypted");
    expect(message([file("a.doc", new TextEncoder().encode("plain text"))])).toContain("neither a .docx package nor a .doc file");
    expect(message([file("a.docx", Uint8Array.from("PK\u0003\u0004\u0000\u0000", (character) => character.charCodeAt(0)))])).toContain("not a readable zip package");
    expect(message([file("x/a.docx", docx("<w:p/>")), file("y/a.docx", docx("<w:p/>"))])).toContain("the id a is given by two files");
    expect(message([file("notes.txt", docx("<w:p/>"))])).toContain("gives no id");
  });
});
