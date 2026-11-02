import chestShader from "./chest.wgsl?raw";

const vertexShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let point = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[index];
  var output: VertexOutput;
  output.position = vec4f(point, 0.0, 1.0);
  output.uv = point * vec2f(0.5, -0.5) + vec2f(0.5);
  return output;
}`;

/** The chest renderer, bounded to one reveal and disposed on every exit. */
export async function startBenefitChest({ canvas, art, signal, onReady, onComplete, onFailure }: {
  canvas: HTMLCanvasElement;
  art: HTMLImageElement;
  signal: AbortSignal;
  onReady: () => void;
  onComplete: () => void;
  onFailure: () => void;
}): Promise<(() => void) | null> {
  const gpu = navigator.gpu;
  if (!gpu || signal.aborted) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter || signal.aborted) return null;
  const device = await adapter.requestDevice();
  if (signal.aborted) {
    device.destroy();
    return null;
  }

  let texture: GPUTexture | undefined;
  let uniforms: GPUBuffer | undefined;
  let bitmap: ImageBitmap | undefined;
  let observer: ResizeObserver | undefined;
  let frame = 0;
  let disposed = false;
  const context = canvas.getContext("webgpu");
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    cancelAnimationFrame(frame);
    observer?.disconnect();
    bitmap?.close();
    texture?.destroy();
    uniforms?.destroy();
    context?.unconfigure();
    device.destroy();
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    onFailure();
  };
  signal.addEventListener("abort", dispose, { once: true });
  device.addEventListener("uncapturederror", fail);
  void device.lost.then(fail);

  try {
    if (!context) {
      dispose();
      return null;
    }
    const response = await fetch("/assets/magic-lucky-chest.webp", { signal });
    if (!response.ok) throw new Error("The benefit chest artwork could not load.");
    const decoded = await createImageBitmap(await response.blob());
    if (disposed) {
      decoded.close();
      return null;
    }
    bitmap = decoded;
    texture = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: bitmap }, { texture }, [bitmap.width, bitmap.height],
    );
    bitmap.close();
    bitmap = undefined;
    const format = gpu.getPreferredCanvasFormat();
    const shader = device.createShaderModule({ code: `${chestShader}\n${vertexShader}` });
    const pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    if (disposed) return null;
    context.configure({ device, format, alphaMode: "premultiplied" });
    const buffer = device.createBuffer({
      size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    uniforms = buffer;
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
      ],
    });
    const values = new Float32Array(8);
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      // This is a decorative ray-marched effect: do not render a full Retina display.
      const scale = Math.min(window.devicePixelRatio, 1.5, 1280 / Math.max(bounds.width, bounds.height, 1));
      canvas.width = Math.max(1, Math.round(bounds.width * scale));
      canvas.height = Math.max(1, Math.round(bounds.height * scale));
      const artBounds = art.getBoundingClientRect();
      values[0] = canvas.width;
      values[1] = canvas.height;
      values[2] = artBounds.width / Math.max(bounds.height, 1) * 0.95;
      values[3] = artBounds.height / Math.max(bounds.height, 1) * 0.95;
      values[5] = 1;
    };
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const startedAt = performance.now();
    let ready = false;
    const render = () => {
      if (disposed) return;
      if (!canvas.isConnected) { dispose(); return; }
      const elapsed = performance.now() - startedAt;
      if (elapsed >= 3_500) { dispose(); onComplete(); return; }
      try {
        values[4] = elapsed / 1000;
        device.queue.writeBuffer(buffer, 0, values);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        if (!ready) { ready = true; onReady(); }
        frame = requestAnimationFrame(render);
      } catch {
        fail();
      }
    };
    frame = requestAnimationFrame(render);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
