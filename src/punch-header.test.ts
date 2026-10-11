import { describe, test, expect } from "bun:test";
import { setPunchedHeader, parsePunchedValue } from "./punch-header";
import { parse } from "./ultrastar-parser";

const CHART = "#TITLE:Song\n#ARTIST:Band\n#BPM:120\n#GAP:1000\n: 0 4 55 Hel\nE\n";
const A = "spotify:track:aaa";
const B = "spotify:track:bbb";

describe("punched header", () => {
  test("set → parser reads this track's offset back; notes untouched", () => {
    const out = setPunchedHeader(CHART, A, -1234.4);
    expect(out).toContain("#SINGIFYPUNCHED:aaa=-1234\n: 0 4 55 Hel");
    expect(parse(out).headers.punchedOffsets).toEqual({ aaa: -1234 });
    expect(parse(out).lines).toEqual(parse(CHART).lines);
  });

  test("two Spotify versions of one song keep separate offsets", () => {
    const both = setPunchedHeader(setPunchedHeader(CHART, A, -670), B, 44801);
    expect(both.match(/SINGIFYPUNCHED/g)?.length).toBe(1);
    expect(parse(both).headers.punchedOffsets).toEqual({ aaa: -670, bbb: 44801 });
  });

  test("re-set replaces; clearing the last entry restores the file byte-for-byte", () => {
    const twice = setPunchedHeader(setPunchedHeader(CHART, A, 10), A, 20);
    expect(parse(twice).headers.punchedOffsets).toEqual({ aaa: 20 });
    expect(setPunchedHeader(twice, A, null)).toBe(CHART);
  });

  test("a legacy unkeyed offset is ignored on read and dropped on write", () => {
    const legacy = CHART.replace("#GAP:1000\n", "#GAP:1000\n#SINGIFYPUNCHED:-670\n");
    expect(parse(legacy).headers.punchedOffsets).toEqual({});
    expect(parsePunchedValue("-670")).toEqual({});
    const rewritten = setPunchedHeader(legacy, B, 44801);
    expect(rewritten).toContain("#SINGIFYPUNCHED:bbb=44801");
    expect(rewritten).not.toContain("-670");
  });

  test("keeps a BOM and CRLF line endings", () => {
    const win = "﻿" + CHART.replace(/\n/g, "\r\n");
    const out = setPunchedHeader(win, A, 5);
    expect(out.startsWith("﻿#TITLE")).toBe(true);
    expect(out).toContain("#SINGIFYPUNCHED:aaa=5\r\n");
    expect(setPunchedHeader(out, A, null)).toBe(win);
  });

  test("an unmarked chart parses with no offsets", () => {
    expect(parse(CHART).headers.punchedOffsets).toEqual({});
  });
});
