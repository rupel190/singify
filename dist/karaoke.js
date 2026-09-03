// src/ultrastar-parser.ts
function isRapNote(t) {
  return t === "rap" || t === "golden-rap";
}
function isGoldenNote(t) {
  return t === "golden" || t === "golden-rap";
}
function parse(raw) {
  raw = raw.replace(/^﻿/, "");
  const lines = raw.replace(/\r\n/g, `
`).replace(/\r/g, `
`).split(`
`);
  const headers = parseHeaders(lines);
  const { bpm, gap, relative } = headers;
  if (!bpm || bpm <= 0)
    throw new Error("Invalid or missing #BPM in UltraStar file");
  const msPerBeat = 60000 / (bpm * 4);
  const beatToMs = (beat) => gap + beat * msPerBeat;
  const songLines = [];
  let currentSyllables = [];
  let absoluteBeatOffset = 0;
  for (const raw2 of lines) {
    const line = raw2.replace(/^\s+/, "");
    if (!line || line.startsWith("#"))
      continue;
    const token = line[0];
    if (token === "E")
      break;
    if (token === "-") {
      if (currentSyllables.length > 0) {
        const startMs2 = currentSyllables[0].startMs;
        const last = currentSyllables[currentSyllables.length - 1];
        const endMs = last.startMs + last.durationMs;
        songLines.push({ syllables: currentSyllables, startMs: startMs2, endMs });
        currentSyllables = [];
      }
      if (relative) {
        const parts = line.split(/\s+/);
        const nextLineBeat = parseInt(parts[1] ?? "0", 10);
        absoluteBeatOffset += nextLineBeat;
      }
      continue;
    }
    const noteType = noteTypeFromToken(token);
    if (!noteType)
      continue;
    const match = line.match(/^[:*FRG]\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)/);
    if (!match)
      continue;
    const localBeat = parseInt(match[1], 10);
    const durationBeats = parseInt(match[2], 10);
    const pitch = parseInt(match[3], 10);
    const text = match[4] ?? "";
    const absoluteBeat = relative ? absoluteBeatOffset + localBeat : localBeat;
    const startMs = beatToMs(absoluteBeat);
    const durationMs2 = durationBeats * msPerBeat;
    currentSyllables.push({
      text,
      startMs,
      durationMs: durationMs2,
      pitch,
      type: noteType,
      startBeat: absoluteBeat,
      durationBeats
    });
  }
  if (currentSyllables.length > 0) {
    const startMs = currentSyllables[0].startMs;
    const last = currentSyllables[currentSyllables.length - 1];
    const endMs = last.startMs + last.durationMs;
    songLines.push({ syllables: currentSyllables, startMs, endMs });
  }
  const durationMs = songLines.length > 0 ? songLines[songLines.length - 1].endMs : 0;
  return { headers, lines: songLines, durationMs };
}
function parseHeaders(lines) {
  const raw = {};
  for (const line of lines) {
    if (!line.startsWith("#"))
      break;
    const colon = line.indexOf(":");
    if (colon < 2)
      continue;
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
    encoding: raw.ENCODING
  };
}
function noteTypeFromToken(token) {
  switch (token) {
    case ":":
      return "normal";
    case "*":
      return "golden";
    case "F":
      return "freestyle";
    case "R":
      return "rap";
    case "G":
      return "golden-rap";
    default:
      return null;
  }
}
function getPosition(song, positionMs) {
  const { lines } = song;
  let lineIndex = -1;
  for (let i = 0;i < lines.length; i++) {
    if (positionMs >= lines[i].startMs && positionMs < lines[i].endMs) {
      lineIndex = i;
      break;
    }
    if (positionMs < lines[i].startMs) {
      lineIndex = i;
      break;
    }
  }
  if (lineIndex === -1)
    lineIndex = lines.length - 1;
  const line = lines[lineIndex];
  if (!line)
    return { lineIndex: -1, syllableIndex: -1, nextSyllableMs: Infinity };
  let syllableIndex = -1;
  let nextSyllableMs = Infinity;
  for (let i = 0;i < line.syllables.length; i++) {
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
function getPitchRange(song) {
  let min = Infinity;
  let max = -Infinity;
  for (const line of song.lines) {
    for (const s of line.syllables) {
      if (s.type !== "freestyle") {
        if (s.pitch < min)
          min = s.pitch;
        if (s.pitch > max)
          max = s.pitch;
      }
    }
  }
  return [min === Infinity ? 0 : min, max === -Infinity ? 0 : max];
}
function targetPitchAt(song, positionMs) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const line of song.lines) {
    for (const s of line.syllables) {
      if (s.type === "freestyle")
        continue;
      const start = s.startMs;
      const end = start + s.durationMs;
      if (positionMs >= start && positionMs < end)
        return s.pitch;
      const dist = positionMs < start ? start - positionMs : positionMs - end;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = s.pitch;
      }
    }
  }
  return nearest;
}

// src/pitch.ts
var A4_HZ = 440;
function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / A4_HZ);
}
function foldToOctaveOf(midi, lo, hi) {
  const center = (lo + hi) / 2;
  let m = midi;
  while (m - center > 6)
    m -= 12;
  while (center - m > 6)
    m += 12;
  return m;
}
function createPitchSmoother(opts = {}) {
  const window2 = Math.max(1, opts.window ?? 3);
  const alpha = opts.alpha ?? 0.5;
  const holdFrames = opts.holdFrames ?? 3;
  const buf = [];
  let ema = null;
  let nullRun = 0;
  const median = () => {
    const s = [...buf].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  return {
    push(midi) {
      if (midi == null) {
        nullRun++;
        if (nullRun > holdFrames) {
          buf.length = 0;
          ema = null;
          return null;
        }
        return ema;
      }
      nullRun = 0;
      buf.push(midi);
      if (buf.length > window2)
        buf.shift();
      const med = median();
      ema = ema == null ? med : alpha * med + (1 - alpha) * ema;
      return ema;
    },
    reset() {
      buf.length = 0;
      ema = null;
      nullRun = 0;
    }
  };
}
function foldSmoothHit(smoother, rawMidi, targetPitch, tolerance) {
  let smoothed;
  if (rawMidi == null || targetPitch == null) {
    smoothed = smoother.push(null);
  } else {
    smoothed = smoother.push(foldToOctaveOf(rawMidi, targetPitch, targetPitch));
  }
  if (smoothed == null || targetPitch == null)
    return { pitch: smoothed, hit: false };
  const hit = Math.abs(smoothed - targetPitch) <= tolerance;
  return { pitch: hit ? targetPitch : smoothed, hit };
}
function rms(samples) {
  if (samples.length === 0)
    return 0;
  let sum = 0;
  for (let i = 0;i < samples.length; i++)
    sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
function sensitivityToThreshold(sensitivity) {
  const s = Math.min(100, Math.max(0, sensitivity));
  const MIN = 0.003;
  const MAX = 0.12;
  return MAX * (MIN / MAX) ** (s / 100);
}
function thresholdToSensitivity(threshold) {
  const MIN = 0.003;
  const MAX = 0.12;
  const t = Math.min(MAX, Math.max(MIN, threshold));
  return Math.min(100, Math.max(0, 100 * (Math.log(t / MAX) / Math.log(MIN / MAX))));
}
var METER_PEAK = 0.35;
function rmsToMeter(rms2) {
  return Math.min(1, Math.max(0, Math.sqrt(Math.max(0, rms2) / METER_PEAK)));
}
function meterToRms(frac) {
  const f = Math.min(1, Math.max(0, frac));
  return f * f * METER_PEAK;
}
var _acf = null;
function acfScratch(n) {
  if (!_acf || _acf.length < n)
    _acf = new Float32Array(n);
  return _acf;
}
function detectPitch(samples, opts) {
  const {
    sampleRate,
    minHz = 70,
    maxHz = 1100,
    rmsThreshold = 0.01,
    clarityThreshold = 0.9
  } = opts;
  const n = samples.length;
  if (n < 2)
    return null;
  if (rms(samples) < rmsThreshold)
    return null;
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / minHz));
  const acfMax = Math.min(n - 1, maxLag + 1);
  const c = acfScratch(n);
  for (let lag = 0;lag <= acfMax; lag++) {
    let sum = 0;
    for (let i = 0;i < n - lag; i++)
      sum += samples[i] * samples[i + lag];
    c[lag] = sum;
  }
  let d = 0;
  while (d < acfMax && c[d] > c[d + 1])
    d++;
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = Math.max(d, minLag);lag <= maxLag; lag++) {
    if (c[lag] > bestVal) {
      bestVal = c[lag];
      bestLag = lag;
    }
  }
  if (bestLag <= 0)
    return null;
  const x0 = c[bestLag - 1];
  const x1 = c[bestLag];
  const x2 = bestLag + 1 < n ? c[bestLag + 1] : c[bestLag];
  const denom = x0 + x2 - 2 * x1;
  const shift = denom !== 0 ? 0.5 * (x0 - x2) / denom : 0;
  const period = bestLag + shift;
  if (period <= 0)
    return null;
  const hz = sampleRate / period;
  if (hz < minHz || hz > maxHz)
    return null;
  let m = 0;
  for (let i = 0;i < n - bestLag; i++) {
    m += samples[i] * samples[i] + samples[i + bestLag] * samples[i + bestLag];
  }
  const clarity = m > 0 ? 2 * bestVal / m : 0;
  if (clarity < clarityThreshold)
    return null;
  return { hz, midi: hzToMidi(hz), clarity: Math.min(1, Math.max(0, clarity)) };
}

// src/scoring.ts
var SCORE_FACTOR = {
  normal: 1,
  golden: 2,
  freestyle: 0,
  rap: 1,
  "golden-rap": 2
};
var NOTE_POINTS = 9000;
var LINE_BONUS = 1000;
function toleranceSemitones(difficulty) {
  return difficulty === "easy" ? 2 : difficulty === "medium" ? 1 : 0;
}
function gradeForScore(total) {
  if (total >= 9000)
    return { name: "Superstar", stars: 5 };
  if (total >= 7500)
    return { name: "Lead Singer", stars: 4 };
  if (total >= 6000)
    return { name: "Rising Star", stars: 3 };
  if (total >= 4000)
    return { name: "Hopeful", stars: 2 };
  if (total >= 2000)
    return { name: "Amateur", stars: 1 };
  return { name: "Tone Deaf", stars: 0 };
}
function createScoreKeeper(song, difficulty = "easy") {
  const tol = toleranceSemitones(difficulty);
  const notes = [];
  let totalWeight = 0;
  const bonusLines = new Set;
  song.lines.forEach((line, li) => {
    for (const s of line.syllables) {
      const factor = SCORE_FACTOR[s.type];
      const weight = s.durationBeats * factor;
      if (weight <= 0)
        continue;
      totalWeight += weight;
      bonusLines.add(li);
      notes.push({
        pitch: s.pitch,
        weight,
        maxPoints: 0,
        lineIndex: li,
        startMs: s.startMs,
        endMs: s.startMs + s.durationMs,
        hitFrames: 0,
        totalFrames: 0,
        rap: isRapNote(s.type)
      });
    }
  });
  for (const n of notes) {
    n.maxPoints = totalWeight > 0 ? n.weight / totalWeight * NOTE_POINTS : 0;
  }
  notes.sort((a, b) => a.startMs - b.startMs);
  const nBonusLines = bonusLines.size;
  function activeNote(ms) {
    let lo = 0;
    let hi = notes.length - 1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      const n = notes[mid];
      if (ms < n.startMs)
        hi = mid - 1;
      else if (ms >= n.endMs)
        lo = mid + 1;
      else
        return n;
    }
    return null;
  }
  function sample(positionMs, sungMidi) {
    const n = activeNote(positionMs);
    if (!n)
      return;
    n.totalFrames++;
    if (sungMidi == null)
      return;
    if (n.rap) {
      n.hitFrames++;
      return;
    }
    const folded = foldToOctaveOf(sungMidi, n.pitch, n.pitch);
    if (Math.abs(folded - n.pitch) <= tol)
      n.hitFrames++;
  }
  function read() {
    let notePoints = 0;
    let notesSung = 0;
    const lineWeight = new Map;
    const lineCredit = new Map;
    for (const n of notes) {
      const f = n.totalFrames > 0 ? n.hitFrames / n.totalFrames : 0;
      notePoints += n.maxPoints * f;
      if (f > 0)
        notesSung++;
      lineWeight.set(n.lineIndex, (lineWeight.get(n.lineIndex) ?? 0) + n.weight);
      lineCredit.set(n.lineIndex, (lineCredit.get(n.lineIndex) ?? 0) + n.weight * f);
    }
    let linePoints = 0;
    if (nBonusLines > 0) {
      const perLine = LINE_BONUS / nBonusLines;
      for (const li of bonusLines) {
        const w = lineWeight.get(li) ?? 0;
        const credit = w > 0 ? (lineCredit.get(li) ?? 0) / w : 0;
        linePoints += perLine * credit;
      }
    }
    return {
      total: Math.round(notePoints + linePoints),
      notePoints: Math.round(notePoints),
      linePoints: Math.round(linePoints),
      notesSung,
      notesTotal: notes.length
    };
  }
  function reset() {
    for (const n of notes) {
      n.hitFrames = 0;
      n.totalFrames = 0;
    }
  }
  return { sample, read, reset };
}

// src/theme.ts
var ACCENT = "#1ed760";
var GOLD = "#e6b422";
var SURFACE = {
  text: "#f2f2f5",
  sub: "#9a9aa6",
  card: "#16161c",
  border: "#2a2a33"
};

// src/result-screen.tsx
function ResultScreen(props) {
  const React = Spicetify.React;
  const { score, grade, title, onReplay, fullscreen } = props;
  const bigSize = fullscreen ? 96 : 64;
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      width: "100%",
      height: "100%",
      minHeight: fullscreen ? "100%" : 360,
      zoom: fullscreen ? 2.5 : 1,
      overflowY: "auto",
      gap: 10,
      color: "#fff",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      padding: 24,
      boxSizing: "border-box",
      textAlign: "center"
    }
  }, title && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 14, letterSpacing: 1, opacity: 0.6 }
  }, title.toUpperCase()), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: fullscreen ? 34 : 26, letterSpacing: 4 }
  }, Array.from({ length: 5 }).map((_, i) => /* @__PURE__ */ Spicetify.React.createElement("span", {
    key: i,
    style: { color: i < grade.stars ? GOLD : "#3a3a44" }
  }, "★"))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: fullscreen ? 40 : 30, fontWeight: 800, color: ACCENT }
  }, grade.name), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: bigSize,
      fontWeight: 900,
      lineHeight: 1,
      fontVariantNumeric: "tabular-nums",
      textShadow: "0 2px 18px rgba(30,215,96,0.25)"
    }
  }, score.total.toLocaleString()), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      gap: 24,
      marginTop: 6,
      fontSize: 13,
      color: "rgba(255,255,255,0.6)",
      fontVariantNumeric: "tabular-nums"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", null, "Notes ", score.notePoints.toLocaleString(), " / 9,000"), /* @__PURE__ */ Spicetify.React.createElement("span", null, "Line bonus ", score.linePoints.toLocaleString(), " / 1,000"), /* @__PURE__ */ Spicetify.React.createElement("span", null, score.notesSung, " / ", score.notesTotal, " notes hit")), onReplay && /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onReplay,
    style: {
      marginTop: 22,
      background: ACCENT,
      color: "#08210f",
      border: 0,
      borderRadius: 22,
      padding: "10px 26px",
      font: "700 14px system-ui",
      cursor: "pointer"
    }
  }, "Sing again"));
}

// src/karaoke-view.tsx
var NOW_FRACTION = 0.25;
var LOOKAHEAD_MS = 4000;
var FALLBACK_PX_PER_MS = 0.18;
var MAX_PX_PER_SEMITONE = 58;
var NOTE_FILL = 0.9;
var MAX_NOTE_HEIGHT = 66;
var MIN_NOTE_HEIGHT = 10;
var LANE_VPAD = 24;
var AXIS_LABEL_MAX = 40;
var TRAIL_MS = 1190;
var TRAIL_MAX = 160;
var SPARK_STREAK_MIN = 20;
var SPARK_EVERY = 4;
var SPARK_MAX_PER_BURST = 4;
var VIRT_PAST_MS = 2600;
var VIRT_FUTURE_MS = 900;
function lowerBoundStart(arr, ms) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (arr[mid].startMs < ms)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}
var MARKER_SCALE = 1.6;
var TRAIL_DOT_MAX = 0.7;
var COLORS = {
  laneBg: "rgba(0, 0, 0, 0.28)",
  nowLine: ACCENT,
  noteNormal: "#4a78c2",
  noteGolden: GOLD,
  gridLine: "rgba(255, 255, 255, 0.06)",
  lyricDone: "#6d6d6d",
  lyricUpcoming: "#c8c8c8",
  lyricActive: "#ffffff",
  lyricWipe: ACCENT,
  livePitch: "#ff5ea8",
  axisLabel: "rgba(255, 255, 255, 0.58)"
};
var PLAYER_COLORS = [COLORS.livePitch, "#3a86ff", "#a05cff", "#43d17a"];
var NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
function midiToName(midi) {
  const r = Math.round(midi);
  return NOTE_NAMES[(r % 12 + 12) % 12] + (Math.floor(r / 12) - 1);
}
function useSize(ref) {
  const { useState, useEffect } = Spicetify.React;
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el)
      return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref.current]);
  return size;
}
function useFrame(getPositionMs, computeFrame) {
  const { useState, useEffect, useRef } = Spicetify.React;
  const [frame, setFrame] = useState({ ms: 0, players: [] });
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      setFrame(computeFrame(getPositionMs()));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [getPositionMs, computeFrame]);
  return frame;
}
function ensureGoldShimmer() {
  if (typeof document === "undefined" || document.getElementById("singify-gold-shimmer"))
    return;
  const st = document.createElement("style");
  st.id = "singify-gold-shimmer";
  st.textContent = "@keyframes singify-gold-shimmer{from{background-position:220% 0}to{background-position:-20% 0}}";
  document.head.appendChild(st);
}
function ensureSparkStyles() {
  if (typeof document === "undefined" || document.getElementById("singify-spark"))
    return;
  const st = document.createElement("style");
  st.id = "singify-spark";
  st.textContent = "@keyframes singify-spark{from{opacity:1;transform:translate(0,0) scale(1)}to{opacity:0;transform:translate(var(--dx),var(--dy)) scale(0.25)}}";
  document.head.appendChild(st);
}
function spawnSpark(layer, x, y, noteH) {
  const s = Math.max(3, noteH * 0.22);
  const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
  const dist = noteH * (0.9 + Math.random() * 1.5);
  const dx = Math.cos(ang) * dist;
  const dy = Math.sin(ang) * dist;
  const color = Math.random() < 0.4 ? "#ffffff" : COLORS.nowLine;
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:${(x - s / 2).toFixed(1)}px;top:${(y - s / 2).toFixed(1)}px;` + `width:${s.toFixed(1)}px;height:${s.toFixed(1)}px;border-radius:50%;pointer-events:none;` + `background:${color};box-shadow:0 0 ${(s * 1.5).toFixed(1)}px ${color};` + `--dx:${dx.toFixed(1)}px;--dy:${dy.toFixed(1)}px;` + `animation:singify-spark ${520 + Math.floor(Math.random() * 240)}ms ease-out forwards;`;
  el.addEventListener("animationend", () => el.remove(), { once: true });
  layer.appendChild(el);
}
function ensureTrailStyles() {
  if (typeof document === "undefined" || document.getElementById("singify-trail"))
    return;
  const st = document.createElement("style");
  st.id = "singify-trail";
  st.textContent = "@keyframes singify-trail{from{opacity:0.72;transform:scale(1)}to{opacity:0;transform:scale(0.5)}}";
  document.head.appendChild(st);
}
function spawnTrailDot(layer, x, y, size, color) {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:${(x - size / 2).toFixed(1)}px;top:${(y - size / 2).toFixed(1)}px;` + `width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;border-radius:50%;pointer-events:none;` + `background:${color};animation:singify-trail ${TRAIL_MS}ms linear forwards;`;
  el.addEventListener("animationend", () => el.remove(), { once: true });
  layer.appendChild(el);
}
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16 & 255)}, ${c(n >> 8 & 255)}, ${c(n & 255)})`;
}
function Lane(props) {
  const React = Spicetify.React;
  const { useRef, useMemo, useEffect } = React;
  const { song, positionMs, nowLineNudge, player, markerPitch, markerHit, score, trail, multiplayer } = props;
  const laneRef = useRef(null);
  const lane = useSize(laneRef);
  const sparkLayerRef = useRef(null);
  const streakRef = useRef(0);
  const sparkTickRef = useRef(0);
  const trailLayerRef = useRef(null);
  const lastTrailMsRef = useRef(-1);
  const [minPitch, maxPitch] = useMemo(() => getPitchRange(song), [song]);
  const pitchSpan = Math.max(1, maxPitch - minPitch);
  const innerH = Math.max(MIN_NOTE_HEIGHT, lane.h - LANE_VPAD * 2);
  const pxPerSemi = Math.min(MAX_PX_PER_SEMITONE, innerH / (pitchSpan + 1));
  const noteH = Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, Math.round(pxPerSemi * NOTE_FILL)));
  const bandH = pxPerSemi * pitchSpan;
  const bandTop = LANE_VPAD + Math.max(0, (innerH - bandH - noteH) / 2);
  const labelSize = Math.max(13, Math.min(AXIS_LABEL_MAX, Math.round(lane.h * 0.13)));
  const gutter = 12 + Math.round(labelSize * 2.6);
  const pxPerMs = lane.w > 0 ? lane.w * (1 - NOW_FRACTION) / LOOKAHEAD_MS : FALLBACK_PX_PER_MS;
  const yForPitch = (pitch) => bandTop + (1 - (pitch - minPitch) / pitchSpan) * bandH;
  const yCenterForPitch = (pitch) => yForPitch(pitch) + noteH / 2;
  const yForMarker = (pitch) => bandTop + (1 - Math.min(1, Math.max(0, (pitch - minPitch) / pitchSpan))) * bandH + noteH / 2;
  const pitchRows = useMemo(() => {
    const lo = Math.floor(minPitch);
    const hi = Math.ceil(maxPitch);
    const span = Math.max(1, hi - lo);
    const maxRows = Math.max(2, Math.min(7, Math.floor(bandH / (labelSize * 1.8))));
    const step = Math.max(1, Math.ceil(span / (maxRows - 1)));
    const rows = [];
    for (let m = lo;m <= hi; m += step)
      rows.push(m);
    return rows;
  }, [minPitch, maxPitch, bandH, labelSize]);
  const noteTint = player ? shade(player.color, 0.66) : COLORS.noteNormal;
  const allNotes = useMemo(() => song.lines.flatMap((l) => l.syllables).filter((s) => s.type !== "freestyle").sort((a, b) => a.startMs - b.startMs), [song]);
  const firstIdx = lowerBoundStart(allNotes, positionMs - VIRT_PAST_MS);
  const lastIdx = lowerBoundStart(allNotes, positionMs + LOOKAHEAD_MS + VIRT_FUTURE_MS);
  const noteEls = useMemo(() => {
    const els = [];
    for (let i = firstIdx;i < lastIdx; i++) {
      const sy = allNotes[i];
      els.push(/* @__PURE__ */ Spicetify.React.createElement("div", {
        key: i,
        style: {
          position: "absolute",
          left: sy.startMs * pxPerMs,
          width: Math.max(3, sy.durationMs * pxPerMs - 2),
          top: yForPitch(sy.pitch),
          height: noteH,
          borderRadius: noteH / 2,
          ...isGoldenNote(sy.type) ? {
            background: "linear-gradient(100deg, #9a6f14 0%, #e6b422 26%, #fff4bf 50%, #e6b422 74%, #9a6f14 100%)",
            backgroundSize: "220% 100%",
            animation: "singify-gold-shimmer 2.4s linear infinite",
            boxShadow: "0 0 12px rgba(230,180,34,0.7)"
          } : isRapNote(sy.type) ? {
            background: `repeating-linear-gradient(115deg, ${noteTint} 0 6px, ${shade(noteTint, 0.6)} 6px 12px)`
          } : { background: noteTint }
        }
      }));
    }
    return els;
  }, [allNotes, firstIdx, lastIdx, lane.h, lane.w, minPitch, maxPitch, noteTint]);
  const nowX = lane.w * NOW_FRACTION;
  const trackTranslate = nowX - positionMs * pxPerMs;
  const markerColor = markerHit ? COLORS.nowLine : player?.color ?? COLORS.livePitch;
  const markerSize = Math.round(noteH * MARKER_SCALE);
  useEffect(() => {
    const layer = sparkLayerRef.current;
    const onPitch = markerHit && markerPitch != null;
    streakRef.current = onPitch ? streakRef.current + 1 : 0;
    if (!layer || !lane.w || streakRef.current < SPARK_STREAK_MIN)
      return;
    sparkTickRef.current += 1;
    if (sparkTickRef.current % SPARK_EVERY !== 0)
      return;
    ensureSparkStyles();
    const count = Math.min(SPARK_MAX_PER_BURST, 1 + Math.floor((streakRef.current - SPARK_STREAK_MIN) / 22));
    const y = yForMarker(markerPitch);
    for (let k = 0;k < count; k++)
      spawnSpark(layer, nowX, y, noteH);
  });
  useEffect(() => {
    const layer = trailLayerRef.current;
    if (!layer || !lane.w)
      return;
    if (positionMs < lastTrailMsRef.current - 500) {
      layer.replaceChildren();
      lastTrailMsRef.current = -1;
    }
    ensureTrailStyles();
    const size = noteH * TRAIL_DOT_MAX;
    const col = player?.color ?? COLORS.livePitch;
    for (const pt of trail) {
      if (pt.ms <= lastTrailMsRef.current)
        continue;
      lastTrailMsRef.current = pt.ms;
      spawnTrailDot(layer, pt.ms * pxPerMs, yForMarker(pt.pitch), size, pt.hit ? COLORS.nowLine : col);
    }
  });
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    ref: laneRef,
    style: { position: "relative", flex: "1 1 0", minHeight: 0, overflow: "hidden", borderRadius: 10, background: COLORS.laneBg }
  }, pitchRows.map((m) => {
    const y = yCenterForPitch(m);
    return /* @__PURE__ */ Spicetify.React.createElement("div", {
      key: `row${m}`
    }, /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { position: "absolute", left: gutter, right: 0, top: y, height: 1, background: COLORS.gridLine }
    }), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: {
        position: "absolute",
        left: 10,
        top: y - labelSize / 2,
        fontSize: labelSize,
        fontWeight: 600,
        lineHeight: 1,
        color: COLORS.axisLabel,
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none"
      }
    }, midiToName(m)));
  }), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: gutter + 20,
      background: `linear-gradient(to right, ${COLORS.laneBg}, transparent)`,
      pointerEvents: "none"
    }
  }), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { position: "absolute", inset: 0, transform: `translateX(${trackTranslate}px)`, willChange: "transform" }
  }, noteEls, /* @__PURE__ */ Spicetify.React.createElement("div", {
    ref: trailLayerRef,
    style: { position: "absolute", inset: 0, pointerEvents: "none" }
  })), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { position: "absolute", top: 0, bottom: 0, left: nowX + nowLineNudge, width: 3, background: COLORS.nowLine, boxShadow: `0 0 10px ${COLORS.nowLine}` }
  }), /* @__PURE__ */ Spicetify.React.createElement("div", {
    ref: sparkLayerRef,
    style: { position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }
  }), markerPitch != null && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      position: "absolute",
      left: nowX - markerSize / 2,
      top: 0,
      width: markerSize,
      height: markerSize,
      transform: `translateY(${yForMarker(markerPitch) - markerSize / 2}px)`,
      transition: "transform 60ms linear",
      willChange: "transform",
      pointerEvents: "none",
      zIndex: 3
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      width: "100%",
      height: "100%",
      borderRadius: "50%",
      boxSizing: "border-box",
      background: markerColor,
      border: `${Math.max(2, Math.round(markerSize * 0.14))}px solid #fff`,
      boxShadow: markerHit ? `0 0 ${markerSize * 1.3}px ${markerColor}, 0 0 ${markerSize / 2}px ${markerColor}, 0 0 0 2px rgba(0,0,0,0.55)` : `0 0 ${markerSize * 0.8}px ${markerColor}, 0 0 0 2px rgba(0,0,0,0.55)`,
      transform: markerHit ? "scale(1.32)" : "scale(1)",
      transition: "transform 110ms ease, box-shadow 110ms ease, background 90ms ease"
    }
  })), score && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 10,
      left: gutter + 16,
      textAlign: "left",
      fontVariantNumeric: "tabular-nums",
      pointerEvents: "none"
    }
  }, multiplayer && player && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 40, fontWeight: 800, color: player.color, lineHeight: 1 }
  }, player.name), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: 66,
      fontWeight: 800,
      lineHeight: 1,
      color: multiplayer && player ? player.color : COLORS.nowLine,
      textShadow: "0 1px 6px rgba(0,0,0,0.5)"
    }
  }, score.total.toLocaleString()), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { marginTop: 6, fontSize: 42, fontWeight: 600, color: "rgba(255,255,255,0.55)" }
  }, score.notesSung, "/", score.notesTotal, " notes")));
}
function KaraokeView(props) {
  const React = Spicetify.React;
  const { useRef, useMemo, useCallback, useEffect } = React;
  const { song, getPositionMs, onReplay, fullscreen } = props;
  const difficulty = props.difficulty ?? "easy";
  const nowLineNudge = props.nowLineNudge ?? 0;
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;
  const hitTolRef = useRef(toleranceSemitones(difficulty));
  hitTolRef.current = toleranceSemitones(difficulty);
  const players = useMemo(() => props.players ?? [], [props.players]);
  const scoring = players.length > 0;
  const idsKey = players.map((p) => p.id).join("|");
  const enginesRef = useRef(new Map);
  const engineFor = useCallback((id) => {
    let e = enginesRef.current.get(id);
    if (!e) {
      e = {
        keeper: createScoreKeeper(song, difficultyRef.current),
        smoother: createPitchSmoother(),
        trail: []
      };
      enginesRef.current.set(id, e);
    }
    return e;
  }, [song]);
  const lastMsRef = useRef(0);
  const playersRef = useRef(players);
  playersRef.current = players;
  const onDebugRef = useRef(props.onDebug);
  onDebugRef.current = props.onDebug;
  const completedRef = useRef(false);
  useEffect(() => ensureGoldShimmer(), []);
  useEffect(() => {
    enginesRef.current.clear();
    lastMsRef.current = 0;
    completedRef.current = false;
  }, [song, idsKey, props.resetToken, difficulty]);
  const computeFrame = useCallback((ms) => {
    const jumpedBack = ms < lastMsRef.current - 750;
    lastMsRef.current = ms;
    if (jumpedBack)
      completedRef.current = false;
    const target = targetPitchAt(song, ms);
    const ps = playersRef.current;
    const out = [];
    for (let i = 0;i < ps.length; i++) {
      const p = ps[i];
      const eng = engineFor(p.id);
      if (jumpedBack) {
        eng.keeper.reset();
        eng.smoother.reset();
        eng.trail.length = 0;
      }
      const rawMidi = p.getPitchMidi();
      eng.keeper.sample(ms, rawMidi);
      const score = eng.keeper.read();
      const { pitch, hit } = foldSmoothHit(eng.smoother, rawMidi, target, hitTolRef.current);
      if (pitch != null) {
        const buf = eng.trail;
        buf.push({ ms, pitch, hit });
        const cutoff = ms - TRAIL_MS;
        while (buf.length && buf[0].ms < cutoff)
          buf.shift();
        if (buf.length > TRAIL_MAX)
          buf.splice(0, buf.length - TRAIL_MAX);
      }
      if (i === 0) {
        onDebugRef.current?.({ rawMidi, targetPitch: target, markerPitch: pitch, markerHit: hit });
      }
      out.push({ id: p.id, markerPitch: pitch, markerHit: hit, score });
    }
    return { ms, players: out };
  }, [song, engineFor]);
  const frame = useFrame(getPositionMs, computeFrame);
  const positionMs = frame.ms;
  const rendered = frame.players.map((pf, i) => ({ ...pf, input: players[i] })).filter((r) => r.input);
  const laneEntries = rendered.length > 0 ? rendered : [null];
  const anyScore = frame.players.some((p) => p.score != null);
  const atEnd = scoring && anyScore && song.durationMs > 0 && positionMs >= song.durationMs;
  useEffect(() => {
    if (atEnd && !completedRef.current) {
      completedRef.current = true;
      const scores = rendered.filter((r) => r.score != null).map((r) => ({ id: r.id, name: r.input.name, score: r.score }));
      if (scores.length)
        props.onComplete?.(scores);
    }
  }, [atEnd]);
  if (atEnd) {
    if (props.onComplete)
      return null;
    const solo = frame.players[0];
    if (solo?.score) {
      return /* @__PURE__ */ Spicetify.React.createElement(ResultScreen, {
        score: solo.score,
        grade: gradeForScore(solo.score.total),
        title: song.headers.title,
        onReplay,
        fullscreen
      });
    }
  }
  const pos = getPosition(song, positionMs);
  const lineIndex = pos.lineIndex < 0 ? 0 : pos.lineIndex;
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      minHeight: fullscreen ? "100%" : 360,
      color: "#fff",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      gap: 12,
      padding: fullscreen ? "56px 28px 24px" : 16,
      boxSizing: "border-box"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end" }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      height: "75%",
      minHeight: 160,
      display: "flex",
      flexDirection: "column"
    }
  }, laneEntries.flatMap((e, i) => {
    const lane = /* @__PURE__ */ Spicetify.React.createElement(Lane, {
      key: e?.id ?? `lane${i}`,
      song,
      positionMs,
      nowLineNudge,
      player: e ? { id: e.id, name: e.input.name, color: e.input.color } : null,
      markerPitch: e?.markerPitch ?? null,
      markerHit: e?.markerHit ?? false,
      score: e?.score ?? null,
      trail: e ? enginesRef.current.get(e.id)?.trail ?? [] : [],
      multiplayer: laneEntries.length > 1
    });
    if (i === 0)
      return [lane];
    const divider = /* @__PURE__ */ Spicetify.React.createElement("div", {
      key: `div${i}`,
      style: {
        flex: "0 0 auto",
        height: 3,
        margin: "7px 0",
        borderRadius: 2,
        background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.32), transparent)"
      }
    });
    return [divider, lane];
  }))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      flex: "0 0 auto",
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: fullscreen ? 14 : 8,
      textAlign: "center",
      overflow: "hidden",
      paddingTop: fullscreen ? 28 : 16,
      paddingBottom: fullscreen ? 28 : 12,
      background: "linear-gradient(to bottom, transparent, rgba(0,0,0,0.30))"
    }
  }, [-1, 0, 1, 2].map((offset) => {
    const idx = lineIndex + offset;
    const line = song.lines[idx];
    if (!line)
      return /* @__PURE__ */ Spicetify.React.createElement("div", {
        key: offset,
        style: { minHeight: 8 }
      });
    const isCurrent = offset === 0;
    return /* @__PURE__ */ Spicetify.React.createElement(LyricLine, {
      key: idx,
      line,
      isCurrent,
      positionMs
    });
  })));
}
function LyricLine(props) {
  const React = Spicetify.React;
  const { line, isCurrent, positionMs } = props;
  const baseSize = 84;
  const size = isCurrent ? baseSize : baseSize * 0.6;
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: size,
      fontWeight: isCurrent ? 700 : 500,
      lineHeight: 1.15,
      opacity: isCurrent ? 1 : 0.5,
      transition: "opacity 120ms ease, font-size 120ms ease",
      whiteSpace: "pre-wrap"
    }
  }, line.syllables.map((s, i) => /* @__PURE__ */ Spicetify.React.createElement(SyllableSpan, {
    key: i,
    syllable: s,
    positionMs,
    active: isCurrent
  })));
}
function SyllableSpan(props) {
  const React = Spicetify.React;
  const { syllable: s, positionMs, active } = props;
  const end = s.startMs + s.durationMs;
  const text = s.text.replace(/~/g, "");
  let color = COLORS.lyricUpcoming;
  let backgroundImage;
  let scale = 1;
  if (active) {
    if (positionMs >= end) {
      color = COLORS.lyricDone;
    } else if (positionMs >= s.startMs) {
      const frac = Math.min(1, Math.max(0, (positionMs - s.startMs) / s.durationMs));
      const pct = Math.round(frac * 100);
      color = "transparent";
      backgroundImage = `linear-gradient(90deg, ${COLORS.lyricWipe} ${pct}%, ${COLORS.lyricActive} ${pct}%)`;
      scale = 1.08;
    }
  }
  return /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      color,
      backgroundImage,
      WebkitBackgroundClip: backgroundImage ? "text" : undefined,
      backgroundClip: backgroundImage ? "text" : undefined,
      display: "inline-block",
      transform: `scale(${scale})`,
      transformOrigin: "center bottom",
      transition: "transform 90ms ease"
    }
  }, text);
}

// src/song-picker.tsx
var C = {
  ...SURFACE,
  scrim: "rgba(8, 8, 12, 0.6)",
  rowHover: "#1e1e26",
  chip: "#22222b",
  green: ACCENT,
  greenInk: "#08210f",
  golden: GOLD,
  danger: "#ff6b6b"
};
function SongPicker(props) {
  const { candidates, query, pendingId, error, onPick, onCancel } = props;
  const busy = pendingId != null;
  const subtitle = [query?.artist, query?.title].filter(Boolean).join(" — ");
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "100%",
      height: "100%",
      minHeight: 360,
      padding: 20,
      boxSizing: "border-box",
      zoom: 3,
      overflowY: "auto",
      background: C.scrim,
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      width: "min(680px, 100%)",
      maxHeight: "100%",
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      overflow: "hidden",
      boxShadow: "0 20px 60px rgba(0,0,0,0.5)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { padding: "18px 20px 12px" }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { color: C.text, fontSize: 20, fontWeight: 700 }
  }, "Choose a karaoke chart"), subtitle && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { color: C.sub, fontSize: 13, marginTop: 3 }
  }, candidates.length, " matches for ", subtitle)), error && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      margin: "0 20px 8px",
      padding: "8px 12px",
      borderRadius: 8,
      background: "rgba(255,107,107,0.12)",
      color: C.danger,
      fontSize: 13
    }
  }, error), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { overflowY: "auto", padding: "4px 12px 12px" }
  }, candidates.map((c, i) => /* @__PURE__ */ Spicetify.React.createElement(PickerRow, {
    key: c.id,
    candidate: c,
    best: i === 0,
    pending: pendingId === c.id,
    disabled: busy,
    onPick
  }))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      padding: "12px 20px",
      borderTop: `1px solid ${C.border}`
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onCancel,
    disabled: busy,
    style: {
      background: "transparent",
      color: C.sub,
      border: `1px solid ${C.border}`,
      borderRadius: 20,
      padding: "8px 18px",
      font: "600 13px system-ui",
      cursor: busy ? "default" : "pointer",
      opacity: busy ? 0.5 : 1
    }
  }, "Cancel"))));
}
function PickerRow(props) {
  const { useState } = Spicetify.React;
  const { candidate: c, best, pending, disabled, onPick } = props;
  const [hover, setHover] = useState(false);
  const clickable = !disabled;
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onClick: () => clickable && onPick(c),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 12px",
      borderRadius: 10,
      cursor: clickable ? "pointer" : "default",
      background: hover && clickable ? C.rowHover : "transparent",
      opacity: disabled && !pending ? 0.45 : 1,
      transition: "background 90ms ease, opacity 120ms ease"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { flex: 1, minWidth: 0 }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: C.text,
      fontSize: 15,
      fontWeight: 600,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, c.title || "(untitled)", best && /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      flex: "none",
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.4,
      color: C.greenInk,
      background: C.green,
      borderRadius: 6,
      padding: "2px 6px"
    }
  }, "BEST MATCH")), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { color: C.sub, fontSize: 13, marginTop: 2 }
  }, c.artist || "Unknown artist"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }
  }, c.edition && /* @__PURE__ */ Spicetify.React.createElement(Chip, {
    label: c.edition
  }), c.language && /* @__PURE__ */ Spicetify.React.createElement(Chip, {
    label: c.language
  }), /* @__PURE__ */ Spicetify.React.createElement(Chip, {
    label: `★ ${c.rating.toFixed(1)}`
  }), /* @__PURE__ */ Spicetify.React.createElement(Chip, {
    label: `${c.views.toLocaleString()} views`
  }), c.golden && /* @__PURE__ */ Spicetify.React.createElement(Chip, {
    gold: true,
    label: "✦ golden"
  }))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { flex: "none", width: 104, textAlign: "right" }
  }, pending ? /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { color: C.green, fontSize: 13, fontWeight: 600 }
  }, "Downloading…") : /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      display: "inline-block",
      color: clickable && hover ? C.greenInk : C.text,
      background: clickable && hover ? C.green : "transparent",
      border: `1px solid ${clickable && hover ? C.green : C.border}`,
      borderRadius: 20,
      padding: "6px 14px",
      fontSize: 13,
      fontWeight: 600,
      transition: "background 90ms ease, color 90ms ease"
    }
  }, "Pick")));
}
function Chip(props) {
  return /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      fontSize: 11,
      color: props.gold ? C.golden : C.sub,
      background: C.chip,
      border: `1px solid ${props.gold ? "rgba(230,180,34,0.4)" : C.border}`,
      borderRadius: 6,
      padding: "2px 8px"
    }
  }, props.label);
}

// src/home-menu.tsx
function HomeMenu(props) {
  const React = Spicetify.React;
  const { track, onQuickSing, onStartSession, onCompetitive, onStats } = props;
  const card = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 10,
    width: "min(640px, 88vw)",
    padding: "30px 34px",
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 120ms ease, background 120ms ease"
  };
  const title = { fontSize: 45, fontWeight: 800, lineHeight: 1 };
  const sub = {
    fontSize: 24,
    fontWeight: 500,
    color: "rgba(255,255,255,0.6)"
  };
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 28,
      zoom: 1,
      height: "100%",
      overflowY: "auto",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 33, fontWeight: 800, letterSpacing: 3, color: ACCENT }
  }, "SINGIFY"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onQuickSing,
    style: { ...card, borderColor: `${ACCENT}66`, background: `${ACCENT}14` }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { ...title, color: ACCENT }
  }, "\uD83C\uDFA4 Quick Sing"), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: sub
  }, track ? `${track.artist} — ${track.title}` : "play something to sing along")), /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onStartSession,
    style: card
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: title
  }, "▶ Start a Session"), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: sub
  }, "multi-round · scores carry across songs · big finish")), /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onCompetitive,
    style: card
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: title
  }, "⚔ Competitive"), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: sub
  }, "one mic · same song · take turns · pure skill")), /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onStats,
    style: {
      background: "transparent",
      color: "rgba(255,255,255,0.72)",
      border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: 14,
      padding: "12px 22px",
      fontSize: 22,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, "\uD83D\uDCCA Stats"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 26, color: "rgba(255,255,255,0.5)", marginTop: 10 }
  }, "Q quick-sing · M mic · P punch-sync · R re-choose · L load file · [ ] offset"));
}

// src/mic-meter.tsx
function MicMeter(props) {
  const React = Spicetify.React;
  const { useEffect, useRef, useCallback } = React;
  const {
    getLevel,
    sensitivity,
    onSensitivity,
    label,
    width = "100%",
    height = 16,
    color = ACCENT,
    labelSize = 12,
    labelColor = "rgba(255,255,255,0.6)"
  } = props;
  const raf = useRef(0);
  const fillRef = useRef(null);
  const gateFrac = rmsToMeter(sensitivityToThreshold(sensitivity));
  useEffect(() => {
    const tick = () => {
      const el = fillRef.current;
      if (el) {
        const lv = rmsToMeter(getLevel());
        el.style.width = `${lv * 100}%`;
        el.style.background = lv >= gateFrac ? color : "rgba(255,255,255,0.22)";
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [getLevel, gateFrac, color]);
  const trackRef = useRef(null);
  const dragging = useRef(false);
  const setFromClientX = useCallback((clientX) => {
    const el = trackRef.current;
    if (!el || !onSensitivity)
      return;
    const r = el.getBoundingClientRect();
    const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
    onSensitivity(Math.round(thresholdToSensitivity(meterToRms(frac))));
  }, [onSensitivity]);
  const onDown = (e) => {
    if (!onSensitivity)
      return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onMove = (e) => {
    if (dragging.current)
      setFromClientX(e.clientX);
  };
  const onUp = (e) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: Math.max(3, labelSize / 4),
      width,
      minWidth: 0
    }
  }, label != null && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: labelSize,
      fontWeight: 700,
      color: labelColor,
      lineHeight: 1.1,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, label), /* @__PURE__ */ Spicetify.React.createElement("div", {
    ref: trackRef,
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    style: {
      position: "relative",
      height,
      borderRadius: height / 2,
      background: "rgba(255,255,255,0.08)",
      cursor: onSensitivity ? "ew-resize" : "default",
      overflow: "hidden",
      touchAction: "none"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    ref: fillRef,
    style: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: "0%",
      background: "rgba(255,255,255,0.22)",
      transition: "width 55ms linear, background 90ms linear"
    }
  }), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      position: "absolute",
      left: `${gateFrac * 100}%`,
      top: 0,
      bottom: 0,
      width: 3,
      marginLeft: -1.5,
      background: "#fff",
      boxShadow: "0 0 5px rgba(0,0,0,0.7)",
      pointerEvents: "none"
    }
  })));
}

// src/session-view.tsx
function stars(n) {
  return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
}
function SessionSetup(props) {
  const React = Spicetify.React;
  const {
    playlists,
    loadingPlaylists,
    onStartPlaylist,
    current,
    rounds,
    onRounds,
    difficulty,
    onDifficulty,
    onStart,
    onCancel,
    micOn,
    players,
    onName,
    onDevice,
    onGain,
    onAddPlayer,
    onRemovePlayer,
    devices,
    levelFor,
    onSensitivity
  } = props;
  const MAX_PLAYERS = 4;
  const chip = (n) => ({
    padding: "8px 16px",
    borderRadius: 12,
    fontSize: 20,
    fontWeight: 800,
    cursor: "pointer",
    border: `1px solid ${rounds === n ? ACCENT : "rgba(255,255,255,0.12)"}`,
    background: rounds === n ? `${ACCENT}22` : "rgba(255,255,255,0.04)",
    color: rounds === n ? ACCENT : "#fff"
  });
  const sectionLabel = {
    alignSelf: "flex-start",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.45)"
  };
  return /* @__PURE__ */ Spicetify.React.createElement(Center, {
    zoom: 1.5
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 34, fontWeight: 800 }
  }, "New Session"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: 15,
      color: micOn ? ACCENT : "#ff9e6b",
      fontWeight: 600
    }
  }, micOn ? "\uD83C\uDFA4 Mic on — you'll be scored" : "\uD83C\uDFA4 Mic is off — starting turns it on"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 12,
      width: "min(560px, 84vw)",
      marginTop: 10
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: sectionLabel
  }, "Players", " ", players.length > 1 && /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { color: ACCENT }
  }, "· versus — everyone sings at once")), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", flexDirection: "column", gap: 8 }
  }, players.map((p, i) => /* @__PURE__ */ Spicetify.React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      padding: "10px 12px",
      borderRadius: 10,
      background: "rgba(255,255,255,0.05)",
      border: "1px solid rgba(255,255,255,0.1)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 10 }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      fontWeight: 800,
      fontSize: 16
    }
  }, "●"), /* @__PURE__ */ Spicetify.React.createElement("input", {
    value: p.name,
    onChange: (e) => onName(i, e.target.value),
    maxLength: 16,
    style: {
      width: 96,
      background: "transparent",
      border: "none",
      borderBottom: "1px solid rgba(255,255,255,0.15)",
      color: "#fff",
      fontSize: 15,
      fontWeight: 600,
      outline: "none"
    }
  }), /* @__PURE__ */ Spicetify.React.createElement("select", {
    value: p.deviceId ?? "",
    onChange: (e) => onDevice(i, e.target.value || undefined),
    style: {
      flex: "1 1 auto",
      minWidth: 0,
      background: "rgba(0,0,0,0.3)",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 8,
      color: "#fff",
      fontSize: 13,
      padding: "5px 8px"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("option", {
    value: ""
  }, "Default mic"), devices.map((d) => /* @__PURE__ */ Spicetify.React.createElement("option", {
    key: d.deviceId,
    value: d.deviceId
  }, d.label))), players.length > 1 && /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: () => onRemovePlayer(i),
    title: "Remove",
    style: {
      border: "none",
      background: "transparent",
      color: "rgba(255,255,255,0.5)",
      cursor: "pointer",
      fontSize: 18,
      lineHeight: 1,
      padding: "0 2px",
      flexShrink: 0
    }
  }, "×")), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 12 }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { flex: "1 1 auto", minWidth: 0 }
  }, /* @__PURE__ */ Spicetify.React.createElement(MicMeter, {
    getLevel: () => levelFor(i),
    sensitivity: p.sensitivity,
    onSensitivity: (n) => onSensitivity(i, n),
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    height: 14
  })), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
    title: "Input gain — where this mic's level sits on the meter"
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 12, color: "rgba(255,255,255,0.4)" }
  }, "gain"), /* @__PURE__ */ Spicetify.React.createElement("input", {
    type: "range",
    min: 25,
    max: 300,
    value: Math.round(p.gain * 100),
    onChange: (e) => onGain(i, Number(e.target.value) / 100),
    style: { width: 84 }
  }), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      fontSize: 12,
      color: "rgba(255,255,255,0.55)",
      width: 36,
      textAlign: "right",
      fontVariantNumeric: "tabular-nums"
    }
  }, Math.round(p.gain * 100), "%"))))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 10 }
  }, players.length < MAX_PLAYERS && /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onAddPlayer,
    style: {
      padding: "8px 12px",
      borderRadius: 10,
      border: "1px dashed rgba(255,255,255,0.2)",
      background: "transparent",
      color: "rgba(255,255,255,0.7)",
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700
    }
  }, "+ Add singer"), devices.length === 0 && /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 12, color: "rgba(255,255,255,0.4)" }
  }, "Grant mic access to see device names."))), current && /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: () => onStartPlaylist(current),
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 2,
      padding: "12px 16px",
      borderRadius: 12,
      border: `1px solid ${ACCENT}66`,
      background: `${ACCENT}14`,
      color: "#fff",
      cursor: "pointer",
      textAlign: "left"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: ACCENT }
  }, "▶ Continue what you're playing"), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 18, fontWeight: 800 }
  }, current.name)), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: sectionLabel
  }, "Sing a playlist"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      maxHeight: 320,
      overflowY: "auto",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(255,255,255,0.03)",
      padding: 6
    }
  }, loadingPlaylists ? /* @__PURE__ */ Spicetify.React.createElement(PlaceholderRow, {
    text: "Loading your playlists…"
  }) : playlists.length === 0 ? /* @__PURE__ */ Spicetify.React.createElement(PlaceholderRow, {
    text: "No playlists found — use free play below."
  }) : playlists.map((p) => /* @__PURE__ */ Spicetify.React.createElement("button", {
    key: p.uri,
    onClick: () => onStartPlaylist(p),
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "10px 14px",
      borderRadius: 10,
      border: "1px solid transparent",
      background: "rgba(255,255,255,0.04)",
      color: "#fff",
      cursor: "pointer",
      textAlign: "left"
    },
    onMouseEnter: (e) => {
      e.currentTarget.style.borderColor = `${ACCENT}66`;
      e.currentTarget.style.background = `${ACCENT}14`;
    },
    onMouseLeave: (e) => {
      e.currentTarget.style.borderColor = "transparent";
      e.currentTarget.style.background = "rgba(255,255,255,0.04)";
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 17, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
  }, p.name), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 14, color: "rgba(255,255,255,0.5)", flexShrink: 0 }
  }, p.count != null ? `${p.count} songs · ▶` : "▶")))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { ...sectionLabel, marginTop: 8 }
  }, "Difficulty"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 10 }
  }, ["easy", "medium", "hard"].map((d) => {
    const on = difficulty === d;
    return /* @__PURE__ */ Spicetify.React.createElement("button", {
      key: d,
      onClick: () => onDifficulty(d),
      title: d === "easy" ? "±2 semitones — forgiving" : d === "medium" ? "±1 semitone" : "±0 — exact pitch (rap/spoken notes are never pitch-scored)",
      style: {
        padding: "8px 16px",
        borderRadius: 12,
        fontSize: 20,
        fontWeight: 800,
        textTransform: "capitalize",
        cursor: "pointer",
        border: `1px solid ${on ? ACCENT : "rgba(255,255,255,0.12)"}`,
        background: on ? `${ACCENT}22` : "rgba(255,255,255,0.04)",
        color: on ? ACCENT : "#fff"
      }
    }, d);
  })), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { ...sectionLabel, marginTop: 8 }
  }, "Or free play"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: 10 }
  }, [3, 5, 10].map((n) => /* @__PURE__ */ Spicetify.React.createElement("button", {
    key: n,
    style: chip(n),
    onClick: () => onRounds(n)
  }, n)), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: { ...primaryBtn(), marginLeft: "auto" },
    onClick: onStart
  }, "▶ ", rounds, " rounds"))), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: { ...ghostBtn(), marginTop: 16 },
    onClick: onCancel
  }, "Cancel"));
}
function PlaceholderRow(props) {
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { padding: "16px 14px", fontSize: 15, color: "rgba(255,255,255,0.5)", textAlign: "center" }
  }, props.text);
}
var BAR_W = 600;
var BAR_LABEL = 48;
function MicOverlay(props) {
  const React = Spicetify.React;
  const {
    mics,
    devices,
    outputs,
    routingSupported,
    onGain,
    onSensitivity,
    onDevice,
    onMonitor,
    onMonitorGain,
    onOutput
  } = props;
  const selectStyle = {
    width: "100%",
    minWidth: 0,
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: "#fff",
    fontSize: 18,
    padding: "6px 9px"
  };
  const n = Math.max(1, mics.length);
  const wanted = n * BAR_W + (n - 1) * BAR_LABEL + 56;
  const readout = {
    fontSize: 18,
    fontWeight: 700,
    color: "rgba(255,255,255,0.45)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap"
  };
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      justifySelf: "end",
      width: `min(100%, ${wanted}px)`,
      padding: "12px 20px",
      borderRadius: 16,
      background: "rgba(8,8,12,0.72)",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "#fff",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: BAR_LABEL, alignItems: "flex-start", width: "100%" }
  }, mics.map((m, i) => {
    const tint = PLAYER_COLORS[i % PLAYER_COLORS.length];
    return /* @__PURE__ */ Spicetify.React.createElement("div", {
      key: i,
      style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }
    }, /* @__PURE__ */ Spicetify.React.createElement(MicMeter, {
      getLevel: m.getLevel,
      sensitivity: m.sensitivity,
      onSensitivity: (n2) => onSensitivity(i, n2),
      label: mics.length > 1 ? m.name : "\uD83C\uDFA4",
      labelColor: tint,
      color: tint,
      height: 44,
      labelSize: 32
    }), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { display: "flex", alignItems: "center", gap: 12 }
    }, /* @__PURE__ */ Spicetify.React.createElement("span", {
      style: readout
    }, "gate ", Math.round(m.sensitivity), "%"), /* @__PURE__ */ Spicetify.React.createElement("span", {
      style: { ...readout, marginLeft: "auto" }
    }, "gain ", Math.round(m.gain * 100), "%")), /* @__PURE__ */ Spicetify.React.createElement("input", {
      type: "range",
      min: 25,
      max: 300,
      value: Math.round(m.gain * 100),
      onChange: (e) => onGain(i, Number(e.target.value) / 100),
      title: "Input gain",
      style: { width: "100%" }
    }), /* @__PURE__ */ Spicetify.React.createElement("select", {
      value: m.deviceId ?? "",
      onChange: (e) => onDevice(i, e.target.value || undefined),
      title: "Input device — switching restarts this mic only",
      style: selectStyle
    }, /* @__PURE__ */ Spicetify.React.createElement("option", {
      value: ""
    }, "Default mic"), devices.map((d) => /* @__PURE__ */ Spicetify.React.createElement("option", {
      key: d.deviceId,
      value: d.deviceId
    }, d.label))), (() => {
      const on = !!m.monitor;
      const vol = Math.round((m.monitorGain ?? 0.05) * 100);
      return /* @__PURE__ */ Spicetify.React.createElement("div", {
        style: { display: "flex", flexDirection: "column", gap: 10 }
      }, /* @__PURE__ */ Spicetify.React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: 12 }
      }, /* @__PURE__ */ Spicetify.React.createElement("button", {
        onClick: () => onMonitor(i, !on),
        title: "Play this mic back out an output device (use headphones to avoid feedback)",
        style: {
          fontSize: 18,
          fontWeight: 700,
          padding: "6px 10px",
          borderRadius: 8,
          cursor: "pointer",
          border: `1px solid ${on ? tint : "rgba(255,255,255,0.14)"}`,
          background: on ? `${tint}22` : "rgba(0,0,0,0.35)",
          color: on ? tint : "#fff",
          whiteSpace: "nowrap"
        }
      }, on ? "\uD83D\uDD0A Monitor" : "\uD83D\uDD07 Monitor"), /* @__PURE__ */ Spicetify.React.createElement("span", {
        style: { ...readout, marginLeft: "auto" }
      }, vol, "%")), /* @__PURE__ */ Spicetify.React.createElement("input", {
        type: "range",
        min: 0,
        max: 100,
        value: vol,
        disabled: !on,
        onChange: (e) => onMonitorGain(i, Number(e.target.value) / 100),
        title: "Monitor volume",
        style: { width: "100%", opacity: on ? 1 : 0.4 }
      }), routingSupported && /* @__PURE__ */ Spicetify.React.createElement("select", {
        value: m.outputDeviceId ?? "",
        disabled: !on,
        onChange: (e) => onOutput(i, e.target.value || undefined),
        title: "Monitor output device",
        style: { ...selectStyle, opacity: on ? 1 : 0.4 }
      }, /* @__PURE__ */ Spicetify.React.createElement("option", {
        value: ""
      }, "Default output"), outputs.map((d) => /* @__PURE__ */ Spicetify.React.createElement("option", {
        key: d.deviceId,
        value: d.deviceId
      }, d.label))));
    })());
  })));
}
function NowPlaying(props) {
  const React = Spicetify.React;
  const clip = {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  };
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      maxWidth: "100%",
      minWidth: 0,
      padding: "18px 34px",
      borderRadius: 22,
      background: "rgba(8,8,12,0.72)",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "#fff",
      textAlign: "center",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { ...clip, fontSize: 64, fontWeight: 800, lineHeight: 1.05 }
  }, props.title), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { ...clip, fontSize: 40, fontWeight: 600, color: "rgba(255,255,255,0.55)" }
  }, props.artist));
}
function CompetitiveSetup(props) {
  const React = Spicetify.React;
  const {
    players,
    difficulty,
    devices,
    deviceId,
    track,
    onName,
    onAdd,
    onRemove,
    onDifficulty,
    onDevice,
    onStart,
    onCancel
  } = props;
  const field = {
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 10,
    color: "#fff",
    fontSize: 20,
    padding: "8px 12px"
  };
  const chip = (on) => ({
    ...field,
    cursor: "pointer",
    textTransform: "capitalize",
    fontWeight: 700,
    color: on ? "#08210f" : "#fff",
    background: on ? ACCENT : "rgba(0,0,0,0.35)",
    borderColor: on ? ACCENT : "rgba(255,255,255,0.14)"
  });
  return /* @__PURE__ */ Spicetify.React.createElement(Center, {
    zoom: 1.4,
    gap: 18
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 40, fontWeight: 900 }
  }, "⚔ Competitive"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 17, color: "rgba(255,255,255,0.6)", textAlign: "center", maxWidth: 520 }
  }, "One mic, one song — each singer takes the same track solo, then scores go head-to-head. Pure skill."), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { ...field, width: 460, textAlign: "center", fontWeight: 600, color: track ? "#fff" : GOLD }
  }, track ? `${track.title} — ${track.artist}` : "▶ Play a song first, then start the duel"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", flexDirection: "column", gap: 8, width: 460 }
  }, players.map((name, i) => /* @__PURE__ */ Spicetify.React.createElement("div", {
    key: i,
    style: { display: "flex", gap: 8, alignItems: "center" }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { color: PLAYER_COLORS[i % PLAYER_COLORS.length], fontWeight: 800, width: 22 }
  }, i + 1), /* @__PURE__ */ Spicetify.React.createElement("input", {
    value: name,
    placeholder: `P${i + 1}`,
    onChange: (e) => onName(i, e.target.value),
    style: { ...field, flex: 1, minWidth: 0 }
  }), players.length > 2 && /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: () => onRemove(i),
    title: "Remove",
    style: { ...ghostBtn(), padding: "6px 12px" }
  }, "✕"))), players.length < 4 && /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onAdd,
    style: { ...ghostBtn(), alignSelf: "flex-start" }
  }, "+ Add singer")), /* @__PURE__ */ Spicetify.React.createElement("select", {
    value: deviceId ?? "",
    onChange: (e) => onDevice(e.target.value || undefined),
    title: "Shared mic — everyone sings on this one",
    style: { ...field, width: 460 }
  }, /* @__PURE__ */ Spicetify.React.createElement("option", {
    value: ""
  }, "Default mic"), devices.map((d) => /* @__PURE__ */ Spicetify.React.createElement("option", {
    key: d.deviceId,
    value: d.deviceId
  }, d.label))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: 8 }
  }, ["easy", "medium", "hard"].map((d) => /* @__PURE__ */ Spicetify.React.createElement("button", {
    key: d,
    onClick: () => onDifficulty(d),
    style: chip(difficulty === d)
  }, d))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: 12, marginTop: 4 }
  }, /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onStart,
    disabled: !track,
    style: { ...primaryBtn(), opacity: track ? 1 : 0.45, cursor: track ? "pointer" : "default" }
  }, "⚔ Start duel"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onCancel,
    style: ghostBtn()
  }, "Cancel")));
}
function SessionHud(props) {
  const React = Spicetify.React;
  const {
    round,
    target,
    totals,
    micsOn,
    onSkip,
    onEnd,
    onResetScores,
    onRestartSong,
    autoSkip,
    onAutoSkip,
    sourceName
  } = props;
  const k = totals.length > 2 ? 0.62 : 1;
  const px = (n) => Math.round(n * k);
  const btn = {
    padding: `${px(16)}px ${px(40)}px`,
    borderRadius: px(26),
    fontSize: px(52),
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.4)",
    color: "#fff"
  };
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      justifySelf: "start",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: px(18),
      padding: `${px(24)}px ${px(34)}px`,
      borderRadius: px(34),
      background: "rgba(8,8,12,0.72)",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "#fff",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "center", gap: px(28) }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", flexDirection: "column", lineHeight: 1.1 }
  }, sourceName && /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      fontSize: px(40),
      fontWeight: 700,
      letterSpacing: 0.5,
      color: "rgba(255,255,255,0.5)",
      maxWidth: 620,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, sourceName), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: px(72), fontWeight: 800 }
  }, "Round ", /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { color: ACCENT }
  }, round), "/", target)), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", flexDirection: "column", lineHeight: 1.05 }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: {
      fontSize: px(40),
      fontWeight: 700,
      letterSpacing: 0.5,
      color: "rgba(255,255,255,0.5)"
    }
  }, "total"), totals.map((t, i) => {
    const tint = PLAYER_COLORS[i % PLAYER_COLORS.length];
    return /* @__PURE__ */ Spicetify.React.createElement("div", {
      key: i,
      style: { display: "flex", alignItems: "baseline", gap: px(14) }
    }, totals.length > 1 && /* @__PURE__ */ Spicetify.React.createElement("span", {
      style: { fontSize: px(40), fontWeight: 800, color: tint }
    }, t.name), /* @__PURE__ */ Spicetify.React.createElement("span", {
      style: {
        fontSize: px(72),
        fontWeight: 800,
        fontVariantNumeric: "tabular-nums",
        color: totals.length > 1 ? tint : "#fff"
      }
    }, t.total.toLocaleString()));
  })), !micsOn && /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: px(52), fontWeight: 700, color: "rgba(255,255,255,0.4)" }
  }, "\uD83C\uDFA4 off")), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: px(18), flexWrap: "wrap" }
  }, /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: btn,
    onClick: onSkip
  }, "Skip"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: btn,
    onClick: onEnd
  }, "End"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: btn,
    onClick: onRestartSong,
    title: "Play this song from the top"
  }, "⟲ Restart"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: btn,
    onClick: onResetScores,
    title: "Clear every singer's score and keep playing"
  }, "↺ Scores"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: {
      ...btn,
      borderColor: autoSkip ? ACCENT : "rgba(255,255,255,0.14)",
      background: autoSkip ? `${ACCENT}1f` : "rgba(0,0,0,0.4)",
      color: autoSkip ? ACCENT : "#fff"
    },
    onClick: () => onAutoSkip(!autoSkip),
    title: "Skip tracks with no karaoke chart automatically, instead of stopping on them"
  }, autoSkip ? "☑" : "☐", " Auto-skip")));
}
function NoChartInSession(props) {
  const React = Spicetify.React;
  const { title, artist, onSkip, onReChoose, searched, helperDown } = props;
  if (helperDown) {
    return /* @__PURE__ */ Spicetify.React.createElement(HelperDownNotice, {
      title,
      artist,
      onSkip,
      onReChoose
    });
  }
  return /* @__PURE__ */ Spicetify.React.createElement(Center, {
    zoom: 3
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 40 }
  }, "\uD83C\uDFA4"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 26, fontWeight: 800 }
  }, searched ? "No karaoke chart for this track" : "Looking for a chart…"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 17, color: "rgba(255,255,255,0.6)" }
  }, artist, " — ", title), searched && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: 12, marginTop: 18 }
  }, /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: primaryBtn(),
    onClick: onSkip
  }, "⏭ Skip to next song"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: ghostBtn(),
    onClick: onReChoose
  }, "\uD83D\uDD0E Re-choose (R)")));
}
function HelperDownNotice(props) {
  const React = Spicetify.React;
  const { title, artist, onSkip, onReChoose } = props;
  return /* @__PURE__ */ Spicetify.React.createElement(Center, {
    zoom: 2.4
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 48 }
  }, "⚠️"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 26, fontWeight: 800, color: GOLD }
  }, "Karaoke helper isn't running"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: 17,
      color: "rgba(255,255,255,0.7)",
      maxWidth: 560,
      textAlign: "center",
      lineHeight: 1.45
    }
  }, "Charts load through the local helper — even songs you've already sung and cached. Start it in a terminal, then it'll pick this track up:"), /* @__PURE__ */ Spicetify.React.createElement("code", {
    style: {
      marginTop: 4,
      padding: "8px 16px",
      borderRadius: 10,
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.12)",
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      fontSize: 18,
      color: "#fff"
    }
  }, "bun run helper"), (title || artist) && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 15, color: "rgba(255,255,255,0.5)", marginTop: 4 }
  }, [artist, title].filter(Boolean).join(" — ")), (onSkip || onReChoose) && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: 12, marginTop: 18 }
  }, onReChoose && /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: primaryBtn(),
    onClick: onReChoose
  }, "↻ Try again (R)"), onSkip && /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: ghostBtn(),
    onClick: onSkip
  }, "⏭ Skip to next song")));
}
function RoundEnd(props) {
  const React = Spicetify.React;
  const { justFinished, roundNumber, target, sessionTotal, onContinue, upNext } = props;
  const scores = justFinished.scores;
  const versus = scores.length > 1;
  const ranked = [...scores].sort((a, b) => b.total - a.total);
  const solo = scores[0];
  const last = roundNumber >= target;
  return /* @__PURE__ */ Spicetify.React.createElement(Center, {
    zoom: 2
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 22, color: "rgba(255,255,255,0.6)", fontWeight: 700 }
  }, "Round ", roundNumber, " of ", target, " done"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 30, fontWeight: 800 }
  }, justFinished.title), versus ? /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      flexWrap: "wrap",
      justifyContent: "center",
      marginTop: 4
    }
  }, ranked.map((s, i) => /* @__PURE__ */ Spicetify.React.createElement("div", {
    key: s.player,
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 2,
      minWidth: 128,
      padding: "12px 16px",
      borderRadius: 12,
      border: `1px solid ${i === 0 ? GOLD : "rgba(255,255,255,0.1)"}`,
      background: i === 0 ? `${GOLD}14` : "rgba(255,255,255,0.03)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.7)" }
  }, i === 0 ? "\uD83D\uDC51 " : "", s.player), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      fontSize: 40,
      fontWeight: 800,
      color: i === 0 ? GOLD : ACCENT,
      fontVariantNumeric: "tabular-nums"
    }
  }, s.total.toLocaleString()), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 15, color: GOLD }
  }, stars(s.grade.stars))))) : /* @__PURE__ */ Spicetify.React.createElement(Spicetify.React.Fragment, null, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 22, color: GOLD }
  }, stars(solo.grade.stars)), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 56, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums" }
  }, solo.total.toLocaleString())), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 16, color: "rgba(255,255,255,0.6)", marginTop: versus ? 4 : 0 }
  }, "Session total ", sessionTotal.toLocaleString()), !last && upNext && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 15, color: "rgba(255,255,255,0.5)", marginTop: 4 }
  }, "Up next:", " ", /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { color: "#fff", fontWeight: 600 }
  }, upNext.artist, " — ", upNext.title)), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: { ...primaryBtn(), marginTop: 16 },
    onClick: onContinue
  }, last ? "See the results ▶" : upNext ? "Next song ▶" : "Next — play another song ▶"));
}
function SessionResultScreen(props) {
  const React = Spicetify.React;
  const { summary, onDone, onSave } = props;
  const multiplayer = summary.players.length > 1;
  const headline = summary.players[0];
  const ranked = [...summary.players].sort((a, b) => b.total - a.total);
  const cell = { padding: "8px 12px", fontSize: 17 };
  const head = {
    ...cell,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.45)",
    fontWeight: 700
  };
  return /* @__PURE__ */ Spicetify.React.createElement(Center, null, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 22, color: "rgba(255,255,255,0.6)", fontWeight: 700 }
  }, "Session complete"), multiplayer ? /* @__PURE__ */ Spicetify.React.createElement(Spicetify.React.Fragment, null, summary.winner && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 30, fontWeight: 800, color: GOLD }
  }, "\uD83D\uDC51 ", summary.winner, " wins"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }
  }, ranked.map((pl, i) => {
    const win = pl.player === summary.winner;
    return /* @__PURE__ */ Spicetify.React.createElement("div", {
      key: pl.player,
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        minWidth: 140,
        padding: "14px 18px",
        borderRadius: 14,
        border: `1px solid ${win ? GOLD : "rgba(255,255,255,0.1)"}`,
        background: win ? `${GOLD}14` : "rgba(255,255,255,0.03)"
      }
    }, /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.6)" }
    }, i === 0 ? "①" : i === 1 ? "②" : i === 2 ? "③" : `#${i + 1}`, " ", pl.player), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { fontSize: 34, fontWeight: 800, color: win ? GOLD : ACCENT, fontVariantNumeric: "tabular-nums" }
    }, pl.total.toLocaleString()), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { fontSize: 15, color: GOLD }
    }, stars(pl.grade.stars)), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { fontSize: 12, color: "rgba(255,255,255,0.4)" }
    }, pl.roundsSung, " ", pl.roundsSung === 1 ? "song" : "songs", " · avg", " ", pl.avg.toLocaleString()));
  }))) : /* @__PURE__ */ Spicetify.React.createElement(Spicetify.React.Fragment, null, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 84, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums", lineHeight: 1 }
  }, headline.total.toLocaleString()), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 26, color: GOLD, fontWeight: 800 }
  }, stars(headline.grade.stars), " ", headline.grade.name)), /* @__PURE__ */ Spicetify.React.createElement("table", {
    style: {
      marginTop: 18,
      borderCollapse: "collapse",
      background: "rgba(255,255,255,0.03)",
      borderRadius: 12,
      overflow: "hidden"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("thead", null, /* @__PURE__ */ Spicetify.React.createElement("tr", null, /* @__PURE__ */ Spicetify.React.createElement("th", {
    style: head
  }, "#"), /* @__PURE__ */ Spicetify.React.createElement("th", {
    style: { ...head, textAlign: "left" }
  }, "Song"), multiplayer ? summary.players.map((p) => /* @__PURE__ */ Spicetify.React.createElement("th", {
    key: p.player,
    style: { ...head, textAlign: "right" }
  }, p.player)) : /* @__PURE__ */ Spicetify.React.createElement(Spicetify.React.Fragment, null, /* @__PURE__ */ Spicetify.React.createElement("th", {
    style: head
  }, "Grade"), /* @__PURE__ */ Spicetify.React.createElement("th", {
    style: { ...head, textAlign: "right" }
  }, "Score")))), /* @__PURE__ */ Spicetify.React.createElement("tbody", null, summary.rounds.map((r, i) => {
    const best = i === summary.bestRound?.index;
    const roundWinner = [...r.scores].sort((a, b) => b.total - a.total)[0]?.player;
    return /* @__PURE__ */ Spicetify.React.createElement("tr", {
      key: i,
      style: { background: best ? `${GOLD}18` : "transparent" }
    }, /* @__PURE__ */ Spicetify.React.createElement("td", {
      style: { ...cell, color: "rgba(255,255,255,0.5)" }
    }, i + 1), /* @__PURE__ */ Spicetify.React.createElement("td", {
      style: { ...cell, textAlign: "left", fontWeight: 700 }
    }, r.title, " ", best && /* @__PURE__ */ Spicetify.React.createElement("span", {
      style: { color: GOLD }
    }, "★ best")), multiplayer ? summary.players.map((p) => {
      const sc = r.scores.find((x) => x.player === p.player);
      const win = !!sc && p.player === roundWinner && r.scores.length > 1;
      return /* @__PURE__ */ Spicetify.React.createElement("td", {
        key: p.player,
        style: {
          ...cell,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          color: win ? GOLD : "#fff",
          fontWeight: win ? 800 : 500
        }
      }, sc ? sc.total.toLocaleString() : "—");
    }) : /* @__PURE__ */ Spicetify.React.createElement(Spicetify.React.Fragment, null, /* @__PURE__ */ Spicetify.React.createElement("td", {
      style: { ...cell, color: GOLD }
    }, stars(r.scores[0].grade.stars)), /* @__PURE__ */ Spicetify.React.createElement("td", {
      style: { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }
    }, r.scores[0].total.toLocaleString())));
  }))), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", gap: 12, marginTop: 20 }
  }, onSave && /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: ghostBtn(),
    onClick: onSave
  }, "\uD83D\uDCBE Save as playlist"), /* @__PURE__ */ Spicetify.React.createElement("button", {
    style: primaryBtn(),
    onClick: onDone
  }, "Done")));
}
function Center(props) {
  const React = Spicetify.React;
  const zoom = props.zoom ?? 1;
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: props.gap ?? 10,
      zoom: zoom === 1 ? undefined : zoom,
      height: "100%",
      overflowY: "auto",
      color: "#fff",
      textAlign: "center",
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, props.children);
}
function primaryBtn() {
  return {
    padding: "12px 22px",
    borderRadius: 12,
    fontSize: 18,
    fontWeight: 800,
    cursor: "pointer",
    border: "none",
    background: ACCENT,
    color: "#04160b"
  };
}
function ghostBtn() {
  return {
    padding: "12px 22px",
    borderRadius: 12,
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "transparent",
    color: "#fff"
  };
}

// src/session.ts
var DEFAULT_PLAYER = "P1";
function createSession(targetRounds, players = [DEFAULT_PLAYER]) {
  return {
    targetRounds: Math.max(1, Math.round(targetRounds)),
    players: players.length ? players : [DEFAULT_PLAYER],
    rounds: [],
    playlist: null,
    playlistName: null
  };
}
function createSessionFromPlaylist(name, tracks, players = [DEFAULT_PLAYER]) {
  return {
    targetRounds: Math.max(1, tracks.length),
    players: players.length ? players : [DEFAULT_PLAYER],
    rounds: [],
    playlist: tracks.slice(),
    playlistName: name
  };
}
function upNext(s) {
  if (!s.playlist)
    return null;
  return s.playlist[s.rounds.length] ?? null;
}
function playerScoreFrom(player, score) {
  return {
    player,
    total: score.total,
    grade: gradeForScore(score.total),
    notesSung: score.notesSung,
    notesTotal: score.notesTotal
  };
}
function roundFromScores(title, artist, entries) {
  return {
    title,
    artist,
    scores: entries.map((e) => playerScoreFrom(e.player, e.score))
  };
}
function recordRound(s, r) {
  return { ...s, rounds: [...s.rounds, r] };
}
function isComplete(s) {
  return s.rounds.length >= s.targetRounds;
}
function summarize(s) {
  const players = s.players.map((player) => {
    const mine = s.rounds.filter((r) => r.scores.some((x) => x.player === player));
    const total = mine.reduce((sum, r) => sum + (r.scores.find((x) => x.player === player)?.total ?? 0), 0);
    const avg = mine.length ? Math.round(total / mine.length) : 0;
    return { player, total, avg, grade: gradeForScore(avg), roundsSung: mine.length };
  });
  let bestRound = null;
  s.rounds.forEach((r, index) => {
    for (const sc of r.scores) {
      if (!bestRound || sc.total > bestRound.total) {
        bestRound = { title: r.title, player: sc.player, total: sc.total, index };
      }
    }
  });
  const winner = s.rounds.length > 0 && players.length > 0 ? players.reduce((best, p) => p.total > best.total ? p : best).player : null;
  return { players, rounds: s.rounds, bestRound, winner };
}

// src/playlist-source.ts
function isPlaylistUri(uri) {
  return typeof uri === "string" && /^spotify:(?:user:[^:]+:)?playlist:/.test(uri);
}
function toPlaylistRef(item) {
  if (!item || typeof item !== "object")
    return null;
  const o = item;
  const uri = o.uri;
  if (!isPlaylistUri(uri))
    return null;
  const name = typeof o.name === "string" && o.name || typeof o.metadata?.name === "string" && o.metadata.name || "Untitled playlist";
  const rawCount = o.totalLength ?? o.length ?? o.metadata?.total_length ?? o.metadata?.length;
  const count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;
  return { uri, name, count };
}
function toSessionTrack(item) {
  if (!item || typeof item !== "object")
    return null;
  const o = item;
  const t = o.track && typeof o.track === "object" ? o.track : o;
  const uri = t.uri;
  if (typeof uri !== "string" || !uri.startsWith("spotify:track:"))
    return null;
  const title = typeof t.name === "string" && t.name || "";
  let artist = "";
  if (Array.isArray(t.artists)) {
    artist = t.artists.map((a) => typeof a === "string" ? a : a?.name).filter(Boolean).join(", ");
  } else if (typeof t.artists === "string") {
    artist = t.artists;
  } else if (typeof t.artistName === "string") {
    artist = t.artistName;
  }
  return { uri, title, artist };
}
function contextToPlaylistRef(ctx) {
  if (!ctx || typeof ctx !== "object")
    return null;
  const o = ctx;
  const uri = o.uri ?? o.contextUri;
  if (!isPlaylistUri(uri))
    return null;
  const name = typeof o.name === "string" && o.name || typeof o.metadata?.context_description === "string" && o.metadata.context_description || typeof o.metadata?.name === "string" && o.metadata.name || "Current playlist";
  return { uri, name, count: null };
}
function flattenRootlist(root) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object")
      return;
    const o = node;
    const ref = toPlaylistRef(o);
    if (ref)
      out.push(ref);
    const kids = o.items ?? o.rows;
    if (Array.isArray(kids))
      for (const k of kids)
        visit(k);
  };
  const items = root?.items ?? root?.rows ?? root;
  if (Array.isArray(items))
    for (const it of items)
      visit(it);
  return out;
}
function platform() {
  const p = Spicetify.Platform;
  return p ?? null;
}
async function fetchPlaylists() {
  const api = platform()?.RootlistAPI;
  if (!api?.getContents)
    return [];
  try {
    const root = await api.getContents({ limit: 1000 });
    return flattenRootlist(root);
  } catch (err) {
    console.error("[singify] fetchPlaylists failed:", err);
    return [];
  }
}
function currentContextPlaylist() {
  try {
    const data = Spicetify.Player?.data;
    if (!data)
      return null;
    const ctx = data.context ?? { uri: data.contextUri, metadata: data.contextMetadata };
    return contextToPlaylistRef(ctx);
  } catch (err) {
    console.error("[singify] currentContextPlaylist failed:", err);
    return null;
  }
}
async function fetchPlaylistTracks(uri) {
  const api = platform()?.PlaylistAPI;
  if (!api?.getContents)
    return [];
  try {
    const res = await api.getContents(uri);
    const items = res?.items ?? res?.rows ?? [];
    return (Array.isArray(items) ? items : []).map(toSessionTrack).filter((t) => t != null);
  } catch (err) {
    console.error("[singify] fetchPlaylistTracks failed:", err);
    return [];
  }
}
async function playPlaylist(uri) {
  const player = Spicetify.Player;
  if (typeof player.playUri === "function") {
    try {
      player.playUri(uri);
      return true;
    } catch (err) {
      console.error("[singify] playUri failed, trying PlayerAPI:", err);
    }
  }
  const api = platform()?.PlayerAPI;
  if (api?.play) {
    try {
      await api.play({ uri }, {}, {});
      return true;
    } catch (err) {
      console.error("[singify] PlayerAPI.play failed:", err);
    }
  }
  return false;
}

// src/mic.ts
async function startMicPitch(opts = {}) {
  const {
    fftSize = 2048,
    echoCancellation = false,
    noiseSuppression = false,
    autoGainControl = false,
    deviceId,
    gain = 1,
    monitor = false,
    monitorGain = 0.05,
    outputDeviceId,
    ...detectOpts
  } = opts;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...deviceId ? { deviceId: { exact: deviceId } } : {},
      echoCancellation,
      noiseSuppression,
      autoGainControl
    }
  });
  const track = stream.getAudioTracks()[0];
  const s = track?.getSettings() ?? {};
  const applied = {
    autoGainControl: s.autoGainControl,
    noiseSuppression: s.noiseSuppression,
    echoCancellation: s.echoCancellation
  };
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, gain);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  source.connect(gainNode);
  gainNode.connect(analyser);
  let stopped = false;
  let monitorNode = null;
  let monOn = monitor;
  let monLevel = clamp01(monitorGain);
  let outId = outputDeviceId;
  const applyMonitorGain = () => {
    if (monitorNode)
      monitorNode.gain.value = monOn ? monLevel : 0;
  };
  const ensureMonitorChain = () => {
    if (monitorNode || stopped)
      return;
    monitorNode = ctx.createGain();
    applyMonitorGain();
    source.connect(monitorNode);
    monitorNode.connect(ctx.destination);
    routeSink();
  };
  const routeSink = async () => {
    const c = ctx;
    if (typeof c.setSinkId !== "function")
      return;
    try {
      await c.setSinkId(outId ?? "");
    } catch (err) {
      console.error("[singify] monitor setSinkId failed:", err);
    }
  };
  if (monOn)
    ensureMonitorChain();
  const buf = new Float32Array(analyser.fftSize);
  let liveOpts = { ...detectOpts };
  return {
    sampleRate: ctx.sampleRate,
    applied,
    read() {
      if (stopped)
        return null;
      analyser.getFloatTimeDomainData(buf);
      return detectPitch(buf, { sampleRate: ctx.sampleRate, ...liveOpts });
    },
    level() {
      if (stopped)
        return 0;
      analyser.getFloatTimeDomainData(buf);
      return rms(buf);
    },
    setOptions(opts2) {
      liveOpts = { ...liveOpts, ...opts2 };
    },
    setGain(g) {
      gainNode.gain.value = Math.max(0, g);
    },
    setMonitor(on) {
      monOn = on;
      if (on)
        ensureMonitorChain();
      applyMonitorGain();
    },
    setMonitorGain(g) {
      monLevel = clamp01(g);
      applyMonitorGain();
    },
    async setOutputDevice(id) {
      outId = id;
      ensureMonitorChain();
      await routeSink();
    },
    stop() {
      if (stopped)
        return;
      stopped = true;
      source.disconnect();
      gainNode.disconnect();
      if (monitorNode)
        monitorNode.disconnect();
      for (const t of stream.getTracks())
        t.stop();
      ctx.close();
    }
  };
}
function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
function outputRoutingSupported() {
  return typeof AudioContext !== "undefined" && typeof AudioContext.prototype.setSinkId === "function";
}
async function enumerateInputs() {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices)
    return [];
  try {
    const devices = await md.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch (err) {
    console.error("[singify] enumerateInputs failed:", err);
    return [];
  }
}
async function enumerateOutputs() {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices)
    return [];
  try {
    const devices = await md.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
  } catch (err) {
    console.error("[singify] enumerateOutputs failed:", err);
    return [];
  }
}

// src/resolver-client.ts
var HELPER_BASE = globalThis.SINGIFY_HELPER_BASE ?? "http://127.0.0.1:4455";
async function errorMessage(res) {
  try {
    const body = await res.json();
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
async function resolveForTrack(spotifyTrackId, artist, title, force = false) {
  const q = new URLSearchParams({ trackId: spotifyTrackId, artist, title });
  if (force)
    q.set("force", "1");
  const res = await fetch(`${HELPER_BASE}/resolve?${q}`);
  if (!res.ok)
    throw new Error(await errorMessage(res));
  return await res.json();
}
async function confirmPick(spotifyTrackId, candidate) {
  const res = await fetch(`${HELPER_BASE}/pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId: spotifyTrackId, candidate })
  });
  if (!res.ok)
    throw new Error(await errorMessage(res));
  const { song } = await res.json();
  return song;
}
async function loadStore(name) {
  const res = await fetch(`${HELPER_BASE}/store/${encodeURIComponent(name)}`);
  if (!res.ok)
    throw new Error(await errorMessage(res));
  return await res.json();
}
async function saveStore(name, data) {
  const res = await fetch(`${HELPER_BASE}/store/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok)
    throw new Error(await errorMessage(res));
}
async function helperHealth() {
  try {
    const res = await fetch(`${HELPER_BASE}/health`);
    if (!res.ok)
      return null;
    return await res.json();
  } catch {
    return null;
  }
}

// src/storage-keys.ts
var SENS_KEY = "singify:sensitivity";
var SENS_SCALE_KEY = "singify:sensitivityScale";
var DIFFICULTY_KEY = "singify:difficulty";
var NOWLINE_KEY = "singify:nowLinePx";
var MIC_SLOTS_KEY = "singify:micSlots";
var PLAYER_SENS_KEY = "singify:playerSens";
var AUTOSKIP_KEY = "singify:autoSkipNoChart";
var FPS_KEY = "singify:fps";
var DEFAULT_OFFSET_KEY = "singify:offsetMs";
var OFFSET_PREFIX = "singify:offset:";

// src/stats.ts
function songLabel(r) {
  return [r.artist, r.title].filter(Boolean).join(" — ") || r.title || r.artist || "(unknown)";
}
function aggregateByMic(rounds) {
  const by = new Map;
  for (const r of rounds) {
    for (const p of r.players) {
      const key = p.device || "Default mic";
      const e = by.get(key) ?? { sum: 0, n: 0, best: -1 };
      e.sum += p.score;
      e.n += 1;
      if (p.score > e.best) {
        e.best = p.score;
        e.bestSong = songLabel(r);
      }
      by.set(key, e);
    }
  }
  return [...by.entries()].map(([device, e]) => ({
    device,
    rounds: e.n,
    avg: Math.round(e.sum / e.n),
    best: Math.max(0, e.best),
    bestSong: e.bestSong
  })).sort((a, b) => b.avg - a.avg);
}
function aggregateByPlayer(rounds) {
  const by = new Map;
  for (const r of rounds) {
    for (const p of r.players) {
      const e = by.get(p.name) ?? { sum: 0, n: 0, best: -1 };
      e.sum += p.score;
      e.n += 1;
      if (p.score > e.best)
        e.best = p.score;
      by.set(p.name, e);
    }
  }
  return [...by.entries()].map(([name, e]) => ({
    name,
    rounds: e.n,
    avg: Math.round(e.sum / e.n),
    best: Math.max(0, e.best)
  })).sort((a, b) => b.avg - a.avg);
}

// src/stats-view.tsx
var C2 = {
  ...SURFACE,
  row: "#1b1b22",
  green: ACCENT,
  gold: GOLD
};
function fmt(n) {
  return Math.round(n).toLocaleString();
}
function StatsScreen(props) {
  const React = Spicetify.React;
  const { rounds, helperDown, onBack } = props;
  const mics = aggregateByMic(rounds);
  const players = aggregateByPlayer(rounds);
  const recent = [...rounds].sort((a, b) => b.t - a.t).slice(0, 8);
  const backBtn = {
    background: "transparent",
    color: C2.sub,
    border: `1px solid ${C2.border}`,
    borderRadius: 20,
    padding: "8px 18px",
    font: "600 14px system-ui",
    cursor: "pointer"
  };
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      zoom: 1.4,
      height: "100%",
      overflowY: "auto",
      padding: "28px 32px 48px",
      boxSizing: "border-box",
      color: C2.text,
      fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      maxWidth: 820,
      margin: "0 auto 20px"
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", null, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 30, fontWeight: 800 }
  }, "\uD83D\uDCCA Stats"), /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 15, color: C2.sub, marginTop: 2 }
  }, rounds.length, " ", rounds.length === 1 ? "round" : "rounds", " recorded")), /* @__PURE__ */ Spicetify.React.createElement("button", {
    onClick: onBack,
    style: backBtn
  }, "← Back")), helperDown && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      maxWidth: 820,
      margin: "0 auto 16px",
      padding: "14px 18px",
      display: "flex",
      gap: 10,
      alignItems: "baseline",
      fontSize: 15,
      lineHeight: 1.5,
      background: "rgba(230,180,34,0.10)",
      border: "1px solid rgba(230,180,34,0.35)",
      borderRadius: 12
    }
  }, /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { fontSize: 18 }
  }, "⚠️"), /* @__PURE__ */ Spicetify.React.createElement("span", {
    style: { color: C2.text }
  }, "Karaoke helper isn't running — any saved history is on disk but can't be read right now. Start it with", " ", /* @__PURE__ */ Spicetify.React.createElement("code", {
    style: { color: C2.gold, fontFamily: "ui-monospace, monospace" }
  }, "bun run helper"), ", then reopen.")), rounds.length === 0 ? helperDown ? null : /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: {
      maxWidth: 820,
      margin: "0 auto",
      padding: "40px 24px",
      textAlign: "center",
      color: C2.sub,
      fontSize: 16,
      background: C2.card,
      border: `1px solid ${C2.border}`,
      borderRadius: 14,
      lineHeight: 1.5
    }
  }, "No rounds yet. Play a session — each scored song is saved here with the mic and settings it was sung on, so you can see which setup wins.") : /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22 }
  }, /* @__PURE__ */ Spicetify.React.createElement(Section, {
    title: "By microphone",
    hint: "best average first"
  }, /* @__PURE__ */ Spicetify.React.createElement(Table, {
    head: ["Mic", "Rounds", "Avg", "Best"],
    rows: mics.map((m, i) => ({
      lead: i === 0,
      cells: [
        m.device,
        String(m.rounds),
        fmt(m.avg),
        /* @__PURE__ */ Spicetify.React.createElement("span", {
          key: "b"
        }, fmt(m.best), m.bestSong && /* @__PURE__ */ Spicetify.React.createElement("span", {
          style: { color: C2.sub, fontWeight: 400 }
        }, " · ", m.bestSong))
      ]
    }))
  })), /* @__PURE__ */ Spicetify.React.createElement(Section, {
    title: "By singer"
  }, /* @__PURE__ */ Spicetify.React.createElement(Table, {
    head: ["Singer", "Rounds", "Avg", "Best"],
    rows: players.map((p, i) => ({
      lead: i === 0,
      cells: [p.name, String(p.rounds), fmt(p.avg), fmt(p.best)]
    }))
  })), /* @__PURE__ */ Spicetify.React.createElement(Section, {
    title: "Recent"
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", flexDirection: "column", gap: 8 }
  }, recent.map((r, i) => {
    const ranked = [...r.players].sort((a, b) => b.score - a.score);
    const song = [r.artist, r.title].filter(Boolean).join(" — ") || "(unknown)";
    return /* @__PURE__ */ Spicetify.React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 14px",
        background: C2.row,
        border: `1px solid ${C2.border}`,
        borderRadius: 10
      }
    }, /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { minWidth: 0 }
    }, /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: {
        fontWeight: 600,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis"
      }
    }, song), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { fontSize: 13, color: C2.sub, textTransform: "capitalize" }
    }, r.difficulty)), /* @__PURE__ */ Spicetify.React.createElement("div", {
      style: { display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }
    }, ranked.map((p, j) => /* @__PURE__ */ Spicetify.React.createElement("span", {
      key: j,
      style: {
        fontSize: 13,
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: 999,
        color: j === 0 && ranked.length > 1 ? "#08210f" : C2.text,
        background: j === 0 && ranked.length > 1 ? C2.green : C2.card,
        border: `1px solid ${C2.border}`
      }
    }, p.name, " ", fmt(p.score)))));
  })))));
}
function Section(props) {
  return /* @__PURE__ */ Spicetify.React.createElement("div", null, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }
  }, /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 13, fontWeight: 700, letterSpacing: 1.2, color: C2.sub, textTransform: "uppercase" }
  }, props.title), props.hint && /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { fontSize: 12, color: C2.sub }
  }, props.hint)), props.children);
}
function Table(props) {
  const { head, rows } = props;
  return /* @__PURE__ */ Spicetify.React.createElement("div", {
    style: { overflowX: "auto", background: C2.card, border: `1px solid ${C2.border}`, borderRadius: 12 }
  }, /* @__PURE__ */ Spicetify.React.createElement("table", {
    style: { width: "100%", borderCollapse: "collapse", fontSize: 15 }
  }, /* @__PURE__ */ Spicetify.React.createElement("thead", null, /* @__PURE__ */ Spicetify.React.createElement("tr", null, head.map((h, i) => /* @__PURE__ */ Spicetify.React.createElement("th", {
    key: i,
    style: {
      textAlign: i === 0 ? "left" : "right",
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 0.5,
      color: C2.sub,
      textTransform: "uppercase",
      padding: "6px 12px"
    }
  }, h)))), /* @__PURE__ */ Spicetify.React.createElement("tbody", null, rows.map((r, ri) => /* @__PURE__ */ Spicetify.React.createElement("tr", {
    key: ri,
    style: { borderTop: `1px solid ${C2.border}` }
  }, r.cells.map((c, ci) => /* @__PURE__ */ Spicetify.React.createElement("td", {
    key: ci,
    style: {
      padding: "10px 12px",
      textAlign: ci === 0 ? "left" : "right",
      fontWeight: ci === 0 ? 600 : 500,
      color: r.lead && ci === 2 ? C2.green : C2.text,
      whiteSpace: ci === 0 ? "normal" : "nowrap",
      fontVariantNumeric: "tabular-nums"
    }
  }, r.lead && ci === 0 ? /* @__PURE__ */ Spicetify.React.createElement("span", null, "\uD83D\uDC51 ", c) : c)))))));
}

// src/persist.ts
var SETTINGS_KEYS = [
  SENS_KEY,
  SENS_SCALE_KEY,
  DIFFICULTY_KEY,
  NOWLINE_KEY,
  MIC_SLOTS_KEY,
  PLAYER_SENS_KEY,
  AUTOSKIP_KEY
];
function ls() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function gather(keys) {
  const store = ls();
  const out = {};
  if (!store)
    return out;
  for (const k of keys) {
    const v = store.getItem(k);
    if (v != null)
      out[k] = v;
  }
  return out;
}
function gatherOffsets() {
  const store = ls();
  const out = {};
  if (!store)
    return out;
  for (let i = 0;i < store.length; i++) {
    const k = store.key(i);
    if (k && (k === DEFAULT_OFFSET_KEY || k.startsWith(OFFSET_PREFIX))) {
      const v = store.getItem(k);
      if (v != null)
        out[k] = v;
    }
  }
  return out;
}
function debounce(fn, ms) {
  let t = 0;
  return () => {
    clearTimeout(t);
    t = window.setTimeout(fn, ms);
  };
}
var pushSettings = debounce(() => {
  saveStore("settings", gather(SETTINGS_KEYS)).catch((err) => console.error("[singify] settings mirror failed:", err));
}, 600);
var pushOffsets = debounce(() => {
  saveStore("offsets", gatherOffsets()).catch((err) => console.error("[singify] offsets mirror failed:", err));
}, 600);
function mirrorSettings() {
  pushSettings();
}
function mirrorOffsets() {
  pushOffsets();
}
async function seedFromHelper() {
  const store = ls();
  if (!store)
    return [];
  const restored = [];
  try {
    const [settings, offsets] = await Promise.all([
      loadStore("settings"),
      loadStore("offsets")
    ]);
    for (const src of [settings, offsets]) {
      for (const [k, v] of Object.entries(src ?? {})) {
        if (typeof v === "string" && store.getItem(k) == null) {
          store.setItem(k, v);
          restored.push(k);
        }
      }
    }
    mirrorSettings();
    mirrorOffsets();
  } catch {}
  return restored;
}
var statsCache = null;
var pending = [];
var loadingPromise = null;
var pushStats = debounce(() => {
  if (statsCache) {
    const doc = { rounds: statsCache };
    saveStore("stats", doc).catch((err) => console.error("[singify] stats save failed:", err));
  }
}, 400);
async function ensureLoaded() {
  if (statsCache)
    return statsCache;
  if (loadingPromise)
    return loadingPromise;
  loadingPromise = (async () => {
    try {
      const doc = await loadStore("stats");
      const rounds = Array.isArray(doc?.rounds) ? doc.rounds : [];
      if (pending.length) {
        rounds.push(...pending);
        pending = [];
        pushStats();
      }
      statsCache = rounds;
      return statsCache;
    } catch {
      return null;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}
async function loadStatRounds() {
  const rounds = await ensureLoaded();
  if (rounds)
    return { rounds, reachable: true };
  return { rounds: [...pending], reachable: false };
}
function recordStatRound(round) {
  (async () => {
    const rounds = await ensureLoaded();
    if (rounds) {
      rounds.push(round);
      pushStats();
    } else {
      pending.push(round);
    }
  })();
}
function flushStats() {
  if (statsCache) {
    saveStore("stats", { rounds: statsCache }).catch(() => {});
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushStats);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden")
        flushStats();
    });
  }
}

// src/ui-scale.ts
var UI_SCALE = 0.75;

// src/index.ts
var lastKnownMs = 0;
var lastKnownAt = 0;
var paused = false;
function getBaseMs() {
  if (paused)
    return lastKnownMs;
  return lastKnownMs + (performance.now() - lastKnownAt);
}
function getCurrentMs() {
  return getBaseMs() + offsetMs;
}
function onProgress(e) {
  lastKnownMs = Number(e.data) || 0;
  lastKnownAt = performance.now();
}
function onPlayPause() {
  lastKnownMs = getBaseMs();
  lastKnownAt = performance.now();
  paused = !!Spicetify.Player.data?.isPaused;
}
var OFFSET_STEP = 10;
function readNum(key) {
  const raw = localStorage.getItem(key);
  if (raw == null)
    return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
var defaultOffset = readNum(DEFAULT_OFFSET_KEY) ?? 0;
function loadOffsetForTrack(trackId) {
  if (!trackId)
    return defaultOffset;
  return readNum(OFFSET_PREFIX + trackId) ?? defaultOffset;
}
var offsetMs = defaultOffset;
function setOffset(next) {
  offsetMs = Math.round(next);
  try {
    if (currentTrackId) {
      localStorage.setItem(OFFSET_PREFIX + currentTrackId, String(offsetMs));
    } else {
      defaultOffset = offsetMs;
      localStorage.setItem(DEFAULT_OFFSET_KEY, String(offsetMs));
    }
  } catch {}
  mirrorOffsets();
  showOffset();
}
var readoutEl = null;
var readoutTimer = 0;
function showReadout(text) {
  if (!readoutEl) {
    readoutEl = document.createElement("div");
    readoutEl.id = "singify-readout";
    Object.assign(readoutEl.style, {
      position: "fixed",
      bottom: "24px",
      left: "24px",
      zIndex: "1000",
      padding: "32px 64px",
      borderRadius: "72px",
      background: "rgba(10, 10, 14, 0.92)",
      color: "#fff",
      font: "600 52px 'Spotify Circular', system-ui, sans-serif",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 180ms ease"
    });
    readoutEl.style.setProperty("zoom", String(UI_SCALE));
    document.body.appendChild(readoutEl);
  }
  readoutEl.textContent = text;
  readoutEl.style.opacity = "1";
  clearTimeout(readoutTimer);
  readoutTimer = window.setTimeout(() => {
    if (readoutEl)
      readoutEl.style.opacity = "0";
  }, 1200);
}
function showOffset() {
  const sign = offsetMs > 0 ? "+" : "";
  const scope = currentTrackId ? "this track" : "default";
  showReadout(`Lyric offset ${sign}${offsetMs} ms · ${scope}`);
}
function firstNoteMs(song) {
  for (const line of song.lines) {
    const s = line.syllables[0];
    if (s)
      return s.startMs;
  }
  return null;
}
function punchSync() {
  if (!currentSong) {
    Spicetify.showNotification?.("Punch-sync: no chart loaded");
    return;
  }
  const firstMs = firstNoteMs(currentSong);
  if (firstMs == null) {
    Spicetify.showNotification?.("Punch-sync: chart has no notes");
    return;
  }
  setOffset(firstMs - getBaseMs());
  const sign = offsetMs > 0 ? "+" : "";
  showReadout(`⏱ Punched — first line synced · offset ${sign}${offsetMs} ms`);
}
function activeRoster() {
  return session ? sessionRoster : soloRoster;
}
function setActiveRoster(next) {
  if (session)
    sessionRoster = next;
  else
    soloRoster = next;
}
async function openMic(p) {
  const opts = {
    gain: p.gain,
    rmsThreshold: sensitivityToThreshold(p.sensitivity),
    monitor: !!p.monitor,
    monitorGain: p.monitorGain ?? 0.05,
    outputDeviceId: p.outputDeviceId
  };
  try {
    return await startMicPitch({ deviceId: p.deviceId, ...opts });
  } catch (err) {
    console.error(`[singify] mic for ${p.name} failed:`, err);
    if (p.deviceId) {
      try {
        const fallback = await startMicPitch(opts);
        Spicetify.showNotification?.(`${p.name}: saved mic missing — using the default`);
        return fallback;
      } catch (err2) {
        console.error(`[singify] default mic for ${p.name} failed too:`, err2);
      }
    }
    Spicetify.showNotification?.(`Mic unavailable for ${p.name}`, true);
    return null;
  }
}
async function startMics() {
  const roster = activeRoster();
  mics = await Promise.all(roster.map(openMic));
  const live = micCount();
  if (live === 0)
    Spicetify.showNotification?.("Mic access denied", true);
  else
    Spicetify.showNotification?.(live > 1 ? `\uD83C\uDFA4 ${live} mics on` : "\uD83C\uDFA4 Mic on");
  loadDevices();
  if (visible)
    renderOverlay();
}
function stopMics(quiet = false) {
  for (const m of mics)
    m?.stop();
  mics = [];
  if (!quiet)
    Spicetify.showNotification?.("Mic off");
  if (visible)
    renderOverlay();
}
async function toggleMics() {
  if (mics.length)
    stopMics();
  else
    await startMics();
}
function micCount() {
  return mics.filter(Boolean).length;
}
function micsActive() {
  return micCount() > 0;
}
function patchSlot(i, patch) {
  const roster = activeRoster();
  const slot = roster[i];
  if (!slot)
    return null;
  const next = { ...slot, ...patch };
  const updated = roster.map((p, j) => j === i ? next : p);
  setActiveRoster(updated);
  saveMicSlots(updated);
  return next;
}
function setPlayerGain(i, gain) {
  if (!patchSlot(i, { gain }))
    return;
  mics[i]?.setGain(gain);
  if (visible)
    renderOverlay();
}
function setPlayerSensitivity(i, value) {
  const n = Math.min(100, Math.max(0, Math.round(value)));
  if (!patchSlot(i, { sensitivity: n }))
    return;
  mics[i]?.setOptions({ rmsThreshold: sensitivityToThreshold(n) });
  if (visible)
    renderOverlay();
}
async function setPlayerDevice(i, deviceId) {
  const next = patchSlot(i, { deviceId });
  if (!next)
    return;
  if (mics.length) {
    mics[i]?.stop();
    mics[i] = await openMic(next);
  }
  if (visible)
    renderOverlay();
}
function setPlayerMonitor(i, on) {
  if (!patchSlot(i, { monitor: on }))
    return;
  mics[i]?.setMonitor(on);
  if (visible)
    renderOverlay();
}
function setPlayerMonitorGain(i, gain) {
  const g = Math.min(1, Math.max(0, gain));
  if (!patchSlot(i, { monitorGain: g }))
    return;
  mics[i]?.setMonitorGain(g);
  if (visible)
    renderOverlay();
}
function setPlayerOutput(i, deviceId) {
  if (!patchSlot(i, { outputDeviceId: deviceId }))
    return;
  mics[i]?.setOutputDevice(deviceId);
  if (visible)
    renderOverlay();
}
function activePlayers() {
  if (competitiveMode && session) {
    const idx = Math.min(session.rounds.length, session.players.length - 1);
    const m = mics[0];
    if (!m)
      return [];
    return [
      {
        id: "mic0",
        name: session.players[idx] ?? `P${idx + 1}`,
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
        getPitchMidi: () => m.read()?.midi ?? null
      }
    ];
  }
  const roster = activeRoster();
  const out = [];
  mics.forEach((m, i) => {
    const p = roster[i];
    if (!m || !p)
      return;
    out.push({
      id: `mic${i}`,
      name: p.name,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      getPitchMidi: () => m.read()?.midi ?? null
    });
  });
  return out;
}
var scoreResetToken = 0;
function resetScores() {
  scoreResetToken++;
  showReadout("↺ Scores reset");
  if (visible)
    renderOverlay();
}
function restartSong() {
  onReplay();
  scoreResetToken++;
  showReadout("⟲ Song restarted");
  if (visible)
    renderOverlay();
}
function onReplay() {
  try {
    Spicetify.Player.seek?.(0);
  } catch (err) {
    console.error("[singify] replay seek failed:", err);
  }
}
var SENS_SCALE = "v2";
function v1Threshold(sensitivity) {
  const s = Math.min(100, Math.max(0, sensitivity));
  return 0.05 * (0.003 / 0.05) ** (s / 100);
}
function loadSensitivity() {
  const v = Number(localStorage.getItem(SENS_KEY));
  if (!Number.isFinite(v) || v < 0 || v > 100)
    return 70;
  if (localStorage.getItem(SENS_SCALE_KEY) === SENS_SCALE)
    return v;
  const migrated = Math.round(thresholdToSensitivity(v1Threshold(v)));
  try {
    localStorage.setItem(SENS_KEY, String(migrated));
    localStorage.setItem(SENS_SCALE_KEY, SENS_SCALE);
  } catch {}
  return migrated;
}
var sensitivity = loadSensitivity();
function loadDifficulty() {
  const v = localStorage.getItem(DIFFICULTY_KEY);
  return v === "medium" || v === "hard" ? v : "easy";
}
var difficulty = loadDifficulty();
var NOWLINE_STEP = 4;
var NOWLINE_MAX = 200;
function loadNowLineNudge() {
  const v = Number(localStorage.getItem(NOWLINE_KEY));
  return Number.isFinite(v) && Math.abs(v) <= NOWLINE_MAX ? v : 0;
}
var nowLineNudge = loadNowLineNudge();
function setNowLineNudge(next) {
  nowLineNudge = Math.min(NOWLINE_MAX, Math.max(-NOWLINE_MAX, Math.round(next)));
  try {
    localStorage.setItem(NOWLINE_KEY, String(nowLineNudge));
  } catch {}
  mirrorSettings();
  const sign = nowLineNudge > 0 ? "+" : "";
  showReadout(`Hit-line ${sign}${nowLineNudge}px`);
  if (visible)
    renderOverlay();
}
function setDifficulty(next) {
  difficulty = next;
  try {
    localStorage.setItem(DIFFICULTY_KEY, next);
  } catch {}
  mirrorSettings();
  showReadout(`Difficulty: ${next}`);
  if (visible)
    renderOverlay();
}
function loadMicSlots() {
  try {
    const raw = JSON.parse(localStorage.getItem(MIC_SLOTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function saveMicSlots(roster) {
  const merged = loadMicSlots();
  roster.forEach((p, i) => {
    merged[i] = {
      name: p.name,
      deviceId: p.deviceId,
      gain: p.gain,
      sensitivity: p.sensitivity,
      monitor: p.monitor,
      monitorGain: p.monitorGain,
      outputDeviceId: p.outputDeviceId
    };
  });
  try {
    localStorage.setItem(MIC_SLOTS_KEY, JSON.stringify(merged));
  } catch {}
  mirrorSettings();
}
function loadPlayerSensitivities() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYER_SENS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}
function defaultSensitivityFor(i) {
  return loadPlayerSensitivities()[i] ?? sensitivity;
}
function setSensitivity(next) {
  sensitivity = Math.min(100, Math.max(0, Math.round(next)));
  try {
    localStorage.setItem(SENS_KEY, String(sensitivity));
    localStorage.setItem(SENS_SCALE_KEY, SENS_SCALE);
  } catch {}
  const t = sensitivityToThreshold(sensitivity);
  setActiveRoster(activeRoster().map((p) => ({ ...p, sensitivity })));
  setupRoster = setupRoster.map((p) => ({ ...p, sensitivity }));
  for (const m of mics)
    m?.setOptions({ rmsThreshold: t });
  for (const m of previewMics)
    m?.setOptions({ rmsThreshold: t });
  saveMicSlots(activeRoster());
  showReadout(`\uD83C\uDFA4 Sensitivity ${sensitivity}%`);
  if (visible)
    renderOverlay();
}
function loadLocalChart() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,text/plain";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file)
      return;
    try {
      const song = parse(await file.text());
      if (song.lines.length === 0)
        throw new Error("no singable notes found");
      currentSong = song;
      manualChart = true;
      pickerCandidates = null;
      pickError = null;
      if (!visible)
        setVisible(true);
      else
        renderOverlay();
      Spicetify.showNotification?.(`\uD83C\uDFA4 ${song.headers.artist} – ${song.headers.title} loaded`);
    } catch (err) {
      Spicetify.showNotification?.(`Chart parse failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };
  input.click();
}
var overlay = null;
var root = null;
var currentSong = null;
var visible = false;
var activeScreen = "sing";
var session = null;
var setupRounds = 5;
var competitiveMode = false;
var competitors = ["P1", "P2"];
var competitiveDevice;
function newSlot(i, name) {
  const saved = loadMicSlots()[i];
  return {
    name: saved?.name ?? name,
    deviceId: saved?.deviceId,
    gain: typeof saved?.gain === "number" ? saved.gain : 1,
    sensitivity: typeof saved?.sensitivity === "number" ? saved.sensitivity : defaultSensitivityFor(i),
    monitor: !!saved?.monitor,
    monitorGain: typeof saved?.monitorGain === "number" ? saved.monitorGain : 0.05,
    outputDeviceId: saved?.outputDeviceId
  };
}
function migratePlayerNames() {
  const slots = loadMicSlots();
  let changed = false;
  slots.forEach((s, i) => {
    if (s && s.name === "You") {
      s.name = `P${i + 1}`;
      changed = true;
    }
  });
  if (!changed)
    return;
  try {
    localStorage.setItem(MIC_SLOTS_KEY, JSON.stringify(slots));
  } catch {}
  mirrorSettings();
}
migratePlayerNames();
var setupRoster = [newSlot(0, "P1"), newSlot(1, "P2")];
var sessionRoster = [newSlot(0, "P1")];
var soloRoster = [newSlot(0, "P1")];
var audioInputs = [];
var audioOutputs = [];
var monitorRoutingSupported = outputRoutingSupported();
var lastRound = null;
var scoredTrackIds = new Set;
var playlists = [];
var playlistsLoading = false;
var manualChart = false;
var statRounds = [];
var statsHelperDown = false;
var currentTrackId = null;
var resolving = false;
var helperDown = false;
async function helperIsUnreachable(err) {
  if (!(err instanceof TypeError))
    return false;
  return await helperHealth() === null;
}
var pickerQuery = null;
var pickerCandidates = null;
var pickPending = null;
var pickError = null;
var mics = [];
var previewMics = [];
function ensureOverlay() {
  if (overlay)
    return overlay;
  overlay = document.createElement("div");
  overlay.id = "singify-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "999",
    background: "rgba(10, 10, 14, 0.94)",
    backdropFilter: "blur(6px)",
    display: "none"
  });
  document.body.appendChild(overlay);
  const rd = Spicetify.ReactDOM;
  if (rd.createRoot) {
    root = rd.createRoot(overlay);
  } else if (rd.render) {
    root = {
      render: (el) => rd.render(el, overlay),
      unmount: () => {}
    };
  }
  return overlay;
}
function renderScaled(el) {
  if (!root)
    return;
  const React = Spicetify.React;
  root.render(React.createElement("div", {
    style: { zoom: UI_SCALE, width: "100%", height: "100%" }
  }, el));
}
function renderOverlay() {
  if (!root)
    return;
  const React = Spicetify.React;
  if (activeScreen === "home") {
    const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
    const track = item ? { artist: item.artists?.[0]?.name ?? "", title: item.name ?? "" } : null;
    renderScaled(React.createElement(HomeMenu, {
      track,
      onQuickSing: () => {
        activeScreen = "sing";
        renderOverlay();
      },
      onStartSession: openSessionSetup,
      onCompetitive: openCompetitive,
      onStats: openStats
    }));
    return;
  }
  if (activeScreen === "stats") {
    renderScaled(React.createElement(StatsScreen, {
      rounds: statRounds,
      helperDown: statsHelperDown,
      onBack: () => {
        activeScreen = "home";
        renderOverlay();
      }
    }));
    return;
  }
  if (activeScreen === "competitive-setup") {
    const song = currentSong ? {
      title: currentSong.headers.title || currentTitle(),
      artist: currentSong.headers.artist || currentArtist()
    } : null;
    renderScaled(React.createElement(CompetitiveSetup, {
      players: competitors,
      difficulty,
      devices: audioInputs,
      deviceId: competitiveDevice,
      track: song,
      onName: (i, name) => {
        competitors = competitors.map((p, j) => j === i ? name : p);
        renderOverlay();
      },
      onAdd: () => {
        if (competitors.length < 4) {
          competitors = [...competitors, `P${competitors.length + 1}`];
          renderOverlay();
        }
      },
      onRemove: (i) => {
        if (competitors.length > 2) {
          competitors = competitors.filter((_, j) => j !== i);
          renderOverlay();
        }
      },
      onDifficulty: setDifficulty,
      onDevice: (id) => {
        competitiveDevice = id;
        renderOverlay();
      },
      onStart: startCompetitive,
      onCancel: () => {
        activeScreen = "home";
        renderOverlay();
      }
    }));
    return;
  }
  if (activeScreen === "session-setup") {
    renderScaled(React.createElement(SessionSetup, {
      playlists,
      loadingPlaylists: playlistsLoading,
      current: currentContextPlaylist(),
      onStartPlaylist: (ref) => void startPlaylistSession(ref),
      rounds: setupRounds,
      onRounds: (n) => {
        setupRounds = n;
        renderOverlay();
      },
      difficulty,
      onDifficulty: setDifficulty,
      players: setupRoster,
      onName: (i, name) => {
        setupRoster = setupRoster.map((p, j) => j === i ? { ...p, name } : p);
        saveMicSlots(setupRoster);
        renderOverlay();
      },
      onDevice: (i, deviceId) => {
        setupRoster = setupRoster.map((p, j) => j === i ? { ...p, deviceId } : p);
        saveMicSlots(setupRoster);
        startPreviewMic(i);
        renderOverlay();
      },
      onGain: (i, gain) => {
        setupRoster = setupRoster.map((p, j) => j === i ? { ...p, gain } : p);
        saveMicSlots(setupRoster);
        previewMics[i]?.setGain(gain);
        renderOverlay();
      },
      onAddPlayer: () => {
        if (setupRoster.length >= 4)
          return;
        setupRoster = [
          ...setupRoster,
          newSlot(setupRoster.length, `P${setupRoster.length + 1}`)
        ];
        saveMicSlots(setupRoster);
        startPreviewMic(setupRoster.length - 1);
        renderOverlay();
      },
      onRemovePlayer: (i) => {
        if (setupRoster.length <= 1)
          return;
        previewMics[i]?.stop();
        previewMics = previewMics.filter((_, j) => j !== i);
        setupRoster = setupRoster.filter((_, j) => j !== i);
        renderOverlay();
      },
      devices: audioInputs,
      levelFor: previewLevel,
      onSensitivity: (i, n) => {
        setupRoster = setupRoster.map((q, j) => j === i ? { ...q, sensitivity: n } : q);
        previewMics[i]?.setOptions({ rmsThreshold: sensitivityToThreshold(n) });
        saveMicSlots(setupRoster);
        renderOverlay();
      },
      onStart: startSession,
      onCancel: () => {
        stopPreviews();
        activeScreen = "home";
        renderOverlay();
      },
      micOn: micsActive()
    }));
    return;
  }
  if (activeScreen === "round-end" && session && lastRound) {
    renderScaled(React.createElement(RoundEnd, {
      justFinished: lastRound,
      roundNumber: session.rounds.length,
      target: session.targetRounds,
      sessionTotal: sessionTotal(),
      onContinue: continueSession,
      upNext: upNext(session)
    }));
    return;
  }
  if (activeScreen === "session-result" && session) {
    renderScaled(React.createElement(SessionResultScreen, {
      summary: summarize(session),
      onDone: finishSession,
      onSave: () => Spicetify.showNotification?.("Saving sessions as playlists is coming next \uD83D\uDCBE")
    }));
    return;
  }
  const singContent = currentSong ? React.createElement(KaraokeView, {
    song: currentSong,
    getPositionMs: getCurrentMs,
    players: activePlayers(),
    onReplay,
    onComplete: session ? onRoundComplete : undefined,
    resetToken: scoreResetToken,
    difficulty,
    nowLineNudge,
    fullscreen: true
  }) : pickerCandidates ? React.createElement(SongPicker, {
    candidates: pickerCandidates,
    query: pickerQuery ?? undefined,
    pendingId: pickPending,
    error: pickError,
    onPick,
    onCancel
  }) : session ? React.createElement(NoChartInSession, {
    title: currentTitle(),
    artist: currentArtist(),
    onSkip: skipRound,
    onReChoose: () => void reSearch(),
    searched: !resolving,
    helperDown
  }) : helperDown ? React.createElement(HelperDownNotice, {
    title: currentTitle(),
    artist: currentArtist(),
    onReChoose: () => void reSearch()
  }) : React.createElement("div", {
    style: {
      display: "flex",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      color: "#c8c8c8",
      fontSize: 20
    }
  }, "No karaoke chart for this track.");
  const hudMics = activeRoster().map((p, i) => ({ ...p, index: i, pitch: mics[i] })).filter((e) => e.pitch).map((e) => ({ ...e, getLevel: () => e.pitch?.level() ?? 0 }));
  const micBanner = hudMics.length ? React.createElement(MicOverlay, {
    mics: hudMics,
    devices: audioInputs,
    outputs: audioOutputs,
    routingSupported: monitorRoutingSupported,
    onGain: (i, gain) => setPlayerGain(hudMics[i]?.index ?? i, gain),
    onSensitivity: (i, n) => setPlayerSensitivity(hudMics[i]?.index ?? i, n),
    onDevice: (i, deviceId) => void setPlayerDevice(hudMics[i]?.index ?? i, deviceId),
    onMonitor: (i, on) => setPlayerMonitor(hudMics[i]?.index ?? i, on),
    onMonitorGain: (i, gain) => setPlayerMonitorGain(hudMics[i]?.index ?? i, gain),
    onOutput: (i, deviceId) => setPlayerOutput(hudMics[i]?.index ?? i, deviceId)
  }) : null;
  const nowPlaying = currentSong ? React.createElement(NowPlaying, {
    title: currentTitle() || currentSong.headers.title || "",
    artist: currentArtist() || currentSong.headers.artist || ""
  }) : null;
  const hud = session ? React.createElement(SessionHud, {
    round: Math.min(session.rounds.length + 1, session.targetRounds),
    target: session.targetRounds,
    totals: sessionTotals(),
    micsOn: micsActive(),
    onSkip: skipRound,
    onEnd: endSession,
    onResetScores: resetScores,
    onRestartSong: restartSong,
    autoSkip: autoSkipNoChart,
    onAutoSkip: setAutoSkip,
    sourceName: session.playlistName
  }) : null;
  const topRow = hud || nowPlaying || micBanner ? React.createElement("div", {
    style: {
      position: "absolute",
      top: 24,
      left: 24,
      right: 24,
      zIndex: 6,
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
      alignItems: "start",
      gap: 24
    }
  }, React.createElement("div", { style: { minWidth: 0 } }, hud), React.createElement("div", { style: { minWidth: 0 } }, nowPlaying), React.createElement("div", { style: { minWidth: 0, display: "flex", justifyContent: "flex-end" } }, micBanner)) : null;
  if (topRow) {
    renderScaled(React.createElement("div", { style: { position: "relative", height: "100%" } }, topRow, singContent));
    return;
  }
  renderScaled(singContent);
}
function setVisible(next) {
  visible = next;
  const el = ensureOverlay();
  el.style.display = visible ? "block" : "none";
  if (visible) {
    renderOverlay();
    if (fpsWanted)
      startFps();
  } else {
    stopFps();
    stopPreviews();
  }
}
function openSing() {
  if (visible && activeScreen === "sing") {
    setVisible(false);
    return;
  }
  activeScreen = "sing";
  setVisible(true);
}
function openHome() {
  if (visible && activeScreen === "home") {
    setVisible(false);
    return;
  }
  activeScreen = "home";
  setVisible(true);
}
function openStats() {
  activeScreen = "stats";
  setVisible(true);
  loadStatRounds().then(({ rounds, reachable }) => {
    statRounds = rounds;
    statsHelperDown = !reachable;
    if (activeScreen === "stats")
      renderOverlay();
  });
}
function sessionTotals() {
  return session ? summarize(session).players.map((p) => ({ name: p.player, total: p.total })) : [];
}
function sessionTotal() {
  return session ? session.rounds.reduce((sum, r) => sum + (r.scores[0]?.total ?? 0), 0) : 0;
}
function openSessionSetup() {
  activeScreen = "session-setup";
  renderOverlay();
  loadPlaylists();
  loadDevices();
}
function openCompetitive() {
  activeScreen = "competitive-setup";
  renderOverlay();
  loadDevices();
}
function startCompetitive() {
  if (!currentSong || !currentTrackId) {
    Spicetify.showNotification?.("Play a song with a chart first, then start the duel", true);
    return;
  }
  const names = competitors.map((n, i) => n.trim() || `P${i + 1}`);
  session = createSession(names.length, names);
  competitiveMode = true;
  sessionRoster = [
    {
      name: names[0],
      deviceId: competitiveDevice,
      gain: 1,
      sensitivity,
      monitor: false,
      monitorGain: 0.05,
      outputDeviceId: undefined
    }
  ];
  scoredTrackIds = new Set;
  lastRound = null;
  stopPreviews();
  if (micsActive())
    stopMics(true);
  startMics();
  onReplay();
  scoreResetToken++;
  activeScreen = "sing";
  renderOverlay();
}
async function loadDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of s.getTracks())
      t.stop();
  } catch (err) {
    console.error("[singify] mic permission for device list denied:", err);
  }
  audioInputs = await enumerateInputs();
  audioOutputs = await enumerateOutputs();
  if (activeScreen === "session-setup") {
    renderOverlay();
    startPreviews();
  }
}
async function startPreviewMic(i) {
  const p = setupRoster[i];
  if (!p)
    return;
  previewMics[i]?.stop();
  try {
    previewMics[i] = await startMicPitch({
      deviceId: p.deviceId,
      gain: p.gain,
      rmsThreshold: sensitivityToThreshold(p.sensitivity)
    });
  } catch (err) {
    console.error(`[singify] preview mic for ${p.name} failed:`, err);
    previewMics[i] = null;
  }
  if (activeScreen === "session-setup")
    renderOverlay();
}
async function startPreviews() {
  stopPreviews();
  previewMics = new Array(setupRoster.length).fill(null);
  await Promise.all(setupRoster.map((_, i) => startPreviewMic(i)));
}
function stopPreviews() {
  for (const m of previewMics)
    m?.stop();
  previewMics = [];
}
function previewLevel(i) {
  return previewMics[i]?.level() ?? 0;
}
async function loadPlaylists() {
  playlistsLoading = true;
  if (activeScreen === "session-setup")
    renderOverlay();
  try {
    playlists = await fetchPlaylists();
  } finally {
    playlistsLoading = false;
    if (activeScreen === "session-setup")
      renderOverlay();
  }
}
function startSession() {
  session = createSession(setupRounds, setupRoster.map((p) => p.name));
  sessionRoster = setupRoster.map((p) => ({ ...p }));
  scoredTrackIds = new Set;
  lastRound = null;
  stopPreviews();
  if (micsActive())
    stopMics(true);
  startMics();
  activeScreen = "sing";
  renderOverlay();
}
async function startPlaylistSession(ref) {
  Spicetify.showNotification?.(`Loading “${ref.name}”…`);
  const tracks = await fetchPlaylistTracks(ref.uri);
  if (tracks.length === 0) {
    Spicetify.showNotification?.(`“${ref.name}” has no playable tracks`, true);
    return;
  }
  session = createSessionFromPlaylist(ref.name, tracks, setupRoster.map((p) => p.name));
  sessionRoster = setupRoster.map((p) => ({ ...p }));
  scoredTrackIds = new Set;
  lastRound = null;
  stopPreviews();
  if (micsActive())
    stopMics(true);
  startMics();
  activeScreen = "sing";
  renderOverlay();
  const ok = await playPlaylist(ref.uri);
  if (!ok) {
    Spicetify.showNotification?.("Couldn't auto-start the playlist — press play to begin", true);
  }
}
function rosterSlotForScore(s) {
  const m = s.id.match(/^mic(\d+)$/);
  if (m)
    return activeRoster()[Number(m[1])];
  return activeRoster().find((p) => p.name === s.name);
}
function micLabelFor(slot) {
  if (!slot?.deviceId)
    return "Default mic";
  return audioInputs.find((d) => d.deviceId === slot.deviceId)?.label ?? "Custom mic";
}
function onRoundComplete(scores) {
  if (!session || !currentSong || !currentTrackId)
    return;
  if (!competitiveMode && scoredTrackIds.has(currentTrackId))
    return;
  if (scores.length === 0)
    return;
  if (!competitiveMode)
    scoredTrackIds.add(currentTrackId);
  recordStatRound({
    t: Date.now(),
    title: currentSong.headers.title,
    artist: currentSong.headers.artist,
    difficulty,
    players: scores.map((s) => {
      const slot = rosterSlotForScore(s);
      return {
        name: s.name,
        score: s.score.total,
        device: micLabelFor(slot),
        gain: slot?.gain ?? 1,
        sensitivity: slot?.sensitivity ?? sensitivity
      };
    })
  });
  const r = roundFromScores(currentSong.headers.title, currentSong.headers.artist, scores.map((s) => ({ player: s.name, score: s.score })));
  session = recordRound(session, r);
  lastRound = r;
  if (competitiveMode) {
    try {
      Spicetify.Player.pause?.();
    } catch (err) {
      console.error("[singify] competitive pause failed:", err);
    }
  }
  activeScreen = isComplete(session) ? "session-result" : "round-end";
  renderOverlay();
}
function advanceQueue(what) {
  const next = Spicetify.Player.next;
  if (!next) {
    Spicetify.showNotification?.(`Couldn't ${what} — use Spotify's Next`, true);
    return;
  }
  try {
    next();
  } catch (err) {
    console.error(`[singify] ${what} failed:`, err);
    Spicetify.showNotification?.(`Couldn't ${what} — use Spotify's Next`, true);
  }
}
function continueSession() {
  if (competitiveMode) {
    onReplay();
    const play = Spicetify.Player.play;
    try {
      if (!play)
        throw new Error("Player.play unavailable");
      play();
    } catch (err) {
      console.error("[singify] competitive resume failed:", err);
      Spicetify.showNotification?.("Couldn't restart the track — press play", true);
    }
    scoreResetToken++;
    activeScreen = "sing";
    renderOverlay();
    return;
  }
  advanceQueue("continue the session");
}
var autoSkipNoChart = localStorage.getItem(AUTOSKIP_KEY) === "1";
var AUTOSKIP_LIMIT = 8;
var autoSkipStreak = 0;
function setAutoSkip(on) {
  autoSkipNoChart = on;
  autoSkipStreak = 0;
  try {
    localStorage.setItem(AUTOSKIP_KEY, on ? "1" : "0");
  } catch {}
  mirrorSettings();
  if (visible)
    renderOverlay();
}
function skipRound() {
  if (competitiveMode) {
    onReplay();
    scoreResetToken++;
    if (visible)
      renderOverlay();
    return;
  }
  advanceQueue("skip this song");
}
function endSession() {
  if (session && session.rounds.length > 0) {
    activeScreen = "session-result";
  } else {
    session = null;
    competitiveMode = false;
    activeScreen = "home";
  }
  renderOverlay();
}
function finishSession() {
  session = null;
  lastRound = null;
  scoredTrackIds = new Set;
  competitiveMode = false;
  activeScreen = "home";
  renderOverlay();
}
function currentItem() {
  return Spicetify.Player.data?.item ?? Spicetify.Player.data?.track ?? null;
}
function currentTitle() {
  return currentItem()?.name ?? "";
}
function currentArtist() {
  return currentItem()?.artists?.[0]?.name ?? "";
}
async function onPick(candidate) {
  if (!currentTrackId)
    return;
  pickPending = candidate.id;
  pickError = null;
  if (visible)
    renderOverlay();
  try {
    const song = await confirmPick(currentTrackId, candidate);
    pickerCandidates = null;
    pickPending = null;
    currentSong = song;
  } catch (err) {
    pickPending = null;
    pickError = err instanceof Error ? err.message : "Download failed — try another match.";
    console.error("[singify] pick failed:", err);
  }
  if (visible)
    renderOverlay();
}
function onCancel() {
  pickerCandidates = null;
  pickPending = null;
  pickError = null;
  if (visible)
    renderOverlay();
}
async function onSongChange() {
  if (manualChart)
    return;
  const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  if (!item?.uri)
    return;
  const title = item.name ?? "";
  const artist = item.artists?.[0]?.name ?? "";
  currentSong = null;
  currentTrackId = item.uri;
  offsetMs = loadOffsetForTrack(currentTrackId);
  pickerCandidates = null;
  pickPending = null;
  pickError = null;
  resolving = true;
  let noChart = false;
  if (visible)
    renderOverlay();
  try {
    const res = await resolveForTrack(item.uri, artist, title);
    helperDown = false;
    if (res.status === "cached" || res.status === "downloaded" || res.status === "local") {
      currentSong = res.song;
      autoSkipStreak = 0;
    } else if (res.status === "needsPicker") {
      pickerQuery = { artist, title };
      pickerCandidates = res.candidates;
      if (!visible) {
        Spicetify.showNotification?.(`Karaoke: ${res.candidates.length} matches for “${title}” — press Q to choose`);
      }
    } else {
      noChart = true;
      if (!(session && autoSkipNoChart)) {
        Spicetify.showNotification?.(`No karaoke chart for “${title}”`);
      }
    }
  } catch (err) {
    console.error("[singify] resolve failed:", err);
    helperDown = await helperIsUnreachable(err);
    if (!helperDown) {
      Spicetify.showNotification?.(`Karaoke lookup failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  } finally {
    resolving = false;
  }
  if (session && activeScreen === "round-end")
    activeScreen = "sing";
  if (noChart && session && autoSkipNoChart) {
    if (autoSkipStreak >= AUTOSKIP_LIMIT) {
      Spicetify.showNotification?.(`Auto-skip off — ${AUTOSKIP_LIMIT} tracks in a row had no chart`, true);
      setAutoSkip(false);
    } else {
      autoSkipStreak++;
      skipRound();
      return;
    }
  }
  if (visible)
    renderOverlay();
}
async function reSearch() {
  const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  if (!item?.uri)
    return;
  const title = item.name ?? "";
  const artist = item.artists?.[0]?.name ?? "";
  manualChart = false;
  currentSong = null;
  currentTrackId = item.uri;
  pickerCandidates = null;
  pickPending = null;
  pickError = null;
  resolving = true;
  Spicetify.showNotification?.(`\uD83D\uDD0E Searching USDB for “${title}”…`);
  if (!visible)
    setVisible(true);
  else
    renderOverlay();
  try {
    const res = await resolveForTrack(item.uri, artist, title, true);
    helperDown = false;
    if (res.status === "needsPicker") {
      pickerQuery = { artist, title };
      pickerCandidates = res.candidates;
    } else {
      Spicetify.showNotification?.(`No USDB matches for “${title}”`);
    }
  } catch (err) {
    console.error("[singify] search failed:", err);
    helperDown = await helperIsUnreachable(err);
    if (!helperDown) {
      Spicetify.showNotification?.(`Search failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  } finally {
    resolving = false;
  }
  if (visible)
    renderOverlay();
}
var fpsWanted = localStorage.getItem(FPS_KEY) !== "0";
var fpsEl = null;
var fpsRaf = 0;
var fpsLast = 0;
var fpsEma = 16.7;
var fpsAvg = 16.7;
var fpsWorst = 16.7;
function startFps() {
  if (fpsRaf)
    return;
  if (!fpsEl) {
    fpsEl = document.createElement("div");
    fpsEl.id = "singify-fps";
    Object.assign(fpsEl.style, {
      position: "fixed",
      right: "14px",
      bottom: "14px",
      zIndex: "2147483647",
      padding: "5px 10px",
      borderRadius: "6px",
      background: "rgba(0, 0, 0, 0.82)",
      color: "#7cfc00",
      font: "700 15px ui-monospace, SFMono-Regular, monospace",
      pointerEvents: "none"
    });
    document.body.appendChild(fpsEl);
  }
  fpsEl.style.display = "block";
  fpsLast = 0;
  const tick = () => {
    const now = performance.now();
    if (fpsLast) {
      const dt = now - fpsLast;
      fpsEma = fpsEma * 0.8 + dt * 0.2;
      fpsAvg = fpsAvg * 0.98 + dt * 0.02;
      fpsWorst = Math.max(dt, fpsWorst * 0.99);
    }
    fpsLast = now;
    if (fpsEl) {
      const f = (ms) => (1000 / ms).toFixed(0);
      fpsEl.textContent = `${f(fpsEma)} · avg ${f(fpsAvg)} · low ${f(fpsWorst)} fps`;
    }
    fpsRaf = requestAnimationFrame(tick);
  };
  fpsRaf = requestAnimationFrame(tick);
}
function stopFps() {
  if (fpsRaf) {
    cancelAnimationFrame(fpsRaf);
    fpsRaf = 0;
  }
  if (fpsEl)
    fpsEl.style.display = "none";
}
function toggleFps() {
  fpsWanted = !fpsWanted;
  try {
    localStorage.setItem(FPS_KEY, fpsWanted ? "1" : "0");
  } catch {}
  if (fpsWanted && visible)
    startFps();
  else
    stopFps();
  Spicetify.showNotification?.(`FPS meter ${fpsWanted ? "on" : "off"}`);
}
async function main() {
  const ready = () => !!Spicetify?.Player?.addEventListener && !!Spicetify?.React && !!Spicetify?.ReactDOM && !!Spicetify.Platform && !!document.querySelector(".Root__nav-bar, .main-topBar-container, .Root__main-view");
  while (!ready()) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));
  seedFromHelper().then((restored) => {
    if (restored.length === 0)
      return;
    defaultOffset = readNum(DEFAULT_OFFSET_KEY) ?? 0;
    offsetMs = loadOffsetForTrack(currentTrackId);
    sensitivity = loadSensitivity();
    difficulty = loadDifficulty();
    nowLineNudge = loadNowLineNudge();
    autoSkipNoChart = localStorage.getItem(AUTOSKIP_KEY) === "1";
    if (!session && mics.length === 0) {
      soloRoster = [newSlot(0, "P1")];
      setupRoster = [newSlot(0, "P1")];
      sessionRoster = [newSlot(0, "P1")];
    }
    if (visible)
      renderOverlay();
  });
  Spicetify.Player.addEventListener("onprogress", onProgress);
  Spicetify.Player.addEventListener("onplaypause", onPlayPause);
  Spicetify.Player.addEventListener("songchange", () => void onSongChange());
  const S = Spicetify;
  const MIC_ICON = '<svg role="img" height="16" width="16" viewBox="0 0 24 24" fill="currentColor">' + '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm6-3a6 6 0 0 1-5 5.916V21h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.084A6 6 0 0 1 6 12a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0z"/></svg>';
  if (S.Playbar?.Button) {
    if (!document.getElementById("singify-btn-css")) {
      const style = document.createElement("style");
      style.id = "singify-btn-css";
      style.textContent = ".singify-playbar-btn{margin-inline:8px}.singify-playbar-btn svg{width:22px;height:22px}";
      document.head.appendChild(style);
    }
    const btn = new S.Playbar.Button("Singify — sessions (K)", MIC_ICON, () => openHome());
    btn.element?.classList.add("singify-playbar-btn");
  } else if (S.Topbar?.Button) {
    new S.Topbar.Button("Singify sessions", "gamepad", () => openHome());
  }
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (typing)
      return;
    if (e.key === "k" || e.key === "K") {
      openHome();
    } else if (e.key === "q" || e.key === "Q") {
      openSing();
    } else if (e.key === "Escape") {
      if (visible)
        setVisible(false);
    } else if (e.code === "BracketLeft" || e.code === "BracketRight") {
      const step = e.ctrlKey ? 1 : e.shiftKey ? 100 : OFFSET_STEP;
      setOffset(offsetMs + (e.code === "BracketLeft" ? -step : step));
      e.preventDefault();
    } else if (e.key === "\\") {
      setOffset(0);
    } else if (e.key === "m" || e.key === "M") {
      toggleMics();
    } else if (e.key === "l" || e.key === "L") {
      loadLocalChart();
    } else if (e.key === "p" || e.key === "P") {
      punchSync();
    } else if (e.key === "r" || e.key === "R") {
      reSearch();
    } else if (e.key === "-") {
      setSensitivity(sensitivity - 5);
    } else if (e.key === "=") {
      setSensitivity(sensitivity + 5);
    } else if (e.key === ",") {
      setNowLineNudge(nowLineNudge - NOWLINE_STEP);
    } else if (e.key === ".") {
      setNowLineNudge(nowLineNudge + NOWLINE_STEP);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleFps();
    }
  }, true);
  onSongChange();
}
main();
