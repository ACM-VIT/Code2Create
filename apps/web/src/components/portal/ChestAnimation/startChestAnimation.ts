import { effect, frameLoop, init, sampler, surface } from "vgpu";

import chestShader from "./chest.wgsl?raw";

export const chestCardRevealAtMs = 3_500;

function getChestHalfSize(canvas: HTMLCanvasElement, chestArt: HTMLImageElement) {
  const viewportHeight = Math.max(canvas.getBoundingClientRect().height, 1);
  const chestBounds = chestArt.getBoundingClientRect();
  return [
    (chestBounds.width / viewportHeight) * 0.95,
    (chestBounds.height / viewportHeight) * 0.95,
  ] as const;
}

export async function startChestAnimation({
  canvas,
  chestArt,
  stopped,
  onReady,
  onReveal,
}: {
  canvas: HTMLCanvasElement;
  chestArt: HTMLImageElement;
  stopped: { current: boolean };
  onReady: () => void;
  onReveal: () => void;
}) {
  const gpu = await init();

  try {
    if (stopped.current) {
      gpu.dispose();
      return null;
    }

    const chestResponse = await fetch("/assets/magic-lucky-chest.webp");
    if (!chestResponse.ok) {
      throw new Error(`Could not load chest art (${chestResponse.status}).`);
    }

    const chestBitmap = await createImageBitmap(await chestResponse.blob());
    const uploadCanvas = document.createElement("canvas");
    uploadCanvas.width = chestBitmap.width;
    uploadCanvas.height = chestBitmap.height;
    const uploadContext = uploadCanvas.getContext("2d", { willReadFrequently: true });
    if (!uploadContext) {
      chestBitmap.close();
      throw new Error("Could not prepare chest texture pixels.");
    }

    uploadContext.drawImage(chestBitmap, 0, 0);
    const sourcePixels = uploadContext.getImageData(
      0,
      0,
      chestBitmap.width,
      chestBitmap.height,
    ).data;
    const bytesPerRow = Math.ceil((chestBitmap.width * 4) / 256) * 256;
    const texturePixels = new Uint8Array(bytesPerRow * chestBitmap.height);
    for (let row = 0; row < chestBitmap.height; row += 1) {
      const sourceStart = row * chestBitmap.width * 4;
      texturePixels.set(
        sourcePixels.subarray(sourceStart, sourceStart + chestBitmap.width * 4),
        row * bytesPerRow,
      );
    }

    const textureUsage = {
      copyDestination: 0x02,
      textureBinding: 0x04,
    } as const;
    const chestTexture = gpu.gpu.createTexture({
      label: "official-lucky-chest-art",
      size: [chestBitmap.width, chestBitmap.height, 1],
      format: "rgba8unorm-srgb",
      usage: textureUsage.textureBinding | textureUsage.copyDestination,
    });
    gpu.gpu.queue.writeTexture(
      { texture: chestTexture },
      texturePixels,
      { bytesPerRow, rowsPerImage: chestBitmap.height },
      [chestBitmap.width, chestBitmap.height, 1],
    );
    chestBitmap.close();

    const output = surface(gpu, canvas, {
      alphaMode: "premultiplied",
      clearColor: [0, 0, 0, 0],
      dpr: [1, 2],
    });
    const chestSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const scene = effect(gpu, chestShader, {
      set: {
        params: {
          resolution: output.size,
          chestHalfSize: getChestHalfSize(canvas, chestArt),
          time: 0,
          intensity: 1,
        },
        chestTexture,
        chestSampler,
      },
    });

    output.onResize(() => {
      scene.set({
        params: {
          resolution: output.size,
          chestHalfSize: getChestHalfSize(canvas, chestArt),
        },
      });
    });

    const startedAt = performance.now();
    let ready = false;
    let revealed = false;
    const loop = frameLoop(gpu, (frame) => {
      const sequenceTime = Math.min((performance.now() - startedAt) / 1_000, 4.05);
      scene.set({ params: { time: sequenceTime } });
      frame.pass(output, scene);

      if (!ready) {
        ready = true;
        onReady();
      }
      if (!revealed && sequenceTime * 1_000 >= chestCardRevealAtMs) {
        revealed = true;
        onReveal();
      }
    });

    return () => {
      loop.stop();
      chestTexture.destroy();
      gpu.dispose();
    };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}
