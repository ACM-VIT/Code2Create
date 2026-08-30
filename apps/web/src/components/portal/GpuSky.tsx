import { useEffect, useRef } from 'react'

// The f1 night-sky shader from the mockup, verbatim: drifting fbm cloud
// colour, a slow aurora band, and twinkling stars.
const SKY_SHADER = /* wgsl */ `
struct U { t: f32, w: f32, h: f32, pad: f32 }
@group(0) @binding(0) var<uniform> u: U;
fn hash2(p: vec2f) -> vec2f {
  var q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let a = hash2(i).x; let b = hash2(i + vec2f(1., 0.)).x;
  let c = hash2(i + vec2f(0., 1.)).x; let d = hash2(i + vec2f(1., 1.)).x;
  let s = f * f * (3. - 2. * f);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
fn fbm(p: vec2f) -> f32 {
  var v = 0.; var a = .5; var q = p;
  for (var i = 0; i < 4; i++) { v += a * noise(q); q *= 2.03; a *= .5; }
  return v;
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1., -3.), vec2f(3., 1.), vec2f(-1., 1.));
  return vec4f(pos[i], 0., 1.);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / vec2f(u.w, u.h);
  let t = u.t;
  let ink = vec3f(.047, 0., .016);
  let deep = vec3f(.627, .259, .388);
  let blush = vec3f(.89, .663, .749);
  let n = fbm(uv * 3. + vec2f(t * .015, -t * .01));
  var col = mix(ink, deep, smoothstep(.62, 1.55, uv.y + n * .22));
  col = mix(col, blush, smoothstep(1.05, 1.9, uv.y + n * .3));
  let band = exp(-abs(uv.y - (.42 + .09 * sin(uv.x * 2.6 + t * .12) + .1 * n)) * 5.5);
  col += vec3f(.85, .52, .64) * band * (.10 + .08 * fbm(uv * 5. + t * .03));
  let g = uv * vec2f(140., 88.);
  let cell = floor(g); let h = hash2(cell);
  let star = smoothstep(.997, 1., h.x) * (.55 + .45 * sin(t * (1. + h.y * 2.) + h.y * 20.));
  col += vec3f(1., .95, .97) * star * smoothstep(.75, .15, uv.y);
  let d = distance(fract(g) - .5, vec2f(0.));
  col += vec3f(1., .8, .87) * star * smoothstep(.5, .0, d) * .6;
  return vec4f(col, 1.);
}`

async function startSky(canvas: HTMLCanvasElement, stopped: { current: boolean }) {
  const gpu = navigator.gpu
  if (!gpu) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter || stopped.current) return
    const device = await adapter.requestDevice()
    if (stopped.current) {
      device.destroy()
      return
    }
    const context = canvas.getContext('webgpu')
    if (!context) {
      device.destroy()
      return
    }
    const format = gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })
    const module = device.createShaderModule({ code: SKY_SHADER })
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
    const uniforms = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    })
    const startedAt = performance.now()
    const tick = () => {
      if (stopped.current || !canvas.isConnected) {
        device.destroy()
        return
      }
      const width = canvas.clientWidth || canvas.width
      const height = canvas.clientHeight || canvas.height
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([(performance.now() - startedAt) / 1000, canvas.width, canvas.height, 0]),
      )
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  } catch {
    // The scene's CSS gradient stays underneath; nothing to do.
  }
}

/**
 * The live WebGPU sky behind the home screen (mockup f1). Renders nothing on
 * browsers without WebGPU or with reduced motion — the scene's own gradient
 * is the fallback.
 */
export function GpuSky() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const stopped = { current: false }
    void startSky(canvas, stopped)
    return () => {
      stopped.current = true
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
    />
  )
}
