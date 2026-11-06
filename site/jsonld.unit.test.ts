import { getDataset } from "keepset";
import { describe, expect, it } from "vitest";
import { datasetJsonLd } from "./jsonld";

describe("brokered distribution metadata", () => {
  it("identifies the broker without claiming its POST endpoint is a direct file URL", () => {
    const dataset = getDataset("openslr-slr147-transcripts");
    const ld = datasetJsonLd(dataset, "https://example.org/dataset", "https://example.org/");
    expect(ld.distribution).toEqual([{ "@type": "DataDownload", url: "https://mozilladatacollective.com/api/datasets/cmqs1irj8075snr07i69uvzo3/download" }]);
  });
});
