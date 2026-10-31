import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseMusanAnnotations } from "./musan-annotations";
import { parseNativeFiles } from "./parse-native";

const parser: Extract<Parser, { format: "musan-annotations" }> = { format: "musan-annotations", encoding: "utf-8" };

const file = (path: string, text: string): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });

const music = file("musan/music/fma/ANNOTATIONS", "music-fma-0026 blues Y Cullah\nmusic-fma-0097 pop,electronica N Quiet_Music_for_Tiny_Robots\n");
const art = file("musan/music/hd-classical/ANNOTATIONS", "music-hd-0037 westernart,baroque N John_Harrison Vivaldi\n");
const speech = file("musan/speech/librivox/ANNOTATIONS", "speech-librivox-0097 f german \nspeech-librivox-0169 m english\n\n");
const noise = file("musan/noise/free-sound/ANNOTATIONS", "Background noises:\nnoise-free-sound-0232\nnoise-free-sound-0840\n");

describe("the musan-annotations parser", () => {
  it("reads music, speech and noise lists as rows labelled with their kind and directory, null where a kind lacks a field", () => {
    expect(parseMusanAnnotations([music, art, speech, noise], parser).nodes).toEqual([
      { id: "music-fma-0026", label: "music", source: "fma", genre: "blues", vocals: "Y", artist: "Cullah", composer: null, gender: null, language: null },
      { id: "music-fma-0097", label: "music", source: "fma", genre: "pop,electronica", vocals: "N", artist: "Quiet_Music_for_Tiny_Robots", composer: null, gender: null, language: null },
      { id: "music-hd-0037", label: "music", source: "hd-classical", genre: "westernart,baroque", vocals: "N", artist: "John_Harrison", composer: "Vivaldi", gender: null, language: null },
      { id: "speech-librivox-0097", label: "speech", source: "librivox", genre: null, vocals: null, artist: null, composer: null, gender: "f", language: "german" },
      { id: "speech-librivox-0169", label: "speech", source: "librivox", genre: null, vocals: null, artist: null, composer: null, gender: "m", language: "english" },
      { id: "noise-free-sound-0232", label: "noise", source: "free-sound", genre: null, vocals: null, artist: null, composer: null, gender: null, language: null },
      { id: "noise-free-sound-0840", label: "noise", source: "free-sound", genre: null, vocals: null, artist: null, composer: null, gender: null, language: null },
    ]);
  });

  it("reads CR LF line ends", () => {
    expect(parseMusanAnnotations([file("m/music/rfm/ANNOTATIONS", "a blues N X\r\nb blues N Y\r\n")], parser).nodes.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("refuses a path that is no annotation file, a line with too few or too many fields and an id given twice", () => {
    const run = (...files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): NativeParseError => {
      try {
        parseMusanAnnotations(files, parser);
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(run(file("musan/README", "")).message).toMatch(/is not the ANNOTATIONS file/);
    expect(run(file("musan/music/fma/ANNOTATIONS", "a blues Y")).message).toMatch(/line 1 of .* has 2 fields after the id, and a music line has 3 or 4/);
    expect(run(file("musan/speech/librivox/ANNOTATIONS", "a f german extra")).message).toMatch(/has 3 fields after the id, and a speech line has 2/);
    expect(run(file("musan/noise/free-sound/ANNOTATIONS", "a extra")).message).toMatch(/a noise line has 0/);
    expect(run(music, file("musan/music/jamendo/ANNOTATIONS", "music-fma-0026 pop Y Someone")).message).toMatch(/the id music-fma-0026 is given twice/);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([music], parser).nodes).toHaveLength(2);
  });
});
