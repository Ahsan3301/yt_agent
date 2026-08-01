"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Full-bleed animated gradient mesh behind the hero.
 *
 * ── Why this replaced the floating infinity ──────────────────────
 * A discrete 3D object centred above the copy always reads as
 * decoration bolted onto the page — and because it lives in its own
 * canvas rect it can never truly sit *in* the layout. Every premium
 * SaaS hero (Linear, Stripe, Vercel, Raycast) does the opposite:
 * an ambient field that bleeds behind the whole section, with the
 * typography and the product doing the actual work.
 *
 * This is one full-screen quad running a fragment shader. The alpha
 * falloff is computed IN the shader — radial from centre plus a
 * vertical fade — so the canvas edges are mathematically incapable
 * of producing a visible rectangle no matter the viewport.
 *
 * Cost: one draw call, no geometry, no postprocessing, no textures.
 * Cheaper than the SVG version it replaces.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
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

  // Fractal brownian motion — layered noise for organic flow.
  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * snoise(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    // Correct for viewport aspect so the field isn't stretched.
    vec2 uv = vUv;
    vec2 p  = (uv - 0.5) * vec2(uAspect, 1.0);

    float t = uTime * 0.035;

    // Domain-warp the sample point — this is what gives the slow
    // liquid-silk motion rather than obvious scrolling noise.
    vec2 q = vec2(fbm(p * 1.4 + vec2(0.0, t)),
                  fbm(p * 1.4 + vec2(4.7, -t * 0.8)));
    vec2 r = vec2(fbm(p * 1.8 + q * 1.6 + vec2(1.7, 9.2) + t * 0.6),
                  fbm(p * 1.8 + q * 1.6 + vec2(8.3, 2.8) - t * 0.5));

    float n = fbm(p * 1.2 + r * 1.4);

    // Pull the field gently toward the cursor.
    float mdist = length(p - uMouse * vec2(uAspect, 1.0) * 0.5);
    float mpull = smoothstep(0.9, 0.0, mdist) * 0.28;

    // Palette — lavender / cyan / pink, matching the design tokens.
    vec3 lavender = vec3(0.655, 0.545, 0.980);
    vec3 cyan     = vec3(0.404, 0.910, 0.976);
    vec3 pink     = vec3(0.941, 0.671, 0.988);

    vec3 col = mix(lavender, cyan, smoothstep(-0.6, 0.7, n + r.x * 0.4));
    col = mix(col, pink, smoothstep(0.1, 0.9, r.y) * 0.55);
    col += mpull * 0.5;

    // ── Alpha: computed here, so no hard canvas edge can exist ──
    float band  = smoothstep(0.15, 0.65, abs(n) + 0.25);
    float radial = smoothstep(0.95, 0.15, length(p));
    float topFade = smoothstep(1.05, 0.35, uv.y);   // fade toward nav
    float botFade = smoothstep(-0.15, 0.55, uv.y);  // fade into section below

    float alpha = band * radial * topFade * botFade * 0.55;

    gl_FragColor = vec4(col, alpha);
  }
`;

function GradientPlane() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const mouse = useRef(new THREE.Vector2(0, 0));
  const target = useRef(new THREE.Vector2(0, 0));

  const uniforms = useMemo(
    () => ({
      uTime:   { value: 0 },
      uMouse:  { value: new THREE.Vector2(0, 0) },
      uAspect: { value: 1 },
    }),
    [],
  );

  useFrame(({ size, pointer }, dt) => {
    const m = matRef.current;
    if (!m) return;
    m.uniforms.uTime.value += dt;
    m.uniforms.uAspect.value = size.width / size.height;
    // Damped cursor follow so the field drifts rather than snaps.
    target.current.set(pointer.x, pointer.y);
    mouse.current.lerp(target.current, 0.03);
    m.uniforms.uMouse.value.copy(mouse.current);
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
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none" aria-hidden>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: false, powerPreference: "high-performance" }}
        onCreated={({ gl, scene }) => {
          scene.background = null;
          gl.setClearColor(0x000000, 0);
        }}
        style={{ background: "transparent" }}
      >
        <GradientPlane />
      </Canvas>
    </div>
  );
}
