/**
 * hotkeys.ts — every Singify key, defined once. The ? / F1 card shows the long
 * text, the home menu's footer the short one, so neither list can fall behind.
 * Pure data — the key handler itself lives in index.ts.
 */

export interface Hotkey {
  keys: string;
  what: string; // for the shortcuts card
  short: string; // for the menu footer
}

export const HOTKEYS: Hotkey[] = [
  { keys: "K / S", what: "Sessions menu", short: "menu" },
  { keys: "Q", what: "Sing the current track (1 player, mic on)", short: "sing" },
  { keys: "M", what: "Mics on / off", short: "mic" },
  { keys: "R", what: "Restart the song", short: "restart" },
  { keys: "Shift+R", what: "Re-search USDB (pick another chart)", short: "re-choose" },
  { keys: "P", what: "Punch-sync: tap on the first sung word", short: "punch" },
  { keys: "Shift+P", what: "Mark “punched in proper” (locks P)", short: "mark punched" },
  { keys: "[ / ]", what: "Lyrics later / earlier (Shift ×10, Ctrl fine)", short: "offset" },
  { keys: "\\", what: "Reset sync", short: "reset sync" },
  { keys: "Enter", what: "Accept an auto-sync suggestion", short: "accept sync" },
  { keys: "- / =", what: "Mic sensitivity − / +", short: "sensitivity" },
  { keys: ", / .", what: "Hit-line nudge (visual)", short: "hit-line" },
  { keys: "L", what: "Load a local .txt chart", short: "load file" },
  { keys: "Ctrl+F", what: "FPS meter", short: "fps" },
  { keys: "Esc", what: "Close", short: "close" },
  { keys: "? / F1", what: "All shortcuts", short: "shortcuts" },
];
