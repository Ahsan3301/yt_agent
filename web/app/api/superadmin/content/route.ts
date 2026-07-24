import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Landing content CMS — reads/writes the landing_content singleton row.
 * Superadmin only.
 *
 * There's exactly one row (id="landing") that the public landing page
 * SSRs from. All edits are logged to audit_log with the previous
 * version snapshotted in meta.
 */
const CONTENT_ID = "landingcontent0";  // 15-char alphanumeric PB id

type LandingContent = {
  hero_title?: string;
  hero_sub?: string;
  hero_cta_text?: string;
  hero_cta_href?: string;
  features?: Array<{ title: string; body: string; icon?: string }>;
  pricing_tiers?: Array<{ name: string; price: string; sub?: string; features?: string[]; highlight?: boolean }>;
  footer_links?: Array<{ label: string; href: string }>;
};

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const snap = await adminDb().collection("landing_content").doc(CONTENT_ID).get();
    if (!snap.exists) return NextResponse.json({});
    return NextResponse.json(snap.data() || {});
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: LandingContent;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  // Sanitize + cap sizes so a runaway paste can't stuff the DB.
  const clean = {
    hero_title:    String(body.hero_title    || "").slice(0, 200),
    hero_sub:      String(body.hero_sub      || "").slice(0, 500),
    hero_cta_text: String(body.hero_cta_text || "").slice(0, 60),
    hero_cta_href: String(body.hero_cta_href || "").slice(0, 200),
    features:      _cleanFeatures(body.features),
    pricing_tiers: _cleanTiers(body.pricing_tiers),
    footer_links:  _cleanFooter(body.footer_links),
    updated_by:    auth.tenant.userId,
    updated_at:    Math.floor(Date.now() / 1000),
  };

  try {
    const ref = adminDb().collection("landing_content").doc(CONTENT_ID);
    const prev = await ref.get();
    await ref.set(clean, { merge: false });
    await audit(auth.tenant, {
      action: "content.save",
      target_type: "landing_content",
      target_id: CONTENT_ID,
      meta: { previous: prev.exists ? prev.data() : null },
    }, req);
    return NextResponse.json({ ok: true, ...clean });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function _cleanFeatures(v: unknown): Array<{ title: string; body: string; icon?: string }> {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 12).map((x) => {
    const o = (x || {}) as Record<string, unknown>;
    return {
      title: String(o.title || "").slice(0, 100),
      body:  String(o.body  || "").slice(0, 400),
      icon:  o.icon ? String(o.icon).slice(0, 40) : undefined,
    };
  }).filter((f) => f.title || f.body);
}

function _cleanTiers(v: unknown): Array<{ name: string; price: string; sub?: string; features?: string[]; highlight?: boolean }> {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 6).map((x) => {
    const o = (x || {}) as Record<string, unknown>;
    return {
      name:      String(o.name  || "").slice(0, 60),
      price:     String(o.price || "").slice(0, 40),
      sub:       o.sub ? String(o.sub).slice(0, 120) : undefined,
      features:  Array.isArray(o.features)
        ? (o.features as unknown[]).slice(0, 20).map((s) => String(s).slice(0, 120))
        : undefined,
      highlight: Boolean(o.highlight),
    };
  }).filter((t) => t.name);
}

function _cleanFooter(v: unknown): Array<{ label: string; href: string }> {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).map((x) => {
    const o = (x || {}) as Record<string, unknown>;
    return {
      label: String(o.label || "").slice(0, 60),
      href:  String(o.href  || "").slice(0, 200),
    };
  }).filter((l) => l.label && l.href);
}

export const CONTENT_DOC_ID = CONTENT_ID;
