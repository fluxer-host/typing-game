// SVG to PNG. @resvg/resvg-wasm is the renderer: social sites want a PNG,
// and Workers have no canvas. The wasm module is imported by share-wasm.js
// so the runtime can instantiate it. Fonts stay static assets.

import { Resvg, initWasm } from "@resvg/resvg-wasm";

let ready = null;

async function loadWasm(wasm) {
  if (!ready) {
    const pending = initWasm(wasm).then(() => true);
    ready = pending.catch((error) => {
      ready = null;
      throw error;
    });
  }
  await ready;
}

export async function renderCardPng(svg, { wasm, regular, bold }) {
  await loadWasm(wasm);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "#0e0e12",
    font: {
      fontBuffers: [regular.slice(), bold.slice()],
      defaultFontFamily: "Liberation Sans",
      sansSerifFamily: "Liberation Sans",
    },
  });
  try {
    const image = resvg.render();
    try {
      return { png: image.asPng(), width: image.width, height: image.height };
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
