import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseOptionList } from "./option-list";
import { parseNativeFiles } from "./parse-native";

type OptionListParser = Extract<Parser, { format: "option-list" }>;

const parser = (options: Readonly<Partial<OptionListParser>> = {}): OptionListParser => ({ format: "option-list", encoding: "utf-8", fields: ["rir_id", "room_id", "noise_type"], ...options });

const file = (path: string, text: string): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });

describe("the option-list parser", () => {
  it("reads each line as a row named by its final argument, with the options it keeps as fields and the ones a line lacks as null", () => {
    const rirs = file("rirs/rir_list", "--rir-id 00001 --room-id large1 rirs/a.wav\r\n\r\n--rir-id 00002 --room-id large1 rirs/b.wav\n");
    const noises = file("noises/noise_list", "﻿--noise-id 7 --noise-type isotropic --room-linkage large1 noises/n.wav");
    expect(parseOptionList([rirs, noises], parser()).nodes).toEqual([
      { id: "rirs/a.wav", rir_id: "00001", room_id: "large1", noise_type: null },
      { id: "rirs/b.wav", rir_id: "00002", room_id: "large1", noise_type: null },
      { id: "noises/n.wav", rir_id: null, room_id: null, noise_type: "isotropic" },
    ]);
  });

  it("reads a line with no options as a row of nulls", () => {
    expect(parseOptionList([file("l", "just/a/path.wav")], parser()).nodes).toEqual([{ id: "just/a/path.wav", rir_id: null, room_id: null, noise_type: null }]);
  });

  it("names the file and line of an option without a value or given twice, a line without one argument and an id given twice", () => {
    const run = (...files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): NativeParseError => {
      try {
        parseOptionList(files, parser());
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(run(file("a/list", "--rir-id 1 x.wav\n--rir-id --room-id 2 y.wav")).message).toBe("option-list line 2: a/list: the option --rir-id has no value");
    expect(run(file("a/list", "--rir-id 1 --rir-id 2 x.wav")).message).toMatch(/the option --rir-id is given twice/);
    expect(run(file("a/list", "--rir-id 1")).message).toMatch(/expected one argument after the options, found 0/);
    expect(run(file("a/list", "--rir-id 1 x.wav y.wav")).message).toMatch(/found 2/);
    expect(run(file("a/list", "--rir-id")).message).toMatch(/has no value/);
    expect(run(file("a/list", "--rir-id 1 x.wav"), file("b/list", "--rir-id 2 x.wav")).message).toBe("option-list line 1: b/list: the id x.wav is given twice");
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([file("l", "--rir-id 1 x.wav")], parser()).nodes).toHaveLength(1);
  });
});
