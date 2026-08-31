import { describe, test, expect, mock } from "bun:test";
import type { StatRound } from "./stats";

// ── Controllable helper-store double ─────────────────────────────────────────
let disk: { rounds: StatRound[] } = { rounds: [] };
let loadStoreCalls = 0;
let deferredResolve: (() => void) | null = null;

const loadStore = mock((name: string) => {
  if (name !== "stats") return Promise.resolve({});
  loadStoreCalls++;
  // Deferred: resolves only when the test says so, so two callers can be in
  // flight at the same instant (the lost-update race window).
  return new Promise((res) => {
    deferredResolve = () => res(disk);
  });
});
const saveStore = mock(async (name: string, data: unknown) => {
  if (name === "stats") disk = data as { rounds: StatRound[] };
});

mock.module("./resolver-client", () => ({ loadStore, saveStore }));

// ── Minimal DOM/global stubs (persist registers exit listeners + debounces) ──
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: () => {},
  setTimeout: (fn: () => void) => (fn(), 0), // immediate debounce flush
  clearTimeout: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, key: () => null, length: 0 },
};
(globalThis as unknown as { document: unknown }).document = {
  addEventListener: () => {},
  visibilityState: "visible",
};

const persist = await import("./persist");

const mk = (t: number): StatRound => ({
  t,
  difficulty: "easy",
  players: [{ name: "P1", score: t, device: "mic", gain: 1, sensitivity: 0 }],
});
const settle = () => Bun.sleep(5);

describe("persist stats — no lost-update race, no clobber", () => {
  test("a concurrent record + read share ONE load; the round and existing history both survive", async () => {
    disk = { rounds: [mk(99)] }; // pre-existing history on disk
    loadStoreCalls = 0;

    persist.recordStatRound(mk(1)); // A — starts ensureLoaded (creates the in-flight load)
    const loadP = persist.loadStatRounds(); // concurrent — must JOIN that same load

    // The fix: both callers share one in-flight load. Without it this is 2, and
    // the second caller's fresh array overwrites the first's, dropping round A.
    expect(loadStoreCalls).toBe(1);

    deferredResolve!(); // resolve the shared load → disk [99]
    const res = await loadP;
    await settle(); // let the record's push + immediate debounce settle

    const final = await persist.loadStatRounds();
    expect(final.rounds.map((r) => r.t).sort((a, b) => a - b)).toEqual([1, 99]); // A kept, 99 kept
    expect(res.reachable).toBe(true);
    expect(disk.rounds.map((r) => r.t).sort((a, b) => a - b)).toEqual([1, 99]); // persisted, no clobber
  });
});
