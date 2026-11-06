import { describe, expect, it } from "vitest";
import { parseSimulatedRir } from "./simulated-rir";

const parser = { format: "simulated-rir", encoding: "utf-8" } as const;
const file = (path: string, text: string): { path: string; bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });
const list = file("smallroom/rir_list", "--rir-id small-1 --room-id small-room a.wav\n");
const info = file("smallroom/room_info", "small-room 1.1 2.2 3.3 4.4 5.5 6.6 0.7\n");

describe("simulated room responses", () => {
  it("joins room values to each response while preserving their source text", () => {
    expect(parseSimulatedRir([info, list], parser).nodes).toEqual([{ id: "a.wav", rir_id: "small-1", room_id: "small-room", room_info: "1.1 2.2 3.3 4.4 5.5 6.6 0.7", room_length: 1.1, room_width: 2.2, room_height: 3.3, receiver_x: 4.4, receiver_y: 5.5, receiver_z: 6.6, absorption_coefficient: 0.7 }]);
  });
  it("rejects absent and duplicate room data", () => {
    expect(() => parseSimulatedRir([list], parser)).toThrow("expected response lists and room information");
    expect(() => parseSimulatedRir([list, file("smallroom/room_info", "other 1\n")], parser)).toThrow("missing room information");
    expect(() => parseSimulatedRir([list, info, info], parser)).toThrow("duplicate room information");
    expect(() => parseSimulatedRir([list, file("smallroom/room_info", "small-room 1 2\n")], parser)).toThrow("expected seven numeric room values");
  });
});
