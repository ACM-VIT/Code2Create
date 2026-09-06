import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  admissionResultUsesChest,
  type AdmissionResultOutcome,
} from "../../lib/admissionResultReveal";
import { Petal } from "./Petal";
import { PortalButton } from "./PortalButton";
import { PortalScene } from "./PortalScene";
import chestShader from "./chest.wgsl?raw";
import "./admission-result-reveal.css";

const cardRevealAtMs = 3_500;
const fallbackStartupAfterMs = 1_500;
const fallbackDurationMs = 1_400;

const vertexShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let point = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  )[index];
  var output: VertexOutput;
  output.position = vec4f(point, 0.0, 1.0);
  output.uv = point * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}
`;

const horizontalPetals = Array.from({ length: 17 }, (_, index) => {
  const left = `${index * 6.25}%`;
  const size = 42 + (index % 4) * 5;
  return [
    { left, top: "-7%", rotation: -52 + index * 19, size, delay: -(index % 6) * 0.24 },
    {
      left,
      top: "92%",
      rotation: 128 + index * 17,
      size: size + (index % 2) * 4,
      delay: -((index + 3) % 7) * 0.21,
    },
  ];
}).flat();

const verticalPetals = Array.from({ length: 9 }, (_, index) => {
  const top = `${8 + index * 10.5}%`;
  const size = 44 + (index % 3) * 6;
  return [
    { left: "-5%", top, rotation: 208 + index * 23, size, delay: -(index % 5) * 0.27 },
    {
      left: "94%",
      top,
      rotation: 32 + index * 21,
      size: size + (index % 2) * 3,
      delay: -((index + 2) % 6) * 0.23,
    },
  ];
}).flat();

const selectedCardPetals = [...horizontalPetals, ...verticalPetals];

const resultCopy: Record<
  AdmissionResultOutcome,
  { heading: string; message: (teamName: string) => string; action: string }
> = {
  selected: {
    heading: "You are selected for this hack!",
    message: (teamName) => `${teamName}, your team made the Code2Create shortlist.`,
    action: "See what’s next",
  },
  waitlisted: {
    heading: "You’re on the waitlist.",
    message: (teamName) => `${teamName} is still in consideration. We’ll share an update if a place opens.`,
    action: "View your status",
  },
  not_selected: {
    heading: "Better luck next time",
    message: (teamName) => `Thank you, ${teamName}, for sharing your idea with Code2Create.`,
    action: "Continue",
  },
};

function chestHalfSize(canvas: HTMLCanvasElement, chestArt: HTMLImageElement) {
  const viewportHeight = Math.max(canvas.getBoundingClientRect().height, 1);
  const chestBounds = chestArt.getBoundingClientRect();
  return [
    (chestBounds.width / viewportHeight) * 0.95,
    (chestBounds.height / viewportHeight) * 0.95,
  ] as const;
}

async function startChestAnimation(args: {
  canvas: HTMLCanvasElement;
  chestArt: HTMLImageElement;
  stopped: { current: boolean };
  onReady: () => void;
  onReveal: () => void;
}) {
  const gpu = navigator.gpu;
  if (!gpu || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;

  const adapter = await gpu.requestAdapter();
  if (!adapter || args.stopped.current) return null;
  const device = await adapter.requestDevice();
  if (args.stopped.current) {
    device.destroy();
    return null;
  }

  const context = args.canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return null;
  }

  const chestResponse = await fetch("/assets/magic-lucky-chest.webp");
  if (!chestResponse.ok) {
    device.destroy();
    throw new Error(`Could not load chest art (${chestResponse.status}).`);
  }
  const chestBitmap = await createImageBitmap(await chestResponse.blob());
  const uploadCanvas = document.createElement("canvas");
  uploadCanvas.width = chestBitmap.width;
  uploadCanvas.height = chestBitmap.height;
  const uploadContext = uploadCanvas.getContext("2d", { willReadFrequently: true });
  if (!uploadContext) {
    chestBitmap.close();
    device.destroy();
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
  const chestTexture = device.createTexture({
    label: "code2create-result-chest",
    size: [chestBitmap.width, chestBitmap.height, 1],
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: chestTexture },
    texturePixels,
    { bytesPerRow, rowsPerImage: chestBitmap.height },
    [chestBitmap.width, chestBitmap.height, 1],
  );
  chestBitmap.close();

  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });
  const shader = device.createShaderModule({ code: `${chestShader}\n${vertexShader}` });
  const pipeline = await device.createRenderPipelineAsync({
    label: "code2create-result-chest-pipeline",
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs_main" },
    fragment: { module: shader, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const uniforms = device.createBuffer({
    label: "code2create-result-chest-uniforms",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const chestSampler = device.createSampler({
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: chestTexture.createView() },
      { binding: 2, resource: chestSampler },
    ],
  });
  const uniformValues = new Float32Array(8);

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(args.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(args.canvas.clientHeight * dpr));
    if (args.canvas.width !== width || args.canvas.height !== height) {
      args.canvas.width = width;
      args.canvas.height = height;
    }
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(args.canvas);

  let frame = 0;
  let disposed = false;
  let revealed = false;
  const startedAt = performance.now();
  const stop = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    uniforms.destroy();
    chestTexture.destroy();
    device.destroy();
  };
  const render = () => {
    if (args.stopped.current || !args.canvas.isConnected) {
      stop();
      return;
    }
    resize();
    const elapsedMs = performance.now() - startedAt;
    const [halfWidth, halfHeight] = chestHalfSize(args.canvas, args.chestArt);
    uniformValues[0] = args.canvas.width;
    uniformValues[1] = args.canvas.height;
    uniformValues[2] = halfWidth;
    uniformValues[3] = halfHeight;
    uniformValues[4] = elapsedMs / 1_000;
    uniformValues[5] = 1;
    device.queue.writeBuffer(uniforms, 0, uniformValues);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    args.onReady();

    if (!revealed && elapsedMs >= cardRevealAtMs) {
      revealed = true;
      args.onReveal();
    }
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);
  return stop;
}

export function AdmissionResultReveal({
  outcome,
  eventName,
  teamName,
  header,
  onSignOut,
  onContinue,
}: {
  outcome: AdmissionResultOutcome;
  eventName: string;
  teamName: string;
  header?: ReactNode;
  onSignOut?: () => void;
  onContinue: () => void;
}) {
  const showsChest = admissionResultUsesChest(outcome);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chestArtRef = useRef<HTMLImageElement>(null);
  const [revealed, setRevealed] = useState(!showsChest);
  const [fallback, setFallback] = useState(false);
  const copy = resultCopy[outcome];
  const reveal = useCallback(() => setRevealed(true), []);

  useEffect(() => {
    if (!showsChest) return;
    const canvas = canvasRef.current;
    const chestArt = chestArtRef.current;
    if (!canvas || !chestArt) return;
    chestArt.style.opacity = "1";
    const stopped = { current: false };
    let cleanup: (() => void) | undefined;
    let usingFallback = false;
    let startupTimer = 0;
    let fallbackTimer = 0;
    const beginFallback = () => {
      if (stopped.current || usingFallback) return;
      usingFallback = true;
      setFallback(true);
      fallbackTimer = window.setTimeout(reveal, fallbackDurationMs);
    };
    startupTimer = window.setTimeout(beginFallback, fallbackStartupAfterMs);
    void startChestAnimation({
      canvas,
      chestArt,
      stopped,
      onReady: () => {
        if (!usingFallback) chestArt.style.opacity = "0";
      },
      onReveal: reveal,
    })
      .then((stop) => {
        if (stopped.current) {
          stop?.();
          return;
        }
        window.clearTimeout(startupTimer);
        if (usingFallback) {
          stop?.();
          return;
        }
        if (stop) {
          cleanup = stop;
          return;
        }
        beginFallback();
      })
      .catch((error: unknown) => {
        console.error("Could not start the admission result chest", error);
        window.clearTimeout(startupTimer);
        beginFallback();
      });
    return () => {
      stopped.current = true;
      window.clearTimeout(startupTimer);
      window.clearTimeout(fallbackTimer);
      cleanup?.();
    };
  }, [reveal, showsChest]);

  return (
    <PortalScene
      tree="both"
      header={header}
      {...(onSignOut ? { onSignOut } : {})}
      logoGlow
      fill
    >
      <section
        className={`admission-result-reveal admission-result-reveal--${outcome} ${
          fallback ? "admission-result-reveal--fallback" : ""
        }`}
        aria-label={`Admission result for ${teamName}`}
      >
        {showsChest && !revealed ? (
          <>
            <canvas ref={canvasRef} aria-hidden className="admission-result-reveal__canvas" />
            <img
              ref={chestArtRef}
              src="/assets/magic-lucky-chest.webp"
              alt=""
              draggable={false}
              className="admission-result-reveal__chest"
            />
            <p className="sr-only" role="status" aria-live="polite">
              Opening your Code2Create result.
            </p>
          </>
        ) : null}

        {revealed ? (
          <div className="admission-result-reveal__card-wrap">
            <div
              className={`admission-result-reveal__card admission-result-reveal__card--${
                showsChest ? "petals" : "quiet"
              }`}
              role="status"
            >
              {showsChest ? (
                <div aria-hidden className="admission-result-reveal__petal-frame">
                  {selectedCardPetals.map((petal, index) => (
                    <span
                      key={`${petal.left}-${petal.top}-${index}`}
                      className="admission-result-reveal__frame-petal"
                      style={{
                        left: petal.left,
                        top: petal.top,
                        rotate: `${petal.rotation}deg`,
                        animationDelay: `${petal.delay}s`,
                      }}
                    >
                      <Petal
                        size={petal.size}
                        state={index % 7 === 0 ? "current" : "done"}
                      />
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="admission-result-reveal__content">
                <h1>{copy.heading}</h1>
                <p className="admission-result-reveal__message">{copy.message(teamName)}</p>
                <p className="admission-result-reveal__event">{eventName}</p>
                <PortalButton
                  type="button"
                  variant="solid"
                  className="relative z-10 mt-6"
                  onClick={onContinue}
                >
                  {copy.action}
                </PortalButton>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </PortalScene>
  );
}
