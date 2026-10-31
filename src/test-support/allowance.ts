/** How many times slower a test runs inside the whole suite (parallel workers and coverage instrumentation) on a loaded host than alone on a quiet one: the worst slowdown seen was about twelve fold, so twenty leaves room. */
const LOADED_SUITE_SLOWDOWN = 20;

/**
 * The time a test may take: its time alone on a quiet host, allowed the slowdown of the whole suite on a loaded one.
 * @param quietMilliseconds - How long the test takes alone on a quiet host.
 * @returns The allowance to pass to the test as its timeout.
 */
export function allowance(quietMilliseconds: number): number {
  return quietMilliseconds * LOADED_SUITE_SLOWDOWN;
}
