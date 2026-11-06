#!/usr/bin/env node
import { createWriteStream, writeFileSync } from "node:fs";
import { countTarget, getDataset, listDatasets, listNamespaces, validateDataset } from "keepset";
import { captureRequestsFor, downloadRaw, fetchDataset, mozillaDataCollectiveFetch, requestCapture, roundTripDataset, streamDataset } from "keepset/node";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./run";

const key = process.env["MDC_API_KEY"];
const options = key === undefined ? {} : { fetch: mozillaDataCollectiveFetch(key, downloadRaw) };

// A reader that closes early (`| head`) makes the next write fail with EPIPE. The output was complete as far as the reader wanted it, so that error is dropped and the exit status the command settled on stands; any other stdout error is still thrown.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

process.exitCode = await run(
  process.argv.slice(2),
  {
    listDatasets,
    getDataset,
    listNamespaces,
    validateDataset,
    fetchDataset: async (id) => fetchDataset(id, options),
    streamDataset: async (id, sink) => streamDataset(id, sink, options),
    roundTripDataset: async (id) => roundTripDataset(id, options),
    countTarget: (fetched) => countTarget(fetched.dataset.entry.category, fetched.data),
    captureRequests: captureRequestsFor,
    requestCapture: async (saveUrl) => requestCapture(saveUrl),
  },
  {
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    writeFile: (path, text) => {
      writeFileSync(path, text, "utf8");
    },
    openFile: (path) => {
      const stream = createWriteStream(path, { encoding: "utf8" });
      const failed = new Promise<never>((_, reject) => {
        stream.once("error", reject);
      });
      // Read only through the races below; a failure before any write still rejects the next one.
      failed.catch(() => undefined);

      return {
        // Waits for the stream to drain when its buffer is full, so a slow disk holds the fetch back rather than the pages piling up in memory.
        write: async (text) => {
          if (!stream.write(text)) {
            await Promise.race([
              new Promise((resolve) => {
                stream.once("drain", resolve);
              }),
              failed,
            ]);
          }
        },
        close: async () =>
          Promise.race([
            new Promise<void>((resolve) => {
              stream.end(resolve);
            }),
            failed,
          ]),
      };
    },
    version: packageJson.version,
  },
);
