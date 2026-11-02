/* How the weekly liveness check shares the catalogue's source hosts between its parallel jobs. A host is never split: every job paces its own requests, so two jobs sharing a host would ask it twice as often as the politeness allows. */

/**
 * Shares hosts between buckets so that the buckets' request counts are as even as a whole-host split allows.
 * A job's duration is the request count of its busiest host times the pacing interval, and hosts in one job run side by side, so the longest job is set by the busiest host; sharing the remaining hosts by weight keeps every other job from adding to it.
 * @param requests - How many URLs each host serves.
 * @param buckets - How many buckets to share the hosts between.
 * @returns One sorted host list per bucket, in bucket order; a bucket with no host is an empty list.
 */
export function balanceHosts(requests: ReadonlyMap<string, number>, buckets: number): string[][] {
  const shares: { hosts: string[]; total: number }[] = Array.from({ length: buckets }, () => ({ hosts: [], total: 0 }));
  const heaviestFirst = [...requests].sort(([leftHost, left], [rightHost, right]) => right - left || (leftHost < rightHost ? -1 : 1));
  for (const [host, count] of heaviestFirst) {
    const lightest = shares.reduce((least, share) => (share.total < least.total ? share : least));
    lightest.hosts.push(host);
    lightest.total += count;
  }

  return shares.map((share) => share.hosts.sort());
}
