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
 * Row structure (non-header .row1 table rows):
 *   td[0] → artist  (onclick="ShowDetail(ID)")
 *   td[1] → title
 *   td[2] → edition
 *   td[3] → "Ja"/"Nein" for golden notes
 *   td[4] → language
 *   td[5] → star images (star.png / half_star.png)
 *   td[6] → view count
 *
 * Uses lightweight regex scraping — no DOM parser needed in Bun/Node context.
 */
function parseSearchHtml(html: string, currentPage: number): SearchResult {
  const songs: USDBSong[] = [];

  // ── Pagination ──
  // Last page number appears in links like (30) at the end of pagination
  let totalPages = currentPage;
  const pageLinks = [...html.matchAll(/\((\d+)\)/g)];
  if (pageLinks.length > 0) {
    const last = pageLinks[pageLinks.length - 1];
    const parsed = parseInt(last[1], 10);
    if (!isNaN(parsed)) totalPages = Math.max(totalPages, parsed);
  }

  // ── Row extraction ──
  // Each data row opens with an onclick on the first td
  const rowPattern =
    /onclick="ShowDetail\((\d+)\)"[^>]*>(.*?)<\/td>(.*?)<\/tr>/gs;

  for (const rowMatch of html.matchAll(rowPattern)) {
    const id = parseInt(rowMatch[1], 10);
    const firstTd = rowMatch[2];
    const rest = rowMatch[3];

    const tds = [...rest.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      stripTags(m[1]).trim()
    );

    if (tds.length < 6) continue;  // malformed row, skip

    const artist = stripTags(firstTd).trim();
    const title = tds[0];
    const edition = tds[1];
    const golden = tds[2].toLowerCase() === "ja";
    const language = tds[3];

    // Rating: count star.png and half_star.png images in td[4]
    const ratingBlock = [...rest.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][4]?.[0] ?? "";
    const fullStars = (ratingBlock.match(/star\.png/g) ?? []).length;
    const halfStars = (ratingBlock.match(/half_star\.png/g) ?? []).length;
    const rating = fullStars + halfStars * 0.5;

    const views = parseInt(tds[5].replace(/\D/g, ""), 10) || 0;

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
 * Downloads the raw UltraStar .txt content for a given USDB song ID.
 * Requires an active session (call login() first).
 *
 * USDB returns the .txt file as the raw POST response body.
 */
export async function downloadTxt(id: number): Promise<string> {
  const res = await fetch(`${BASE}/index.php?link=gettxt&id=${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeader(),
    },
    body: `id=${id}`,
  });

  if (!res.ok) {
    throw new Error(`USDB download failed for id=${id}: HTTP ${res.status}`);
  }

  const text = await res.text();

  // USDB sometimes returns an error page instead of a .txt
  if (text.includes("You are not logged in")) {
    throw new Error("USDB session expired — please re-login");
  }
  if (!text.includes("#TITLE:") && !text.includes("#ARTIST:")) {
    throw new Error(`USDB returned unexpected content for id=${id}`);
  }

  return text;
}
