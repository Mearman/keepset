import { describe, expect, it } from "vitest";
import { parseNativeFiles } from "./parse-native";

const encoder = new TextEncoder();
const file = (path: string, text: string): { path: string; bytes: Uint8Array } => ({ path: `data/meta/${path}`, bytes: encoder.encode(text) });
const parser = { format: "nicolingua", encoding: "utf-8" } as const;
const vocabularies = [
  file("vocab_contact_management.csv", "ID,English,French,Susu,Maninka,Pular\n201,add,ajoute,ajouter,simb,addp\n"),
  file("vocab_digits.csv", "ID,English,French,Susu,Maninka,Pular\n301,one,un,one,single,onep\n"),
  file("vocab_names.csv", "ID,Name\n501,Fatoumata\n"),
  file("vocab_wake_words.csv", "ID,English,French,Susu,Maninka,Pular\n101,Guru,Savant,Korogba,Simbon,Walliyou\n"),
  file("vocab_parents.csv", "ID,English,French,Susu,Maninka,Pular\n401,Mom,Maman,mom,s,mb\n"),
];
const metadata = (rows: string): ReturnType<typeof file> => file("metadata.csv", `file,utterance_id,language,speaker_id\n${rows}`);

describe("Nicolingua metadata", () => {
  it("joins prompts by ID and language and retains recording fields", () => {
    const result = parseNativeFiles([metadata("a.wav,101_wake_word,maninka,s1\nb.wav,201_add_contact,francais,s2\nc.wav,501_name,_language_independent,s3\n"), ...vocabularies], parser);
    expect(result.nodes).toEqual([
      { id: "a.wav", audio: "a.wav", utterance_id: "101_wake_word", language: "maninka", speaker_id: "s1", text: "Simbon" },
      { id: "b.wav", audio: "b.wav", utterance_id: "201_add_contact", language: "francais", speaker_id: "s2", text: "ajoute" },
      { id: "c.wav", audio: "c.wav", utterance_id: "501_name", language: "_language_independent", speaker_id: "s3", text: "Fatoumata" },
    ]);
  });

  it("refuses missing and duplicate inputs and unmatched prompts", () => {
    expect(() => parseNativeFiles([metadata(""), ...vocabularies.slice(1)], parser)).toThrow("vocab_contact_management.csv: missing file");
    expect(() => parseNativeFiles([metadata(""), ...vocabularies, file("vocab_contact_management.csv", "")], parser)).toThrow("duplicate file");
    expect(() => parseNativeFiles([metadata("a.wav,999_unknown,maninka,s1\n"), ...vocabularies], parser)).toThrow("no Maninka prompt");
    expect(() => parseNativeFiles([metadata("a.wav,101_wake_word,unknown,s1\n"), ...vocabularies], parser)).toThrow("unknown language");
    expect(() => parseNativeFiles([metadata("a.wav,101_wake_word,maninka,s1\na.wav,101_wake_word,maninka,s1\n"), ...vocabularies], parser)).toThrow("duplicate recording");
    expect(() => parseNativeFiles([metadata(""), ...vocabularies.filter(({ path }) => !path.endsWith("vocab_parents.csv")), file("vocab_parents.csv", "ID,English,French,Susu,Maninka,Pular\n101,Mom,Maman,mom,s,mb\n")], parser)).toThrow("duplicate vocabulary ID 101");
    expect(() => parseNativeFiles([metadata("a.wav,,maninka,s1\n"), ...vocabularies], parser)).toThrow("missing utterance ID or language");
  });
});
