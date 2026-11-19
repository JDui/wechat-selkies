/* Reusable cropped mip levels. Gaussian runs at quarter resolution, once per
   sample, rather than filtering a full-size remote image on every UI repaint. */
(() => {
  const levels = [document.createElement("canvas"), document.createElement("canvas")];
  const padded = document.createElement("canvas");
  const outputs = [document.createElement("canvas"), document.createElement("canvas")];
  function context(canvas, width, height) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d", {alpha: false});
    ctx.filter = "none";
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return ctx;
  }
  window.__AXIVER_FROST__ = {
    render(image, frame, layout) {
      const start = performance.now();
      if (![frame.width, frame.height, layout.viewX, layout.viewY, layout.width, layout.height].every(Number.isFinite)
          || frame.width <= 0 || frame.height <= 0 || !image.naturalWidth || !image.naturalHeight) return null;
      // Keep the visible material outside the Gaussian's three-sigma support.
      const margin = 48;
      const x = Math.max(0, layout.viewX - margin);
      const y = Math.max(0, layout.viewY - margin);
      const width = Math.min(frame.width - x, Math.max(layout.width, 260) + margin * 2);
      const height = Math.min(frame.height - y, layout.height + margin * 2);
      if (width <= 0 || height <= 0) return null;
      const sx = image.naturalWidth / frame.width, sy = image.naturalHeight / frame.height;
      // Two successive 2x reductions avoid aliasing from a single large resize.
      let w = Math.max(1, Math.ceil(width / 2)), h = Math.max(1, Math.ceil(height / 2));
      context(levels[0], w, h).drawImage(image, x * sx, y * sy, width * sx, height * sy, 0, 0, w, h);
      w = Math.max(1, Math.ceil(width / 4)); h = Math.max(1, Math.ceil(height / 4));
      context(levels[1], w, h).drawImage(levels[0], 0, 0, w, h);
      // Clamp the source at every edge, including when the remote viewport
      // clips the crop. Filtering an unpadded image over an opaque canvas
      // otherwise blends black into the first frame after every resize.
      const pad = Math.ceil(3 * 12 * w / width) + 2;
      const padding = context(padded, w + pad * 2, h + pad * 2);
      const axis = size => [[0, 1, 0, pad], [0, size, pad, size], [size - 1, 1, pad + size, pad]];
      for (const [sx, sw, dx, dw] of axis(w)) {
        for (const [sy, sh, dy, dh] of axis(h)) {
          padding.drawImage(levels[1], sx, sy, sw, sh, dx, dy, dw, dh);
        }
      }
      const urls = [12, 7.2].map((radius, index) => {
        const ctx = context(outputs[index], w, h);
        ctx.filter = `blur(${radius * w / width}px) saturate(${index ? 120 : 125}%)`;
        ctx.drawImage(padded, -pad, -pad);
        ctx.filter = "none";
        return outputs[index].toDataURL("image/png");
      });
      return {src: urls[0], pillSrc: urls[1], x, y, width, height,
        sampleWidth: w, sampleHeight: h, processingMs: performance.now() - start};
    }
  };
})();
