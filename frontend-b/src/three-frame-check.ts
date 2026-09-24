import type { WebGLRenderer } from "three";

type FrameSample = { lastSample: number; frame: number; pixels: Uint8Array };
const samples = new WeakMap<WebGLRenderer, FrameSample>();

// Sample only the rendered framebuffer; diagnostics never inspect game state.
export function sampleFrame(renderer: WebGLRenderer): void {
  try {
    let sample = samples.get(renderer);
    if (!sample) {
      sample = { lastSample: -Infinity, frame: 0, pixels: new Uint8Array(32 * 32 * 4) };
      samples.set(renderer, sample);
    }
    sample.frame += 1;
    const now = performance.now();
    if (now - sample.lastSample < 1000) return;
    sample.lastSample = now;

    const gl = renderer.getContext();
    if (gl.isContextLost()) throw new Error("WebGL context unavailable");
    const width = Math.min(32, gl.drawingBufferWidth);
    const height = Math.min(32, gl.drawingBufferHeight);
    if (!width || !height) return;
    gl.readPixels(
      Math.floor((gl.drawingBufferWidth - width) / 2),
      Math.floor((gl.drawingBufferHeight - height) / 2),
      width, height, gl.RGBA, gl.UNSIGNED_BYTE, sample.pixels,
    );

    const colors = new Set<number>();
    let alpha = 0, visiblePixels = 0, hash = 0x811c9dc5;
    for (let index = 0; index < width * height * 4; index += 4) {
      const red = sample.pixels[index], green = sample.pixels[index + 1], blue = sample.pixels[index + 2], opacity = sample.pixels[index + 3];
      if (opacity) { colors.add((red << 16) | (green << 8) | blue); visiblePixels += 1; }
      alpha += opacity;
      for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ sample.pixels[index + channel], 0x01000193);
    }
    const data = renderer.domElement.dataset;
    data.renderColors = String(colors.size);
    data.renderAlpha = (alpha / (width * height)).toFixed(2);
    data.renderAlphaPixels = String(visiblePixels);
    data.renderFrame = String(sample.frame);
    data.renderHash = (hash >>> 0).toString(16).padStart(8, "0");
    data.renderCheck = "ok";
  } catch {
    renderer.domElement.dataset.renderCheck = "unavailable";
  }
}
