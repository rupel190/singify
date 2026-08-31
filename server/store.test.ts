import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStore, writeStore, storePath } from "./store";

let dir: string;
const prev = {
  config: process.env.XDG_CONFIG_HOME,
  data: process.env.XDG_DATA_HOME,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "singify-store-"));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_DATA_HOME = join(dir, "data");
});

afterAll(async () => {
  // Restore env so we don't disturb other suites (cache/config resolve XDG too).
  if (prev.config === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prev.config;
  if (prev.data === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prev.data;
  await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
  test("unknown name is not a path — undefined / false", async () => {
    expect(await readStore("../../etc/passwd")).toBeUndefined();
    expect(await readStore("nope")).toBeUndefined();
    expect(await writeStore("nope", { a: 1 })).toBe(false);
  });

  test("missing store reads as {}", async () => {
    expect(await readStore("stats")).toEqual({});
  });

  test("write then read round-trips", async () => {
    const doc = { rounds: [{ t: 1, difficulty: "easy", players: [] }] };
    expect(await writeStore("stats", doc)).toBe(true);
    expect(await readStore("stats")).toEqual(doc);
  });

  test("stores land in the right XDG roots", () => {
    expect(storePath("stats")!.startsWith(join(dir, "data"))).toBe(true);
    expect(storePath("offsets")!.startsWith(join(dir, "data"))).toBe(true);
    expect(storePath("settings")!.startsWith(join(dir, "config"))).toBe(true);
  });

  test("corrupt file reads as {} rather than throwing", async () => {
    await writeStore("offsets", { a: 1 }); // create the dir + file
    await writeFile(storePath("offsets")!, "{ not json", "utf8");
    expect(await readStore("offsets")).toEqual({});
  });
});
