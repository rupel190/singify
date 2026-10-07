import { describe, test, expect } from "bun:test";
import { setPunchedHeader } from "./punch-header";
import { parse } from "./ultrastar-parser";

const CHART = "#TITLE:Song\n#ARTIST:Band\n#BPM:120\n#GAP:1000\n: 0 4 55 Hel\nE\n";

describe("punched header", () => {
  test("set → parser reads the offset back; notes untouched", () => {
    const out = setPunchedHeader(CHART, -1234.4);
    expect(out).toContain("#SINGIFYPUNCHED:-1234\n: 0 4 55 Hel");
    expect(parse(out).headers.punchedOffsetMs).toBe(-1234);
    expect(parse(out).lines).toEqual(parse(CHART).lines);
  });

  test("re-set replaces instead of stacking; clear restores the file byte-for-byte", () => {
    const twice = setPunchedHeader(setPunchedHeader(CHART, 10), 20);
    expect(twice.match(/SINGIFYPUNCHED/g)?.length).toBe(1);
    expect(parse(twice).headers.punchedOffsetMs).toBe(20);
    expect(setPunchedHeader(twice, null)).toBe(CHART);
  });

  test("keeps a BOM and CRLF line endings", () => {
    const win = "﻿" + CHART.replace(/\n/g, "\r\n");
    const out = setPunchedHeader(win, 5);
    expect(out.startsWith("﻿#TITLE")).toBe(true);
    expect(out).toContain("#SINGIFYPUNCHED:5\r\n");
    expect(setPunchedHeader(out, null)).toBe(win);
  });

  test("an unmarked chart parses with no offset", () => {
    expect(parse(CHART).headers.punchedOffsetMs).toBeUndefined();
  });
});
