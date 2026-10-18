// Imported as a module so workerd compiles it. Instantiating fetched wasm
// bytes is rejected with "Wasm code generation disallowed by embedder".

import wasm from "@resvg/resvg-wasm/index_bg.wasm";

export default wasm;
