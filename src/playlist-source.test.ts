import { describe, test, expect } from "bun:test";
import {
  isPlaylistUri,
  toPlaylistRef,
  toSessionTrack,
  flattenRootlist,
} from "./playlist-source";

describe("isPlaylistUri", () => {
  test("accepts modern and legacy user-scoped playlist URIs", () => {
    expect(isPlaylistUri("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M")).toBe(true);
    expect(isPlaylistUri("spotify:user:abc:playlist:123")).toBe(true);
  });
  test("rejects non-playlists", () => {
    expect(isPlaylistUri("spotify:track:123")).toBe(false);
    expect(isPlaylistUri("spotify:album:123")).toBe(false);
    expect(isPlaylistUri(null)).toBe(false);
    expect(isPlaylistUri(42)).toBe(false);
  });
});

describe("toPlaylistRef", () => {
  test("maps a well-formed playlist item", () => {
    const ref = toPlaylistRef({
      uri: "spotify:playlist:1",
      name: "Bangers",
      totalLength: 12,
    });
    expect(ref).toEqual({ uri: "spotify:playlist:1", name: "Bangers", count: 12 });
  });

  test("falls back for name and count when absent", () => {
    const ref = toPlaylistRef({ uri: "spotify:playlist:2" });
    expect(ref?.name).toBe("Untitled playlist");
    expect(ref?.count).toBeNull();
  });

  test("reads name/count from a metadata sub-object", () => {
    const ref = toPlaylistRef({
      uri: "spotify:playlist:3",
      metadata: { name: "From Meta", length: 4 },
    });
    expect(ref?.name).toBe("From Meta");
    expect(ref?.count).toBe(4);
  });

  test("returns null for folders and junk", () => {
    expect(toPlaylistRef({ type: "folder", uri: "spotify:folder:x" })).toBeNull();
    expect(toPlaylistRef(null)).toBeNull();
    expect(toPlaylistRef("nope")).toBeNull();
  });
});

describe("toSessionTrack", () => {
  test("maps artists as an object list", () => {
    const t = toSessionTrack({
      uri: "spotify:track:1",
      name: "One",
      artists: [{ name: "A" }, { name: "B" }],
    });
    expect(t).toEqual({ uri: "spotify:track:1", title: "One", artist: "A, B" });
  });

  test("unwraps a nested .track and string artists", () => {
    const t = toSessionTrack({
      track: { uri: "spotify:track:2", name: "Two", artists: "Solo" },
    });
    expect(t).toEqual({ uri: "spotify:track:2", title: "Two", artist: "Solo" });
  });

  test("rejects non-track rows (local files, episodes)", () => {
    expect(toSessionTrack({ uri: "spotify:local:x", name: "L" })).toBeNull();
    expect(toSessionTrack({ uri: "spotify:episode:x", name: "E" })).toBeNull();
    expect(toSessionTrack({ name: "no uri" })).toBeNull();
    expect(toSessionTrack(null)).toBeNull();
  });
});

describe("flattenRootlist", () => {
  test("flattens nested folders, keeping only playlists in order", () => {
    const root = {
      items: [
        { uri: "spotify:playlist:a", name: "A", totalLength: 1 },
        {
          type: "folder",
          name: "Folder",
          items: [
            { uri: "spotify:playlist:b", name: "B", totalLength: 2 },
            { uri: "spotify:playlist:c", name: "C", totalLength: 3 },
          ],
        },
        { uri: "spotify:track:skip", name: "not a playlist" },
      ],
    };
    const refs = flattenRootlist(root);
    expect(refs.map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  test("tolerates a bare array and missing children", () => {
    expect(flattenRootlist([{ uri: "spotify:playlist:x", name: "X" }])).toHaveLength(1);
    expect(flattenRootlist(null)).toEqual([]);
  });
});
