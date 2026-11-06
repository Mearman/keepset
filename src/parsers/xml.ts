import { NativeParseError } from "../errors";

/** An element of an XML document, with its direct text and children both separately and interleaved in document order. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly content: readonly (string | XmlElement)[];
  readonly text: string;
}

/** An element whose end tag has not been read yet. */
interface OpenElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  readonly content: (string | XmlElement)[];
  text: string;
  readonly index: number;
}

/** The characters an XML name may contain, narrowed to what the formats read use. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ATTRIBUTE = /\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
const PREDEFINED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const CODE_POINT = /^#(?:x([0-9A-Fa-f]+)|(\d+))$/;
const HEXADECIMAL = 16;
const DECIMAL = 10;

/** The markers that open and close markup that holds no elements. */
interface Markers {
  readonly open: string;
  readonly close: string;
}

/** The markup that runs from an opening marker to a closing one and holds no elements: comments, CDATA sections and processing instructions. */
const COMMENT = { open: "<!--", close: "-->" } as const;
const CDATA = { open: "<![CDATA[", close: "]]>" } as const;
const INSTRUCTION = { open: "<?", close: "?>" } as const;
const DECLARATION = "<!";

/** Reads an XML document into a tree; see `readXml`. */
class XmlReader {
  readonly #text: string;

  readonly #format: string;

  readonly #stack: OpenElement[] = [];

  #root: XmlElement | undefined;

  #position = 0;

  constructor(text: string, format: string) {
    this.#text = text;
    this.#format = format;
  }

  /**
   * Fails at a position of the document.
   * @param index - Where in the text the fault is.
   * @param message - What is wrong.
   * @throws NativeParseError naming the line of the position.
   */
  #fail(index: number, message: string): never {
    throw new NativeParseError(this.#format, this.#text.slice(0, index).split("\n").length, message);
  }

  /**
   * Replaces the character references and the five predefined entities in text.
   * @param text - Text from an element or an attribute value.
   * @param index - Where the text starts, for the error.
   * @returns The text with references resolved.
   */
  #unescape(text: string, index: number): string {
    return text.replace(/&([^;&\s]*);/g, (whole, reference: string) => {
      const predefined = Object.hasOwn(PREDEFINED, reference) ? PREDEFINED[reference] : undefined;
      if (predefined !== undefined) {
        return predefined;
      }
      const code = CODE_POINT.exec(reference);
      if (code === null) {
        return this.#fail(index, `the entity ${whole} is not one of the five predefined ones`);
      }

      return String.fromCodePoint(code[1] === undefined ? Number.parseInt(code[2] ?? "", DECIMAL) : Number.parseInt(code[1], HEXADECIMAL));
    });
  }

  /**
   * Finishes an element: it becomes a child of the open element, or the root.
   * @param open - The element.
   */
  #finish(open: OpenElement): void {
    const element: XmlElement = { name: open.name, attributes: open.attributes, children: open.children, content: open.content, text: open.text };
    const parent = this.#stack[this.#stack.length - 1];
    if (parent !== undefined) {
      parent.children.push(element);
      parent.content.push(element);
    } else if (this.#root === undefined) {
      this.#root = element;
    } else {
      this.#fail(open.index, "the document has more than one root element");
    }
  }

  /**
   * Reads the `name="value"` pairs of a tag.
   * @param text - The tag's text after its name.
   * @param index - Where the tag starts, for errors.
   * @returns The attributes.
   */
  #attributes(text: string, index: number): Record<string, string> {
    const attributes: Record<string, string> = {};
    ATTRIBUTE.lastIndex = 0;
    let consumed = 0;
    for (let match = ATTRIBUTE.exec(text); match !== null; match = ATTRIBUTE.exec(text)) {
      const [, key = "", doubled, single] = match;
      if (Object.hasOwn(attributes, key)) {
        this.#fail(index, `the attribute ${key} appears twice`);
      }
      attributes[key] = this.#unescape(doubled ?? single ?? "", index);
      consumed = ATTRIBUTE.lastIndex;
    }
    if (text.slice(consumed).trim() !== "") {
      this.#fail(index, `the attributes ${JSON.stringify(text.trim())} are not name="value" pairs`);
    }

    return attributes;
  }

  /**
   * Reads a start tag, an empty-element tag or an end tag that begins at the position.
   * @returns The position after it.
   */
  #tag(): number {
    const start = this.#position;
    let stop = start + 1;
    let quote: string | undefined;
    for (; stop < this.#text.length; stop += 1) {
      const character = this.#text[stop];
      if (quote === undefined && (character === '"' || character === "'")) {
        quote = character;
      } else if (quote === character) {
        quote = undefined;
      } else if (quote === undefined && character === ">") {
        break;
      }
    }
    if (stop === this.#text.length) {
      return this.#fail(start, "a tag is never closed");
    }
    const tag = this.#text.slice(start + 1, stop);
    if (tag.startsWith("/")) {
      const finished = this.#stack.pop();
      if (finished?.name !== tag.slice(1).trim()) {
        return this.#fail(start, `the closing tag ${JSON.stringify(tag)} does not close ${finished === undefined ? "any element" : JSON.stringify(finished.name)}`);
      }
      this.#finish(finished);

      return stop + 1;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = /^\S+/.exec(body)?.[0] ?? "";
    if (!NAME.test(name)) {
      return this.#fail(start, `${JSON.stringify(name)} is not an element name`);
    }
    const element: OpenElement = { name, attributes: this.#attributes(body.slice(name.length), start), children: [], content: [], text: "", index: start };
    if (selfClosing) {
      this.#finish(element);
    } else {
      this.#stack.push(element);
    }

    return stop + 1;
  }

  /**
   * Skips markup that runs to a closing marker, or reads it as text.
   * @param markers - The opening and closing markers.
   * @param what - What the markup is, for the error.
   * @returns The position after it and its content.
   */
  #delimited(markers: Markers, what: string): { readonly next: number; readonly content: string } {
    const from = this.#position + markers.open.length;
    const stop = this.#text.indexOf(markers.close, from);
    if (stop === -1) {
      return this.#fail(this.#position, `${what} is never closed`);
    }

    return { next: stop + markers.close.length, content: this.#text.slice(from, stop) };
  }

  /**
   * Reads the markup at the position, which starts with `<`.
   * @returns The position after it.
   */
  #markup(): number {
    const rest = this.#text.startsWith.bind(this.#text);
    const open = this.#stack[this.#stack.length - 1];
    if (rest(COMMENT.open, this.#position)) {
      return this.#delimited(COMMENT, "a comment").next;
    }
    if (rest(CDATA.open, this.#position)) {
      const { next, content } = this.#delimited(CDATA, "a CDATA section");
      if (open === undefined) {
        return this.#fail(this.#position, "a CDATA section outside the root element");
      }
      open.text += content;
      open.content.push(content);

      return next;
    }
    if (rest(INSTRUCTION.open, this.#position)) {
      return this.#delimited(INSTRUCTION, "a processing instruction").next;
    }
    if (rest(DECLARATION, this.#position)) {
      return this.#fail(this.#position, "a document type declaration is not read: it can define entities, and the formats here have none");
    }

    return this.#tag();
  }

  /**
   * Reads the whole document.
   * @returns The root element.
   */
  read(): XmlElement {
    while (this.#position < this.#text.length) {
      const lessThan = this.#text.indexOf("<", this.#position);
      const end = lessThan === -1 ? this.#text.length : lessThan;
      const content = this.#text.slice(this.#position, end);
      const open = this.#stack[this.#stack.length - 1];
      if (open !== undefined) {
        const decoded = this.#unescape(content, this.#position);
        open.text += decoded;
        if (decoded !== "") {
          open.content.push(decoded);
        }
      } else if (content.trim() !== "") {
        this.#fail(this.#position, "text outside the root element");
      }
      if (lessThan === -1) {
        break;
      }
      this.#position = lessThan;
      this.#position = this.#markup();
    }
    const unclosed = this.#stack[this.#stack.length - 1];
    if (unclosed !== undefined) {
      this.#fail(this.#text.length, `the element ${JSON.stringify(unclosed.name)} is never closed`);
    }

    return this.#root ?? this.#fail(0, "the document has no root element");
  }
}

/**
 * Reads an XML document into a tree. It reads what data files use: elements, attributes in single or double quotes, text, CDATA sections, comments, processing instructions and the XML declaration, and the predefined entities and character references. A document type declaration is refused, because it can define entities that expand without bound and nothing here reads one. Namespaces are not interpreted: a prefix is part of the name.
 * @param text - The document text.
 * @param format - The name of the format being parsed, for errors.
 * @returns The root element.
 * @throws NativeParseError naming the line for markup that is malformed, a tag that does not close the open one, an undeclared entity, a document type declaration, text outside the root or more than one root.
 */
export function readXml(text: string, format: string): XmlElement {
  return new XmlReader(text, format).read();
}
