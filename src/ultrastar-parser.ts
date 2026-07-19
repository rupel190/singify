/**
 * ultrastar-parser.ts — UltraStar .txt format parser
 *
 * Format reference:
 *   https://usdx.eu/format/
 *
 * Beat-to-millisecond conversion:
 *   UltraStar internally uses "beats" which are subdivisions of a musical
 *   quarter note. The BPM header value is already 4× the musical BPM in
 *   some older files, but the canonical conversion is:
 *
 *     ms = GAP + (beat × 60000) / (BPM × 4)
 *
 *   where BPM is the value from the #BPM header (which represents quarter-
 *   notes per minute in modern files — confirmed against usdb_syncer source).
 *
 *   RELATIVE mode (#RELATIVE:YES) means each line's beat counts restart from
 *   0 at each line break. We normalise these to absolute beats on parse.
 *
 * Supported note tokens:
 *   :  → normal note
 *   *  → golden note (bonus points in scoring)
 *   F  → freestyle (no pitch check, no scoring)
 *   -  → line break (beat of next line start, optional second value = end beat)
 *   E  → end of song
 *   #  → header tag
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type NoteType = "normal" | "golden" | "freestyle";

export interface Syllable {
  text: string;
  startMs: number;
  durationMs: number;
  pitch: number;        // MIDI-ish: 0 = C4 area, relative to song's pitch range
  type: NoteType;
  startBeat: number;    // kept for debugging / pitch lane rendering
  durationBeats: number;
}

export interface Line {
  syllables: Syllable[];
  startMs: number;      // ms of first syllable
  endMs: number;        // ms after last syllable ends
}

export interface USHeaders {
  title: string;
  artist: string;
  bpm: number;
  gap: number;          // ms before beat 0
  language?: string;
  edition?: string;
  genre?: string;
  year?: string;
  cover?: string;
  mp3?: string;
  video?: string;
  videogap?: number;    // seconds to offset video
  start?: number;       // seconds into audio to start from
  end?: number;         // ms to stop at (some files)
  relative: boolean;
  encoding?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface ParsedSong {
  headers: USHeaders;
  lines: Line[];
  durationMs: number;   // total duration (last syllable end)
}

// ── Parser ─────────────────────────────────────────────────────────────────

export function parse(raw: string): ParsedSong {
  // Normalise line endings
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  const headers = parseHeaders(lines);
  const { bpm, gap, relative } = headers;

  if (!bpm || bpm <= 0) throw new Error("Invalid or missing #BPM in UltraStar file");

  // ms per beat: BPM header is quarter-notes/min, each beat = 1/4 quarter note
  const msPerBeat = 60000 / (bpm * 4);

  const beatToMs = (beat: number): number => gap + beat * msPerBeat;

  // ── Parse notes ──
  const songLines: Line[] = [];
  let currentSyllables: Syllable[] = [];
  let absoluteBeatOffset = 0;  // used for RELATIVE mode

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const token = line[0];

    if (token === "E") break;  // end of song

    if (token === "-") {
      // Line break — flush current line
      if (currentSyllables.length > 0) {
        const startMs = currentSyllables[0].startMs;
        const last = currentSyllables[currentSyllables.length - 1];
        const endMs = last.startMs + last.durationMs;

        songLines.push({ syllables: currentSyllables, startMs, endMs });
        currentSyllables = [];
      }

      if (relative) {
        // In RELATIVE mode, the - line gives the beat of the next line start
        const parts = line.split(/\s+/);
        const nextLineBeat = parseInt(parts[1] ?? "0", 10);
        absoluteBeatOffset += nextLineBeat;
      }
      continue;
    }

    // Note lines: `: beat duration pitch text` or `* ...` or `F ...`
    const noteType = noteTypeFromToken(token);
    if (!noteType) continue;

    // Split on first whitespace groups, text may have spaces
    const match = line.match(/^[:*F]\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)/);
    if (!match) continue;

    const localBeat = parseInt(match[1], 10);
    const durationBeats = parseInt(match[2], 10);
    const pitch = parseInt(match[3], 10);
    const text = match[4] ?? "";

    const absoluteBeat = relative ? absoluteBeatOffset + localBeat : localBeat;
    const startMs = beatToMs(absoluteBeat);
    const durationMs = durationBeats * msPerBeat;

    currentSyllables.push({
      text,
      startMs,
      durationMs,
      pitch,
      type: noteType,
      startBeat: absoluteBeat,
      durationBeats,
    });
  }

  // Flush final line if not terminated by E
  if (currentSyllables.length > 0) {
    const startMs = currentSyllables[0].startMs;
    const last = currentSyllables[currentSyllables.length - 1];
    const endMs = last.startMs + last.durationMs;
    songLines.push({ syllables: currentSyllables, startMs, endMs });
  }

  const durationMs =
    songLines.length > 0
      ? songLines[songLines.length - 1].endMs
      : 0;

  return { headers, lines: songLines, durationMs };
}

// ── Header parser ──────────────────────────────────────────────────────────

function parseHeaders(lines: string[]): USHeaders {
  const raw: Record<string, string> = {};

  for (const line of lines) {
    if (!line.startsWith("#")) break;  // headers always come first
    const colon = line.indexOf(":");
    if (colon < 2) continue;
    const key = line.slice(1, colon).toUpperCase().trim();
    const value = line.slice(colon + 1).trim();
    raw[key] = value;
  }

  const bpm = parseFloat((raw.BPM ?? "0").replace(",", "."));
  const gap = parseFloat((raw.GAP ?? "0").replace(",", "."));

  return {
    title: raw.TITLE ?? "",
    artist: raw.ARTIST ?? "",
    bpm,
    gap,
    language: raw.LANGUAGE,
    edition: raw.EDITION,
    genre: raw.GENRE,
    year: raw.YEAR,
    cover: raw.COVER,
    mp3: raw.MP3,
    video: raw.VIDEO,
    videogap: raw.VIDEOGAP ? parseFloat(raw.VIDEOGAP.replace(",", ".")) : undefined,
    start: raw.START ? parseFloat(raw.START.replace(",", ".")) : undefined,
    end: raw.END ? parseFloat(raw.END.replace(",", ".")) : undefined,
    relative: (raw.RELATIVE ?? "").toLowerCase() === "yes",
    encoding: raw.ENCODING,
  };
}

function noteTypeFromToken(token: string): NoteType | null {
  switch (token) {
    case ":": return "normal";
    case "*": return "golden";
    case "F": return "freestyle";
    default:  return null;
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * Given a current playback position in ms, returns:
 *   - lineIndex: which Line is active (-1 if before first / after last)
 *   - syllableIndex: which Syllable within that line is active (-1 if between syllables)
 *   - nextSyllableMs: ms until the next syllable starts (useful for scheduling)
 */
export function getPosition(
  song: ParsedSong,
  positionMs: number
): { lineIndex: number; syllableIndex: number; nextSyllableMs: number } {
  const { lines } = song;

  let lineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (positionMs >= lines[i].startMs && positionMs < lines[i].endMs) {
      lineIndex = i;
      break;
    }
    // Even if we're between lines, track the approaching line
    if (positionMs < lines[i].startMs) {
      lineIndex = i;
      break;
    }
  }

  if (lineIndex === -1) lineIndex = lines.length - 1;

  const line = lines[lineIndex];
  if (!line) return { lineIndex: -1, syllableIndex: -1, nextSyllableMs: Infinity };

  let syllableIndex = -1;
  let nextSyllableMs = Infinity;

  for (let i = 0; i < line.syllables.length; i++) {
    const s = line.syllables[i];
    if (positionMs >= s.startMs && positionMs < s.startMs + s.durationMs) {
      syllableIndex = i;
      const next = line.syllables[i + 1];
      nextSyllableMs = next ? next.startMs - positionMs : Infinity;
      break;
    }
    if (positionMs < s.startMs) {
      nextSyllableMs = s.startMs - positionMs;
      break;
    }
  }

  return { lineIndex, syllableIndex, nextSyllableMs };
}

/**
 * Returns the pitch range of the song [min, max] for normalising the pitch
 * lane display. Excludes freestyle notes (no pitch meaning).
 */
export function getPitchRange(song: ParsedSong): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const line of song.lines) {
    for (const s of line.syllables) {
      if (s.type !== "freestyle") {
        if (s.pitch < min) min = s.pitch;
        if (s.pitch > max) max = s.pitch;
      }
    }
  }
  return [min === Infinity ? 0 : min, max === -Infinity ? 0 : max];
}
