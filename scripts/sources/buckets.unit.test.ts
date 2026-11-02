import { describe, expect, it } from "vitest";
import { balanceHosts } from "./buckets";

const BUCKETS = 3;
const TWO_BUCKETS = 2;

/** One host's request count against the others': a host that outweighs all the rest together, a few equal ones, and the smallest. */
const OVERWHELMING = 100;
const EQUAL = 10;
const TIED = 4;
const LARGE = 5;
const MIDDLE = 3;
const SMALL = 1;

describe("balanceHosts", () => {
  it("gives every host to exactly one bucket", () => {
    const requests = new Map([["a.example", LARGE], ["b.example", MIDDLE], ["c.example", MIDDLE], ["d.example", SMALL], ["e.example", SMALL]]);
    const shared = balanceHosts(requests, BUCKETS).flat().sort();
    expect(shared).toEqual([...requests.keys()].sort());
  });

  it("keeps the busiest host alone when its requests outweigh all the others together", () => {
    const requests = new Map([["big.example", OVERWHELMING], ["a.example", EQUAL], ["b.example", EQUAL], ["c.example", EQUAL]]);
    const shared = balanceHosts(requests, BUCKETS);
    expect(shared.find((hosts) => hosts.includes("big.example"))).toEqual(["big.example"]);
  });

  it("evens out the remaining requests between the other buckets", () => {
    const requests = new Map([["big.example", OVERWHELMING], ["a.example", EQUAL], ["b.example", EQUAL], ["c.example", EQUAL], ["d.example", EQUAL]]);
    const others = balanceHosts(requests, BUCKETS).filter((hosts) => !hosts.includes("big.example"));
    expect(others.map((hosts) => hosts.length)).toEqual([TWO_BUCKETS, TWO_BUCKETS]);
  });

  it("returns the same split for the same input however the map was filled", () => {
    const forward = new Map([["a.example", TIED], ["b.example", TIED], ["c.example", TIED]]);
    const backward = new Map([["c.example", TIED], ["b.example", TIED], ["a.example", TIED]]);
    expect(balanceHosts(backward, TWO_BUCKETS)).toEqual(balanceHosts(forward, TWO_BUCKETS));
  });

  it("returns an empty list for a bucket that has no host", () => {
    expect(balanceHosts(new Map([["a.example", SMALL]]), TWO_BUCKETS)).toEqual([["a.example"], []]);
  });
});
