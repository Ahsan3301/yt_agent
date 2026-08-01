"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * Full-bleed animated gradient field behind the hero.
 *
 * ── Performance ──────────────────────────────────────────────────
 * The first cut of this shader ran 20 simplex-noise evaluations per
 * pixel per frame (five fbm calls x four octaves) at up to 1.5x DPR,
 * unthrottled. On a 1080p screen that is ~93M noise evaluations per
 * frame — it visibly dragged the whole page down. Four fixes, each
 * independent:
 *
 *   1. 20 noise calls -> 7. A single-level domain warp with raw
 *      snoise (rather than warping with two full fbm stacks) plus
 *      3-octave fbm. Visually near-identical; the field is soft
 *      enough that the extra octaves were invisible anyway.
 *   2. Render at 0.65 DPR and let the browser upscale. This is a
 *      blurry gradient — upsampling it is literally imperceptible,
 *      and it cuts fragment count by ~5x versus 1.5 DPR.
 *   3. 30fps instead of 60. The field drifts slowly; nobody can
 *      tell. Done with frameloop="demand" plus an interval that
 *      calls invalidate(), so the GPU genuinely idles between
 *      frames rather than rendering and discarding.
 *   4. Stop completely when the hero scrolls out of view. Most
 *      time-on-page is spent below the fold, where this was
 *      previously still burning a full GPU budget.
 *
 * Combined that is roughly a 35x reduction in shader work.
 *
 * The alpha falloff is still computed in the fragment shader —
 * radial from centre plus fades top and bottom — so the canvas
 * edges cannot produce a visible rectangle at any viewport size.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2  uMouse;
  uniform float uAspect;

  // ── Ashima simplex noise ───────────────────────────────────────
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                            + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                            dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x  = 2.0 * fract(p * C.www) - 1.0;
    vec3 h  = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x   + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  // 3 octaves — unrolled, no loop overhead.
  float fbm3(vec2 p) {
    float v = 0.5    * snoise(p);
    p *= 2.02;
    v += 0.25   * snoise(p);
    p *= 2.03;
    v += 0.125  * snoise(p);
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 p  = (uv - 0.5) * vec2(uAspect, 1.0);

    float t = uTime * 0.035;

    // Single-level domain warp: one fbm + one raw snoise for the
    // offset, then one fbm through it. 7 noise evaluations total.
    vec2 warp = vec2(
      fbm3(p * 1.25 + vec2(0.0, t)),
      snoise(p * 1.6 - vec2(t * 0.7, 0.0))
    );
    float n = fbm3(p * 1.05 + warp * 1.35);

    // Gentle pull toward the cursor.
    float mpull = smoothstep(0.9, 0.0, length(p - uMouse * vec2(uAspect, 1.0) * 0.5)) * 0.28;

    vec3 lavender = vec3(0.655, 0.545, 0.980);
    vec3 cyan     = vec3(0.404, 0.910, 0.976);
    vec3 pink     = vec3(0.941, 0.671, 0.988);

    vec3 col = mix(lavender, cyan, smoothstep(-0.6, 0.7, n + warp.x * 0.4));
    col = mix(col, pink, smoothstep(0.1, 0.9, warp.y) * 0.55);
    col += mpull * 0.5;

    // ── Alpha computed here: no hard canvas edge can exist ──────
    float band    = smoothstep(0.15, 0.65, abs(n) + 0.25);
    float radial  = smoothstep(0.95, 0.15, length(p));
    float topFade = smoothstep(1.05, 0.35, uv.y);
    float botFade = smoothstep(-0.15, 0.55, uv.y);

    gl_FragColor = vec4(col, band * radial * topFade * botFade * 0.55);
  }
`;

function GradientPlane({ active }: { active: boolean }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const smoothed = useRef(new THREE.Vector2(0, 0));
  const { invalidate } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime:   { value: 0 },
      uMouse:  { value: new THREE.Vector2(0, 0) },
      uAspect: { value: 1 },
    }),
    [],
  );

  // 30fps pump. In demand mode nothing renders unless we ask, so
  // this is a real halving of GPU work rather than a throttle on
  // top of a 60fps loop. Stops entirely when `active` is false.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => invalidate(), 33);
    return () => clearInterval(id);
  }, [active, invalidate]);

  useFrame(({ clock, size, pointer }) => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uTime.value = clock.getElapsedTime();
    m.uniforms.uAspect.value = size.width / size.height;
    smoothed.current.lerp(pointer, 0.05);
    m.uniforms.uMouse.value.copy(smoothed.current);
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

export default function HeroBackdrop() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(true);

  // Pause all rendering once the hero is scrolled away — the bulk of
  // time-on-page is spent below the fold.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => setActive(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="absolute inset-0 -z-10 pointer-events-none" aria-hidden>
      <Canvas
        // Deliberately sub-native: this is a soft gradient, so
        // upscaling from 0.65 DPR is imperceptible and costs ~5x
        // fewer fragments than 1.5.
        dpr={0.65}
        frameloop="demand"
        gl={{
          alpha: true,
          antialias: false,
          powerPreference: "high-performance",
          depth: false,
          stencil: false,
        }}
        onCreated={({ gl, scene }) => {
          scene.background = null;
          gl.setClearColor(0x000000, 0);
        }}
        style={{ background: "transparent" }}
      >
        <GradientPlane active={active} />
      </Canvas>
    </div>
  );
}
