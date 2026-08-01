"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { useMemo, useRef, Suspense } from "react";
import * as THREE from "three";

/**
 * Premium WebGL infinity.
 *
 * ── Why there is no postprocessing here ──────────────────────────
 * The first version used <EffectComposer><Bloom/></EffectComposer>.
 * On a transparent canvas that renders the scene into an offscreen
 * target that does NOT preserve the page background, so the whole
 * canvas rectangle filled with a pale haze — the shape looked like
 * it was sitting inside a switched-on TV screen. Classic symptom.
 *
 * Instead the glow is faked with additive shell geometry: the same
 * curve extruded at 2x / 3.2x / 5x the core radius, MeshBasicMaterial,
 * AdditiveBlending, depthWrite off, low opacity. Stacked they read as
 * a soft bloom halo, they're alpha-correct by construction, and they
 * cost three cheap draw calls instead of a multi-pass composer.
 *
 * ── Reflections without a network fetch ──────────────────────────
 * drei's <Environment preset="..."> downloads a multi-MB HDR from a
 * CDN. Instead we build the environment procedurally from four
 * <Lightformer> planes rendered once (frames={1}) into a 256px
 * cubemap. The metal picks up real coloured reflections, nothing is
 * fetched, and it's baked on the first frame.
 *
 * The container also carries a radial CSS mask so the canvas edges
 * dissolve into the page instead of ending on a hard rectangle.
 */

const TUBULAR = 420;
const RADIAL  = 36;
const CORE_R  = 0.16;

/** Bernoulli lemniscate with a Z-twist so the crossing point reads
 *  as 3D depth rather than a flat overlap. */
class LemniscateCurve extends THREE.Curve<THREE.Vector3> {
  scale: number;
  constructor(scale = 1) { super(); this.scale = scale; }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const th = t * Math.PI * 2;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const denom = 1 + sin * sin;
    return target.set(
      (cos / denom) * this.scale,
      ((cos * sin) / denom) * this.scale * 1.25,
      Math.sin(th * 2) * 0.11 * this.scale,
    );
  }
}

/** Additive shell — one of the layers that together fake bloom. */
function GlowShell({
  geometry, color, opacity,
}: { geometry: THREE.TubeGeometry; color: string; opacity: number }) {
  return (
    <mesh geometry={geometry} renderOrder={-1}>
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        side={THREE.BackSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function InfinityMesh() {
  const spin  = useRef<THREE.Group>(null);
  const tilt  = useRef<THREE.Group>(null);
  const { viewport, pointer } = useThree();

  // One curve, four extrusions at increasing radii.
  const { core, g1, g2, g3 } = useMemo(() => {
    const curve = new LemniscateCurve(2.5);
    return {
      core: new THREE.TubeGeometry(curve, TUBULAR, CORE_R,        RADIAL, true),
      g1:   new THREE.TubeGeometry(curve, TUBULAR, CORE_R * 2.0,  20,     true),
      g2:   new THREE.TubeGeometry(curve, TUBULAR, CORE_R * 3.2,  16,     true),
      g3:   new THREE.TubeGeometry(curve, TUBULAR, CORE_R * 5.0,  12,     true),
    };
  }, []);

  useFrame((_, dt) => {
    const s = spin.current;
    const t = tilt.current;
    if (!s || !t) return;
    // Continuous rotation reveals the iridescence shifting across the
    // surface — that's what sells the material.
    s.rotation.y += dt * 0.32;
    s.rotation.x  = Math.sin(performance.now() * 0.00045) * 0.18;
    // Damped cursor lean on the parent so it composes with the spin.
    t.rotation.x += ((pointer.y * 0.22) - t.rotation.x) * 0.06;
    t.rotation.y += ((pointer.x * 0.35) - t.rotation.y) * 0.06;
  });

  const scale = Math.min(viewport.width, viewport.height) * 0.30;

  return (
    <group ref={tilt} scale={scale}>
      <group ref={spin}>
        {/* Fake-bloom shells, widest first so they layer correctly. */}
        <GlowShell geometry={g3} color="#f0abfc" opacity={0.030} />
        <GlowShell geometry={g2} color="#67e8f9" opacity={0.055} />
        <GlowShell geometry={g1} color="#a78bfa" opacity={0.110} />

        {/* Core ribbon — the reflective, iridescent surface. */}
        <mesh geometry={core}>
          <meshPhysicalMaterial
            color="#dcd8ff"
            metalness={1}
            roughness={0.12}
            iridescence={1}
            iridescenceIOR={1.6}
            iridescenceThicknessRange={[120, 780]}
            clearcoat={1}
            clearcoatRoughness={0.08}
            envMapIntensity={2.2}
            emissive={new THREE.Color("#2a1f52")}
            emissiveIntensity={0.35}
          />
        </mesh>

        {/* Rim lights — these ride WITH the shape so highlights sweep
            across the surface as it turns. */}
        <pointLight position={[ 3,  1.5,  2]} color="#a78bfa" intensity={70} distance={12} decay={2} />
        <pointLight position={[-3, -1.5,  2]} color="#67e8f9" intensity={60} distance={12} decay={2} />
        <pointLight position={[ 0,  0,   -3]} color="#f0abfc" intensity={35} distance={10} decay={2} />
        <pointLight position={[ 0,  3,    0]} color="#fbbf24" intensity={22} distance={9}  decay={2} />
      </group>
    </group>
  );
}

export default function InfinityScene() {
  return (
    <div
      className="w-[min(820px,94vw)] aspect-[16/9] mb-4"
      style={{
        // Dissolve the canvas edges so there is no hard rectangle.
        WebkitMaskImage:
          "radial-gradient(ellipse 72% 72% at 50% 50%, #000 45%, transparent 82%)",
        maskImage:
          "radial-gradient(ellipse 72% 72% at 50% 50%, #000 45%, transparent 82%)",
      }}
      aria-hidden
    >
      <Canvas
        camera={{ position: [0, 0, 5.2], fov: 42 }}
        dpr={[1, 1.75]}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl, scene }) => {
          // Belt and braces: guarantee the canvas composites over the
          // page instead of painting its own background.
          scene.background = null;
          gl.setClearColor(0x000000, 0);
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
        }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.25} />
        <Suspense fallback={null}>
          {/* Procedural environment — baked once, nothing downloaded. */}
          <Environment resolution={256} frames={1}>
            <Lightformer intensity={5} color="#a78bfa" form="rect"
                         position={[ 5,  2,  2]} scale={[7, 7, 1]} target={[0, 0, 0]} />
            <Lightformer intensity={4} color="#67e8f9" form="rect"
                         position={[-5, -2,  2]} scale={[7, 7, 1]} target={[0, 0, 0]} />
            <Lightformer intensity={3} color="#f0abfc" form="rect"
                         position={[ 0,  5, -3]} scale={[9, 3, 1]} target={[0, 0, 0]} />
            <Lightformer intensity={2} color="#fbbf24" form="rect"
                         position={[ 0, -5, -2]} scale={[9, 2, 1]} target={[0, 0, 0]} />
            <Lightformer intensity={1.2} color="#ffffff" form="ring"
                         position={[0, 0, 6]} scale={[4, 4, 1]} target={[0, 0, 0]} />
          </Environment>
          <InfinityMesh />
        </Suspense>
      </Canvas>
    </div>
  );
}
