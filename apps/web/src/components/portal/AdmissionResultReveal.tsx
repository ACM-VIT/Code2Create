import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { AdmissionResultOutcome } from "../../lib/admissionResultReveal";
import { Petal } from "./Petal";
import { PortalButton } from "./PortalButton";
import { PortalScene } from "./PortalScene";
import chestShader from "./chest.wgsl?raw";
import "./admission-result-reveal.css";

const sequenceDurationMs = 4_050;
const cardRevealAtMs = 3_500;

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

const framePetals = [
  { left: "2%", top: "-14px", rotation: -38, size: 28, delay: -0.4 },
  { left: "14%", top: "-19px", rotation: 18, size: 23, delay: -1.1 },
  { left: "28%", top: "-13px", rotation: 52, size: 30, delay: -1.8 },
  { left: "44%", top: "-20px", rotation: -9, size: 25, delay: -0.8 },
  { left: "61%", top: "-14px", rotation: 31, size: 29, delay: -1.5 },
  { left: "78%", top: "-18px", rotation: -55, size: 24, delay: -0.2 },
  { left: "94%", top: "-10px", rotation: 17, size: 27, delay: -1.3 },
  { left: "100%", top: "20%", rotation: 68, size: 25, delay: -0.6 },
  { left: "98%", top: "48%", rotation: 112, size: 30, delay: -1.7 },
  { left: "100%", top: "76%", rotation: 74, size: 24, delay: -1 },
  { left: "91%", top: "95%", rotation: 142, size: 29, delay: -0.3 },
  { left: "72%", top: "98%", rotation: 194, size: 24, delay: -1.4 },
  { left: "51%", top: "96%", rotation: 156, size: 30, delay: -0.7 },
  { left: "31%", top: "99%", rotation: 213, size: 23, delay: -1.9 },
  { left: "11%", top: "94%", rotation: 170, size: 29, delay: -1.2 },
  { left: "-3%", top: "78%", rotation: 248, size: 25, delay: -0.5 },
  { left: "-5%", top: "50%", rotation: 286, size: 30, delay: -1.6 },
  { left: "-3%", top: "21%", rotation: 235, size: 24, delay: -0.9 },
] as const;

const resultCopy: Record<
  AdmissionResultOutcome,
  { eyebrow: string; heading: string; message: (teamName: string) => string; action: string }
> = {
  selected: {
    eyebrow: "The shortlist is here",
    heading: "You are selected for this hack!",
    message: (teamName) => `${teamName}, your team made the Code2Create shortlist.`,
    action: "See what’s next",
  },
  waitlisted: {
    eyebrow: "Your result is here",
    heading: "You’re on the waitlist.",
    message: (teamName) => `${teamName} is still in consideration. We’ll share an update if a place opens.`,
    action: "View your status",
  },
  not_selected: {
    eyebrow: "Your result is here",
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
  context.configure({ device, format, alphaMode: "opaque" });
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
    const elapsedMs = Math.min(performance.now() - startedAt, sequenceDurationMs);
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
          clearValue: { r: 0.027, g: 0.106, b: 0.325, a: 1 },
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
    if (elapsedMs < sequenceDurationMs) frame = requestAnimationFrame(render);
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chestArtRef = useRef<HTMLImageElement>(null);
  const [sequence, setSequence] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [fallback, setFallback] = useState(false);
  const copy = resultCopy[outcome];
  const reveal = useCallback(() => setRevealed(true), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const chestArt = chestArtRef.current;
    if (!canvas || !chestArt) return;
    const stopped = { current: false };
    let cleanup: (() => void) | undefined;
    let fallbackTimer = 0;
    void startChestAnimation({
      canvas,
      chestArt,
      stopped,
      onReady: () => {
        chestArt.style.opacity = "0";
      },
      onReveal: reveal,
    })
      .then((stop) => {
        if (stopped.current) {
          stop?.();
          return;
        }
        if (stop) {
          cleanup = stop;
          return;
        }
        setFallback(true);
        fallbackTimer = window.setTimeout(reveal, 700);
      })
      .catch((error: unknown) => {
        console.error("Could not start the admission result chest", error);
        if (stopped.current) return;
        setFallback(true);
        fallbackTimer = window.setTimeout(reveal, 700);
      });
    return () => {
      stopped.current = true;
      window.clearTimeout(fallbackTimer);
      cleanup?.();
    };
  }, [reveal, sequence]);

  const replay = () => {
    setRevealed(false);
    setSequence((current) => current + 1);
    if (chestArtRef.current) chestArtRef.current.style.opacity = "1";
  };

  return (
    <PortalScene
      tree="both"
      header={header}
      {...(onSignOut ? { onSignOut } : {})}
      logoGlow
      fill
    >
      <section
        className={`admission-result-reveal ${fallback ? "admission-result-reveal--fallback" : ""}`}
        aria-label={`Admission result for ${teamName}`}
      >
        <canvas ref={canvasRef} aria-hidden className="admission-result-reveal__canvas" />
        <img
          key={sequence}
          ref={chestArtRef}
          src="/assets/magic-lucky-chest.webp"
          alt=""
          draggable={false}
          className="admission-result-reveal__chest"
        />

        <p className="sr-only" role="status" aria-live="polite">
          {revealed ? copy.heading : "Opening your Code2Create result."}
        </p>

        {revealed ? (
          <div className="admission-result-reveal__card-wrap">
            <div className="admission-result-reveal__card" role="status">
              {framePetals.map((petal, index) => (
                <span
                  key={`${petal.left}-${petal.top}`}
                  aria-hidden
                  className="admission-result-reveal__frame-petal"
                  style={{
                    left: petal.left,
                    top: petal.top,
                    rotate: `${petal.rotation}deg`,
                    animationDelay: `${petal.delay}s`,
                  }}
                >
                  <Petal size={petal.size} state={index % 4 === 0 ? "current" : "done"} />
                </span>
              ))}
              <div aria-hidden className="admission-result-reveal__mark">
                <img src="/assets/logo.svg" alt="" />
              </div>
              <p className="admission-result-reveal__eyebrow">{copy.eyebrow}</p>
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
        ) : (
          <button
            type="button"
            className="admission-result-reveal__skip"
            onClick={reveal}
          >
            reveal now
          </button>
        )}

        {revealed ? (
          <button type="button" className="admission-result-reveal__replay" onClick={replay}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M20 11a8 8 0 1 1-2.34-5.66L20 7.68M20 3v4.68h-4.68" />
            </svg>
            Replay chest
          </button>
        ) : null}
      </section>
    </PortalScene>
  );
}
