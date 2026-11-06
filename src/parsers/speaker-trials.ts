import { NativeParseError } from "../errors";
import { forEachLine, NodeOrder, type NativeNode, type NativeTypedEdge } from "./native";

const TRIAL_FIELDS = 3;

/**
 * Reads enrolment ID, test path and binary label as one typed edge per trial, retaining source IDs and repeated rows in file order.
 * @param pieces - The trial file's decoded text in order.
 * @returns The trial graph.
 * @throws NativeParseError when a row is malformed or the file is empty.
 */
export function parseSpeakerTrials(pieces: Readonly<Iterable<string>>): { readonly nodes: readonly NativeNode[]; readonly edges: readonly NativeTypedEdge[] } {
  const order = new NodeOrder();
  const edges: NativeTypedEdge[] = [];
  let lastLine = 0;
  forEachLine(pieces, (line, number) => {
    lastLine = number;
    const fields = line.trim().split(/\s+/u);
    const [enrolment, test, label] = fields;
    if (fields.length !== TRIAL_FIELDS || enrolment === undefined || enrolment === "" || test === undefined || test === "" || (label !== "0" && label !== "1")) {
      throw new NativeParseError("speaker-trials", number, "expected enrolment ID, test path and binary label");
    }
    edges.push({ source: order.intern(enrolment), target: order.intern(test), type: label });
  });
  if (edges.length === 0) throw new NativeParseError("speaker-trials", lastLine, "the file holds no trials");

  return { nodes: order.nodes(), edges };
}
