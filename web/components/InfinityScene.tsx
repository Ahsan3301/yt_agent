"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, Suspense } from "react";
import * as THREE from "three";
import { EffectComposer, Bloom, ChromaticAberration } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";

/**
 * Premium WebGL infinity — real Three.js, not an SVG.
 *
 * Design notes:
 *   - Tube geometry along a parametric lemniscate curve (Bernoulli).
 *   - MeshPhysicalMaterial with iridescence, high metalness, low
 *     roughness — the surface picks up rim light and shifts color as
 *     you rotate it. That's what gives the "premium" jewel look.
 *   - Two coloured point lights (lavender + cyan) at opposite ends
 *     of the shape provide the rim highlights.
 *   - Bloom postprocessing gives the specular a real halo instead
 *     of a fake glow — this is the single biggest quality lever.
 *   - Slow autorotation on Y axis + subtle wobble on X.
 *   - Cursor tilt on top of the autorotation for interactivity.
 *   - DPR capped at [1, 1.75] — retina but not full 4K, keeps FPS
 *     stable on integrated GPUs.
 *   - Frameloop 'demand' when not animating would save even more —
 *     but we do want continuous motion, so 'always' with our light
 *     scene stays cheap.
 *
 * Loads lazily via next/dynamic on the parent — Three.js core alone
 * is ~120kb gzipped so it MUST NOT ship in the initial bundle. The
 * dynamic import in the landing page handles that + adds a Suspense
 * fallback (an empty div, so nothing pops in visually).
 */

const N_TUBULAR = 400;   // tube segments along path length
const N_RADIAL  = 32;    // segments around circumference
const TUBE_R    = 0.18;  // tube radius

class LemniscateCurve extends THREE.Curve<THREE.Vector3> {
  scale: number;
  constructor(scale = 1) { super(); this.scale = scale; }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    // Bernoulli lemniscate parametric form, tilted into 3D by
    // adding a small sin-modulation on Z so the crossing point
    // isn't perfectly flat. Gives the shape a subtle twist.
    const theta = t * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const denom = 1 + sin * sin;
    const x = (cos)         / denom;
    const y = (cos * sin)   / denom;
    // 3D twist — the crossing at (0,0) wobbles gently in Z so the
    // two lobes don't visually collide when viewed head-on.
    const z = Math.sin(theta * 2) * 0.06;
    return target.set(x * this.scale, y * this.scale * 1.15, z * this.scale);
  }
}

function InfinityMesh() {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const { viewport, pointer } = useThree();

  // Build geometry once — TubeGeometry is expensive to allocate.
  const geometry = useMemo(() => {
    const curve = new LemniscateCurve(2.6);
    return new THREE.TubeGeometry(curve, N_TUBULAR, TUBE_R, N_RADIAL, true);
  }, []);

  useFrame((_, dt) => {
    const g = groupRef.current;
    const m = meshRef.current;
    if (!g || !m) return;
    // Autorotate — slow on Y so the shape reads as 3D from the get-go.
    m.rotation.y += dt * 0.35;
    m.rotation.x = Math.sin(performance.now() * 0.0005) * 0.15;
    // Cursor tilt on the parent group so the shape leans toward
    // where you're looking. Damped-lerp for smooth response.
    const targetX = pointer.y * 0.25;
    const targetY = pointer.x * 0.4;
    g.rotation.x += (targetX - g.rotation.x) * 0.08;
    g.rotation.y += (targetY - g.rotation.y) * 0.08;
  });

  // Scale to fit the viewport nicely.
  const scale = Math.min(viewport.width, viewport.height) * 0.28;

  return (
    <group ref={groupRef} scale={scale} position={[0, 0, 0]}>
      <mesh ref={meshRef} geometry={geometry}>
        <meshPhysicalMaterial
          color="#e8e6ff"
          metalness={1.0}
          roughness={0.15}
          iridescence={1.0}
          iridescenceIOR={1.5}
          iridescenceThicknessRange={[100, 800]}
          clearcoat={1.0}
          clearcoatRoughness={0.1}
          reflectivity={1.0}
          envMapIntensity={1.2}
          emissive={new THREE.Color("#3a2a6b")}
          emissiveIntensity={0.4}
        />
      </mesh>

      {/* Rim lights — coloured point lights close to the shape so
          the physical material picks up gorgeous cross-highlights. */}
      <pointLight position={[ 3, 1.5,  2]} color="#a78bfa" intensity={80} distance={12} decay={2} />
      <pointLight position={[-3, -1.5, 2]} color="#67e8f9" intensity={70} distance={12} decay={2} />
      <pointLight position={[ 0,  0,  -3]} color="#f0abfc" intensity={40} distance={10} decay={2} />
      <pointLight position={[ 0,  3,   0]} color="#fbbf24" intensity={25} distance={8}  decay={2} />
    </group>
  );
}

function Backdrop() {
  // Very faint back gradient plane so the shape has something to
  // sit against — otherwise the black void feels flat. Sits behind
  // the mesh and doesn't receive shadow.
  return (
    <mesh position={[0, 0, -5]} scale={[20, 20, 1]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        color="#0a0a12"
        transparent
        opacity={0.001}
      />
    </mesh>
  );
}

export default function InfinityScene() {
  return (
    <div
      className="w-[min(760px,92vw)] aspect-[16/10] mb-8"
      style={{ contain: "layout paint" }}
      aria-hidden
    >
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        dpr={[1, 1.75]}
        gl={{
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.35} />
        <Suspense fallback={null}>
          <Backdrop />
          <InfinityMesh />
          <EffectComposer multisampling={0}>
            <Bloom
              intensity={1.4}
              luminanceThreshold={0.15}
              luminanceSmoothing={0.9}
              mipmapBlur
              radius={0.85}
            />
            <ChromaticAberration
              offset={new THREE.Vector2(0.0006, 0.0006)}
              radialModulation={false}
              modulationOffset={0}
              blendFunction={BlendFunction.NORMAL}
            />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}
