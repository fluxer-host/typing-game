// Plain SVG pace chart. Coordinates stay in the viewBox; CSS sets the size.

function round(value) {
  return Math.round(value * 10) / 10;
}

export function chartPoints(runs, options = {}) {
  const width = Number.isFinite(options.width) ? options.width : 320;
  const height = Number.isFinite(options.height) ? options.height : 120;
  const pad = Number.isFinite(options.pad) ? options.pad : 12;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 30;
  const list = (Array.isArray(runs) ? runs : [])
    .filter((run) => Number.isFinite(Number(run?.wpm)))
    .slice(-limit);
  if (!list.length) return { empty: true, width, height, points: [], line: "", max: 0 };
  const values = list.map((run) => Number(run.wpm));
  const max = Math.max(...values, 1);
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  const points = list.map((run, index) => {
    const x = list.length === 1 ? width / 2 : pad + (innerW * index) / (list.length - 1);
    const y = pad + innerH * (1 - Number(run.wpm) / max);
    return { x: round(x), y: round(y), wpm: Number(run.wpm) };
  });
  const line = points.length >= 2 ? points.map((point) => `${point.x},${point.y}`).join(" ") : "";
  return { empty: false, width, height, points, line, max };
}

export function trendSvg(geometry) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "trend-svg");
  svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", "trend-title");
  svg.setAttribute("aria-describedby", "trend-table");
  if (geometry.empty || !geometry.points.length) return svg;
  if (geometry.line) {
    const poly = document.createElementNS(svg.namespaceURI, "polyline");
    poly.setAttribute("class", "trend-line");
    poly.setAttribute("points", geometry.line);
    svg.append(poly);
  }
  for (const point of geometry.points) {
    const dot = document.createElementNS(svg.namespaceURI, "circle");
    dot.setAttribute("class", "trend-dot");
    dot.setAttribute("cx", String(point.x));
    dot.setAttribute("cy", String(point.y));
    dot.setAttribute("r", "3");
    svg.append(dot);
  }
  return svg;
}
