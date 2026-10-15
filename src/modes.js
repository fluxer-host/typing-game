export const MODE_LIST = ["desktop", "mobile", "cursor"];

export const MODE_COLUMNS = {
  desktop: {
    elo: "elo_desktop",
    races: "races_desktop",
    wins: "wins_desktop",
    best: "best_wpm_desktop",
  },
  mobile: {
    elo: "elo_mobile",
    races: "races_mobile",
    wins: "wins_mobile",
    best: "best_wpm_mobile",
  },
  cursor: {
    elo: "elo_cursor",
    races: "races_cursor",
    wins: "wins_cursor",
    best: "best_wpm_cursor",
  },
};

export function isMode(value) {
  return Object.prototype.hasOwnProperty.call(MODE_COLUMNS, value);
}
