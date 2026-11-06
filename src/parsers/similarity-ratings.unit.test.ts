import { describe, expect, it } from "vitest";
import { workbook } from "../test-support/archives";
import { parseSimilarityRatings } from "./similarity-ratings";

const str = (cell: string, value: string): string => `<c r="${cell}" t="inlineStr"><is><t>${value}</t></is></c>`;
const number = (cell: string, value: string): string => `<c r="${cell}"><v>${value}</v></c>`;
function fixture(score: string, secondJudge: string): Uint8Array {
  const rows = [
    `<row r="1">${str("A1", "Questions")}${str("B1", "Stimuli")}${str("C1", "Source1")}${str("D1", "Source2")}${str("E1", "Participant IDs and Ratings")}</row>`,
    `<row r="2">${str("E2", "1")}${str("F2", secondJudge)}</row>`,
    `<row r="3">${number("A3", "1")}${str("B3", "stim.wav")}${str("C3", "one.wav")}${str("D3", "two.wav")}${number("E3", score)}${number("F3", "4")}</row>`,
  ];

  return workbook({ sheets: { Ratings: rows.join("") } });
}

describe("pragmatic similarity ratings", () => {
  it("makes one edge per judge and preserves the pair, score and workbook", () => {
    expect(parseSimilarityRatings([{ path: "ratings.xlsx", bytes: fixture("3.5", "2") }])).toEqual({ nodes: [{ id: "one.wav" }, { id: "two.wav" }], edges: [
      { source: "one.wav", target: "two.wav", stimulus: "stim.wav", workbook: "ratings.xlsx", question: 1, judge: "1", score: 3.5 },
      { source: "one.wav", target: "two.wav", stimulus: "stim.wav", workbook: "ratings.xlsx", question: 1, judge: "2", score: 4 },
    ] });
  });
  it("rejects duplicate judges and invalid ratings", () => {
    expect(() => parseSimilarityRatings([{ path: "ratings.xlsx", bytes: fixture("3", "1") }])).toThrow("duplicate judge");
    expect(() => parseSimilarityRatings([{ path: "ratings.xlsx", bytes: fixture("invalid", "2") }])).toThrow("invalid rating");
  });
});
