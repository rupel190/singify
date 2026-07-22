import { describe, test, expect } from "bun:test";
import { parseSearchHtml, extractTextarea } from "./usdb";

// Captured from the live site (2026-07). One data row, trimmed to the shape the
// scraper depends on: data-songid + the 11 <td> columns.
const SEARCH_HTML = `
<br>There are  2  results on  1 page(s)
<table>
<tr class="list_head"><td>Artist</td><td>Title</td><td>Genre</td><td>Year</td><td>Edition</td><td>Golden Notes</td><td>Language</td><td>Creator</td><td>Rating</td><td>Views</td><td>&nbsp;</td>
<tr class="list_tr2" data-songid="7030" data-lastchange="1759960131" onmouseover="this.className='list_hover'"><td onclick="show_detail(7030)">Jonathan Coulton</td>
<td onclick="show_detail(7030)"><a href="?link=detail&id=7030">Code Monkey</td>
<td onclick="show_detail(7030)"></td>
<td onclick="show_detail(7030)">2006</td>
<td onclick="show_detail(7030)">TW</td>
<td onclick="show_detail(7030)">Yes</td>
<td onclick="show_detail(7030)">English</td>
<td onclick="show_detail(7030)">strudel</td>
<td onclick="show_detail(7030)"><img src="images/star.png"> <img src="images/star.png"> <img src="images/star.png"> <img src="images/star.png"> <img src="images/star2.png"> </td>
<td onclick="show_detail(7030)">451</td>
<td><a href="#" onClick="addToList(7030, 1)"><img src="images/mini-zip.png"></a></td>
</tr>
<tr class="list_tr1" data-songid="20519"><td onclick="show_detail(20519)">Jonathan Coulton</td>
<td onclick="show_detail(20519)"><a href="?link=detail&id=20519">Code Monkey [DUET]</td>
<td></td><td>2006</td><td></td><td>No</td><td>English</td><td>bob</td>
<td><img src="images/half_star.png"> </td><td>353</td><td></td></tr>
</table>`;

describe("parseSearchHtml", () => {
  const { songs, paging } = parseSearchHtml(SEARCH_HTML, 1);

  test("extracts every result row by data-songid", () => {
    expect(songs.map((s) => s.id)).toEqual([7030, 20519]);
  });

  test("maps the shifted columns correctly", () => {
    const cm = songs[0];
    expect(cm.artist).toBe("Jonathan Coulton");
    expect(cm.title).toBe("Code Monkey");
    expect(cm.edition).toBe("TW");
    expect(cm.golden).toBe(true); // "Yes"
    expect(cm.language).toBe("English");
    expect(cm.views).toBe(451);
  });

  test("counts stars without letting star.png match half_star.png/star2.png", () => {
    expect(songs[0].rating).toBe(4); // 4× star.png + 1× star2.png (empty)
    expect(songs[1].rating).toBe(0.5); // 1× half_star.png
    expect(songs[1].golden).toBe(false); // "No"
  });

  test("reads pagination from the results line", () => {
    expect(paging.pages).toBe(1);
  });
});

describe("extractTextarea", () => {
  test("pulls the chart out of the textarea, unescapes, strips the lead newline", () => {
    const html = `<html><body><textarea name="txt" rows="30">
#TITLE:A &amp; B&lt;test&gt;
#BPM:200
: 0 4 0 la
E
</textarea></body></html>`;
    const txt = extractTextarea(html)!;
    expect(txt.startsWith("#TITLE:")).toBe(true); // leading newline stripped
    expect(txt).toContain("#TITLE:A & B<test>"); // entities unescaped
    expect(txt).toContain("#BPM:200");
  });

  test("returns null when there is no textarea (confirmation/error page)", () => {
    expect(extractTextarea("<html><body>Are you sure?</body></html>")).toBeNull();
  });
});
