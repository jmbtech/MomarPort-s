/* ---------------------------------------------------------
   qr.js — draws a QR-look "sandbox" pattern for the demo
   wallet checkout screens.

   IMPORTANT: this does NOT encode real, scannable payment
   data — it's a deterministic visual pattern (same input text
   always draws the same pattern) styled to look like a QR
   code for the demo UI. It is intentionally paired with a
   "Sandbox" label everywhere it's shown so it's never mistaken
   for a real GCash merchant code.
--------------------------------------------------------- */

function seededRandom(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  }
  let state = h >>> 0 || 1;
  return function () {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function drawFakeQr(canvas, text) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const modules = 25;
  const cell = size / modules;
  const rand = seededRandom(text);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  function drawFinder(ox, oy) {
    ctx.fillStyle = '#0d1b26';
    ctx.fillRect(ox * cell, oy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((ox + 1) * cell, (oy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#0d1b26';
    ctx.fillRect((ox + 2) * cell, (oy + 2) * cell, 3 * cell, 3 * cell);
  }

  // Random-looking data modules, skipping the finder-pattern corners.
  for (let x = 0; x < modules; x++) {
    for (let y = 0; y < modules; y++) {
      const inTopLeft = x < 8 && y < 8;
      const inTopRight = x > modules - 9 && y < 8;
      const inBottomLeft = x < 8 && y > modules - 9;
      if (inTopLeft || inTopRight || inBottomLeft) continue;
      if (rand() > 0.55) {
        ctx.fillStyle = '#0d1b26';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(modules - 7, 0);
  drawFinder(0, modules - 7);
}
