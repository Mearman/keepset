import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar, type ArchiveFile } from "../test-support/archives";
import { validateDataset } from "../validate";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

const RELATED_FILES = "https://speech-lab-share-data.oss-cn-shanghai.aliyuncs.com/SlideSpeech/related_files.tar.gz";

/** A port that serves the one archive from its URL and refuses any other. */
function serving(body: Uint8Array): FetchPort {
  return async (url) => Promise.resolve(url === RELATED_FILES ? new Response(body) : new Response("not found", { status: 404 }));
}

/** One split's files, laid out as the corpus's `all_information.tar.gz` holds them: a Kaldi `text` file, the `segments` file beside it, and the slide text, none of which the recipe reads but the first. */
function split(name: string, text: string, segments: string): ArchiveFile[] {
  return [
    { path: `${name}/`, text: "", type: "5" },
    { path: `${name}/ocr_text`, text: "slide words\n" },
    { path: `${name}/text`, text },
    { path: `${name}/segments`, text: segments },
  ];
}

/** `related_files.tar.gz` as the corpus ships it: the large OCR archive first, which is not an archive here and so fails the fetch if anything opens it, then the information archive, then the metadata archive. */
const relatedFiles = gzip(
  tar([
    { path: "preprocessed_ocr.tar.gz", text: "not an archive" },
    {
      path: "all_information.tar.gz",
      bytes: gzip(
        tar([
          ...split("L95", "other_0000-00000 HELLO\nshared_0000-00001 GOOD\nother_0000-00004 WE ALL DO IS MAYBE THE FIRST THING WE LEARN IT'S\n", "other_0000-00000 other 0.00 0.50\n"),
          ...split("S95", "shared_0000-00001 AND THIS PAPER THAT WE'RE PRESENTING UH IS DRAWING ON SOME PERSPECTIVES\n", "shared_0000-00001 shared 1.00 3.50\n"),
          ...split("dev", "dance_0000-00002 ALRIGHT I'M GONNA GET RID OF THE MEETING CONTROLS\ndance_0000-00005 I'M EMILY\n", "dance_0000-00002 dance 4.00 6.00\n"),
          ...split("test", "child_0000-00002 AND THANK YOU VERY MUCH GOOD EVENING EVERYBODY\n", "child_0000-00002 child 2.00 5.00\n"),
        ]),
      ),
    },
    { path: "all_meta_info.tar.gz", text: "not an archive either" },
  ]),
);

describe("the openslr-slr144-transcripts recipe", () => {
  const dataset = getDataset("openslr-slr144-transcripts");

  it("is a valid entry whose crosswalk validates", () => {
    expect(validateDataset(dataset)).toEqual([]);
  });

  it("gives one instance per split, each utterance with its identifier and transcript", async () => {
    const { data } = await fetchEntry(dataset, { fetch: serving(relatedFiles) });

    expect(data).toMatchObject({
      instances: [
        {
          id: "all_information.tar.gz/L95/text",
          nodes: [
            { id: "other_0000-00000", text: "HELLO" },
            { id: "shared_0000-00001", text: "GOOD" },
            { id: "other_0000-00004", text: "WE ALL DO IS MAYBE THE FIRST THING WE LEARN IT'S" },
          ],
        },
        {
          id: "all_information.tar.gz/S95/text",
          nodes: [{ id: "shared_0000-00001", text: "AND THIS PAPER THAT WE'RE PRESENTING UH IS DRAWING ON SOME PERSPECTIVES" }],
        },
        {
          id: "all_information.tar.gz/dev/text",
          nodes: [
            { id: "dance_0000-00002", text: "ALRIGHT I'M GONNA GET RID OF THE MEETING CONTROLS" },
            { id: "dance_0000-00005", text: "I'M EMILY" },
          ],
        },
        { id: "all_information.tar.gz/test/text", nodes: [{ id: "child_0000-00002", text: "AND THANK YOU VERY MUCH GOOD EVENING EVERYBODY" }] },
      ],
    });
  });

  it("leaves the segments and slide text files beside each transcript file out", async () => {
    const { data } = await fetchEntry(dataset, { fetch: serving(relatedFiles) });

    expect(JSON.stringify(data)).not.toContain("slide words");
    expect(JSON.stringify(data)).not.toContain("0.50");
  });
});
