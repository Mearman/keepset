import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { readXml } from "./xml";

function failure(text: string): NativeParseError {
  try {
    readXml(text, "demo");
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

describe("readXml", () => {
  it("keeps text, child elements and CDATA in their original order", () => {
    const root = readXml("<a>one<b/>two<![CDATA[three]]><c/>four</a>", "demo");
    expect(root.content).toEqual(["one", root.children[0], "two", "three", root.children[1], "four"]);
    expect(root.text).toBe("onetwothreefour");
  });

  it("keeps a greater-than sign inside an attribute", () => {
    expect(readXml('<a note="before > after"/>', "demo").attributes).toEqual({ note: "before > after" });
  });

  it("reads nested elements with attributes in either quote, text, and empty elements", () => {
    const root = readXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a x="1" y='two'>\n  <b>text</b><c/><d k = "v"></d>\n</a>\n`, "demo");
    expect(root.name).toBe("a");
    expect(root.attributes).toEqual({ x: "1", y: "two" });
    expect(root.children.map((child) => child.name)).toEqual(["b", "c", "d"]);
    expect(root.children[0]?.text).toBe("text");
    expect(root.children[2]?.attributes).toEqual({ k: "v" });
    expect(root.text.trim()).toBe("");
  });

  it("resolves the predefined entities and character references in text and attributes, and keeps a CDATA section as it is", () => {
    const root = readXml('<a t="&lt;&amp;&quot;">1 &amp; 2 &#65;&#x42;<![CDATA[ <raw> & ]]></a>', "demo");
    expect(root.attributes).toEqual({ t: '<&"' });
    expect(root.text).toBe("1 & 2 AB <raw> & ");
  });

  it("skips comments and processing instructions, including one between elements", () => {
    const root = readXml("<!-- before --><a><?pi data?><!-- inside --><b/></a><!-- after -->\n", "demo");
    expect(root.children.map((child) => child.name)).toEqual(["b"]);
  });

  it("refuses a document type declaration and any entity the document would define", () => {
    expect(failure('<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY x "y">]>\n<a>&x;</a>').message).toMatch(/demo line 2: a document type declaration is not read/);
    expect(failure("<a>&x;</a>").message).toMatch(/the entity &x; is not one of the five predefined ones/);
  });

  it("names the line of markup that is malformed", () => {
    expect(failure("<a>\n<b>\n</a>").message).toMatch(/demo line 3: the closing tag "\/a" does not close "b"/);
    expect(failure("<a>\n<b").message).toMatch(/demo line 2: a tag is never closed/);
    expect(failure("<a><!-- open").message).toMatch(/a comment is never closed/);
    expect(failure("<a><![CDATA[ open").message).toMatch(/a CDATA section is never closed/);
    expect(failure("<a><?pi").message).toMatch(/a processing instruction is never closed/);
    expect(failure("<a>").message).toMatch(/the element "a" is never closed/);
    expect(failure("</a>").message).toMatch(/does not close any element/);
    expect(failure("<1a/>").message).toMatch(/"1a" is not an element name/);
    expect(failure('<a x="1" x="2"/>').message).toMatch(/the attribute x appears twice/);
    expect(failure("<a x=1/>").message).toMatch(/are not name="value" pairs/);
  });

  it("refuses text outside the root, a second root and an empty document", () => {
    expect(failure("stray<a/>").message).toMatch(/text outside the root element/);
    expect(failure("<a/>stray").message).toMatch(/text outside the root element/);
    expect(failure("<a/><b/>").message).toMatch(/more than one root element/);
    expect(failure("  \n").message).toMatch(/the document has no root element/);
    expect(failure("<![CDATA[ x ]]><a/>").message).toMatch(/a CDATA section outside the root element/);
  });
});
