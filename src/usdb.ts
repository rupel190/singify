/**
 * usdb.ts — USDB (usdb.animux.de) client
 *
 * USDB has no public API. It's a PHP site gated behind a session cookie.
 * All endpoints take form-encoded POSTs and return HTML.
 *
 * Flow:
 *   1. login(user, pass)   → stores PHPSESSID cookie in the shared cookieJar
 *   2. search(artist, title) → POST /?link=list → scrape HTML → Song[]
 *   3. downloadTxt(id)       → POST /?link=gettxt&id=N → raw .txt content
 */

const BASE = "https://usdb.animux.de";

// ── Types ──────────────────────────────────────────────────────────────────

export interface USDBSong {
  id: number;
  artist: string;
  title: string;
  edition: string;
  golden: boolean;       // has golden notes
  language: string;
  rating: number;        // 0–5 in 0.5 steps
  views: number;
}

export interface SearchResult {
  songs: USDBSong[];
  paging: { current: number; pages: number };
}

// ── Cookie jar (simple; Spicetify runs in Electron so no tough-cookie needed) ──

let sessionCookie = "";   // "PHPSESSID=<value>"

function cookieHeader(): Record<string, string> {
  return sessionCookie ? { Cookie: sessionCookie } : {};
}

function extractSessionCookie(headers: Headers): void {
  // Set-Cookie: PHPSESSID=abc123; path=/; ...
  const raw = headers.get("set-cookie") ?? "";
  const match = raw.match(/PHPSESSID=([^;]+)/);
  if (match) sessionCookie = `PHPSESSID=${match[1]}`;
}

// ── Auth ───────────────────────────────────────────────────────────────────

/**
 * Login to USDB. Returns true on success, false on bad credentials.
 * Stores the session cookie for subsequent calls.
 */
export async function login(username: string, password: string): Promise<boolean> {
  const body = new URLSearchParams({
    user: username,
    pass: password,
    login: "Login",
  });

  const res = await fetch(`${BASE}/?link=home`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeader(),
    },
    body: body.toString(),
    redirect: "follow",
  });

  extractSessionCookie(res.headers);

  // Verify we're actually in
  const checkRes = await fetch(`${BASE}/?link=browse`, {
    headers: cookieHeader(),
  });
  const html = await checkRes.text();
  return !html.includes("You are not logged in");
}

/**
 * Returns true if we currently have a live session.
 */
export async function isLoggedIn(): Promise<boolean> {
  if (!sessionCookie) return false;
  const res = await fetch(`${BASE}/?link=browse`, { headers: cookieHeader() });
  return !(await res.text()).includes("You are not logged in");
}

// ── Search ─────────────────────────────────────────────────────────────────

export interface SearchOptions {
  artist?: string;
  title?: string;
  edition?: string;
  language?: string;
  genre?: string;
  order?: "id" | "artist" | "title" | "edition" | "rating" | "language" | "views" | "golden";
  direction?: "asc" | "desc";
  golden?: boolean;
  limit?: number;
  page?: number;
}

/**
 * Search USDB for songs matching artist/title.
 * Scrapes the HTML table returned by /?link=list.
 */
export async function search(opts: SearchOptions): Promise<SearchResult> {
  const {
    artist = "",
    title = "",
    edition = "",
    language = "",
    genre = "",
    order = "rating",
    direction = "desc",
    golden = false,
    limit = 30,
    page = 1,
  } = opts;

  const body = new URLSearchParams({
    interpret: artist,
    title,
    edition,
    language,
    genre,
    order,
    ud: direction,
    limit: String(limit),
    start: String((page - 1) * limit),
  });
  if (golden) body.set("golden", "1");

  const res = await fetch(`${BASE}/?link=list`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeader(),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`USDB search failed: HTTP ${res.status}`);
  }

  const html = await res.text();
  return parseSearchHtml(html, page);
}

// ── HTML scraper ───────────────────────────────────────────────────────────

/**
 * Parses the HTML table from /?link=list into structured song data.
 *
 * Each result row is `<tr ... data-songid="N" ...>` with these <td> columns
 * (confirmed against the live site 2026-07): 0 Artist, 1 Title, 2 Genre,
 * 3 Year, 4 Edition, 5 Golden Notes ("Yes"/"No"), 6 Language, 7 Creator,
 * 8 Rating (star.png / half_star.png / star2.png images), 9 Views. The id is
 * taken from the row's `data-songid` attribute (the old `ShowDetail(id)`
 * onclick is gone — rows now call `show_detail(id)`).
 *
 * Uses lightweight regex scraping — no DOM parser needed in Bun/Node context.
 * Exported for unit testing against captured markup (this is what rots).
 */
export function parseSearchHtml(html: string, currentPage: number): SearchResult {
  const songs: USDBSong[] = [];

  // ── Pagination ── "There are  N  results on  M page(s)"
  let totalPages = currentPage;
  const pageMatch = html.match(/on\s+(\d+)\s+page\(s\)/i);
  if (pageMatch) {
    const parsed = parseInt(pageMatch[1], 10);
    if (!isNaN(parsed)) totalPages = Math.max(totalPages, parsed);
  }

  // ── Row extraction ── anchor on data-songid, then read the <td> cells in order
  const rowPattern = /<tr[^>]*\bdata-songid="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;

  for (const rowMatch of html.matchAll(rowPattern)) {
    const id = parseInt(rowMatch[1], 10);
    const cells = [...rowMatch[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    const text = (i: number): string =>
      stripTags(cells[i]?.[1] ?? "").replace(/\s+/g, " ").trim();

    const artist = text(0);
    const title = text(1);
    if (!artist && !title) continue; // action-only / malformed row

    const edition = text(4);
    const golden = /^(yes|ja)$/i.test(text(5));
    const language = text(6);

    // Rating: full = images/star.png, half = images/half_star.png. Match the
    // full path so "star.png" doesn't also count "half_star.png" / "star2.png".
    const ratingCell = cells[8]?.[1] ?? "";
    const fullStars = (ratingCell.match(/images\/star\.png/g) ?? []).length;
    const halfStars = (ratingCell.match(/images\/half_star\.png/g) ?? []).length;
    const rating = fullStars + halfStars * 0.5;

    const views = parseInt(text(9).replace(/\D/g, ""), 10) || 0;

    songs.push({ id, artist, title, edition, golden, language, rating, views });
  }

  return {
    songs,
    paging: { current: currentPage, pages: totalPages },
  };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

// ── Download ───────────────────────────────────────────────────────────────

/**
 * Downloads the UltraStar .txt content for a given USDB song ID.
 * Requires an active session (call login() first).
 *
 * The gettxt endpoint needs `wd=1` ("with download") — without it USDB returns
 * a confirmation page, not the chart. The chart comes back embedded in an
 * HTML <textarea> (HTML-escaped), so we extract and unescape it.
 */
export async function downloadTxt(id: number): Promise<string> {
  const res = await fetch(`${BASE}/index.php?link=gettxt&id=${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeader(),
    },
    body: `wd=1&id=${id}`,
  });

  if (!res.ok) {
    throw new Error(`USDB download failed for id=${id}: HTTP ${res.status}`);
  }

  const html = await res.text();

  // An expired session yields the "not logged in" page instead of the chart.
  if (/not logged in/i.test(html)) {
    throw new Error("USDB session expired — please re-login");
  }

  const txt = extractTextarea(html);
  if (!txt || (!txt.includes("#TITLE:") && !txt.includes("#ARTIST:"))) {
    throw new Error(`USDB returned unexpected content for id=${id}`);
  }
  return txt;
}

/** Pull the chart out of USDB's `<textarea>` wrapper and unescape HTML entities. */
export function extractTextarea(html: string): string | null {
  const m = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  if (!m) return null;
  // A <textarea>'s leading newline is a rendering artifact — strip it so the
  // parser sees #TITLE on line 1 (parseHeaders stops at the first non-# line).
  return unescapeHtml(m[1]).replace(/^\s+/, "");
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&amp;/g, "&"); // ampersand last, or "&amp;lt;" would double-unescape
}
