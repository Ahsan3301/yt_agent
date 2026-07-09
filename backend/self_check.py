"""Self-check for the multi-GPU + multilingual wiring.

Runnable two ways:

    # inside the Kaggle/Colab notebook (any cell):
    from backend.self_check import run
    print(run(text=True))

    # via HTTP against a live worker or the side worker:
    curl https://<worker>/api/health/self-check | python3 -m json.tool

Every check returns pass/fail + evidence, no dependencies. Designed to
fingerprint the "worker has multi-GPU + Kokoro + Noto fonts + language
propagation" state in ~200ms so we don't have to spelunk logs.

The report has THREE top-level sections:

  gpu       — hardware + gpu_topology + registry parity
  language  — voice map, subtitle chunker, font list, uploader hooks
  pipeline  — the wiring points that actually flip: uploader
              defaultLanguage, voice_override sanity, editor_gpu
              device_id support, seo_writer language read
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Any


def _ok(evidence: Any = None) -> dict:
    return {"pass": True, "evidence": evidence}


def _fail(reason: str, evidence: Any = None) -> dict:
    return {"pass": False, "reason": reason, "evidence": evidence}


# ── GPU / topology ────────────────────────────────────────────────

def _check_gpu() -> dict:
    out: dict[str, Any] = {}

    # 1. nvidia-smi ground truth
    try:
        smi = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,compute_cap,memory.total",
             "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL, timeout=4,
        ).decode().strip().splitlines()
        gpus = []
        for line in smi:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 3:
                gpus.append({"name": parts[0], "cc": parts[1], "vram_mb": int(float(parts[2]))})
        out["nvidia_smi"] = _ok(gpus) if gpus else _fail("nvidia-smi returned no rows")
        out["nvidia_smi_count"] = len(gpus)
    except FileNotFoundError:
        out["nvidia_smi"] = _fail("nvidia-smi not on PATH — CPU-only worker?")
        out["nvidia_smi_count"] = 0
    except Exception as e:
        out["nvidia_smi"] = _fail(f"nvidia-smi error: {e}")
        out["nvidia_smi_count"] = 0

    # 2. torch.cuda parity
    try:
        import torch
        n = int(torch.cuda.device_count())
        caps = [torch.cuda.get_device_capability(i) for i in range(n)]
        out["torch_cuda"] = _ok({
            "device_count": n,
            "compute_caps": [f"{c[0]}.{c[1]}" for c in caps],
            "cuda_available": bool(torch.cuda.is_available()),
        })
        if out["nvidia_smi_count"] and n != out["nvidia_smi_count"]:
            out["cuda_vs_smi"] = _fail(
                f"torch sees {n} GPUs but nvidia-smi sees "
                f"{out['nvidia_smi_count']} — env leak / CUDA_VISIBLE_DEVICES mismatch"
            )
        else:
            out["cuda_vs_smi"] = _ok()
    except Exception as e:
        out["torch_cuda"] = _fail(f"torch import/probe failed: {e}")

    # 3. gpu_topology module state
    try:
        from modules import gpu_topology as gt
        out["gpu_topology"] = _ok({
            "device_ids": list(gt.device_ids),
            "supports_multi_gpu": bool(gt.supports_multi_gpu),
            "sdxl_ready_devices": list(gt.sdxl_ready_devices),
            "kokoro_device": gt.kokoro_device,
            "compute_caps": [list(c) for c in gt.compute_caps],
        })
        if len(gt.device_ids) >= 2 and not gt.supports_multi_gpu:
            out["multi_gpu_gate"] = _fail(
                "2+ devices visible but supports_multi_gpu=False — one card is sm<7"
            )
        else:
            out["multi_gpu_gate"] = _ok()
    except Exception as e:
        out["gpu_topology"] = _fail(f"gpu_topology import failed: {e}")

    # 4. editor_gpu accepts device_id
    try:
        import inspect
        from modules import editor_gpu
        sig_v = inspect.signature(editor_gpu.render_video_segment_gpu)
        sig_i = inspect.signature(editor_gpu.render_image_segment_gpu)
        vid_has = "device_id" in sig_v.parameters
        img_has = "device_id" in sig_i.parameters
        if vid_has and img_has:
            out["editor_gpu_device_id"] = _ok({"video": True, "image": True})
        else:
            out["editor_gpu_device_id"] = _fail(
                f"editor_gpu missing device_id kwarg — video={vid_has} image={img_has}"
            )
    except Exception as e:
        out["editor_gpu_device_id"] = _fail(f"editor_gpu import failed: {e}")

    # 5. shotfinder device-keyed pipe cache
    try:
        from modules import shotfinder
        has_pipes_dict = isinstance(
            getattr(shotfinder, "_LOCAL_SDXL_PIPES", None), dict
        )
        has_tls = getattr(shotfinder, "_LOCAL_SDXL_TLS", None) is not None
        if has_pipes_dict and has_tls:
            out["shotfinder_multi_pipe"] = _ok({
                "loaded_devices": list((shotfinder._LOCAL_SDXL_PIPES or {}).keys()),
                "device_broken": list((shotfinder._LOCAL_SDXL_DEVICE_BROKEN or {}).keys()),
            })
        else:
            out["shotfinder_multi_pipe"] = _fail(
                f"shotfinder not upgraded — pipes_dict={has_pipes_dict} tls={has_tls}"
            )
    except Exception as e:
        out["shotfinder_multi_pipe"] = _fail(f"shotfinder import failed: {e}")

    return out


# ── Language / rendering wiring ───────────────────────────────────

def _check_language() -> dict:
    out: dict[str, Any] = {}

    # 1. Voice map coverage
    try:
        from modules.voiceover import LANG_DEFAULT_VOICES
        want = {"en", "de", "hi", "es", "fr", "ar", "pt", "it", "ja", "ko", "zh"}
        missing = sorted(want - set(LANG_DEFAULT_VOICES.keys()))
        if missing:
            out["voice_map"] = _fail(
                f"missing default voices for: {missing}",
                {"present": sorted(LANG_DEFAULT_VOICES.keys())},
            )
        else:
            out["voice_map"] = _ok({"languages": sorted(LANG_DEFAULT_VOICES.keys())})
    except Exception as e:
        out["voice_map"] = _fail(f"voiceover import failed: {e}")

    # 2. voice_override plumbing
    try:
        import inspect
        from modules import voiceover
        vo_sig = inspect.signature(voiceover.generate_voiceover)
        vc_sig = inspect.signature(voiceover._voice_config)
        rv_sig = inspect.signature(voiceover._resolve_voice)
        for name, sig in (("generate_voiceover", vo_sig),
                          ("_voice_config", vc_sig),
                          ("_resolve_voice", rv_sig)):
            if "voice_override" not in sig.parameters:
                out["voice_override"] = _fail(
                    f"{name} does not accept voice_override — wizard pick still dead"
                )
                break
        else:
            out["voice_override"] = _ok()
    except Exception as e:
        out["voice_override"] = _fail(f"voice_override probe failed: {e}")

    # 3. Subtitle chunker splits on CJK/Arabic/Devanagari
    try:
        from modules.editor import caption_chunks
        cases = {
            "cjk":       ("これは短い文です。もう一つ短い文です。それから最後の文です", 2),
            "arabic":    ("هذا مثال قصير جدا؟ نعم هذا جواب قصير جدا كذلك", 2),
            "devanagari": ("यह एक छोटा वाक्य है। यह दूसरा वाक्य है।", 2),
        }
        chunker_ok = True
        details = {}
        for name, (text, min_chunks) in cases.items():
            chunks = caption_chunks(text, max_words=12)
            details[name] = {"chunks": chunks, "count": len(chunks)}
            if len(chunks) < min_chunks:
                chunker_ok = False
        out["subtitle_chunker"] = _ok(details) if chunker_ok else _fail(
            "chunker returned a single unsplit line for a multi-sentence non-Latin input",
            details,
        )
    except Exception as e:
        out["subtitle_chunker"] = _fail(f"chunker probe failed: {e}")

    # 4. Fonts on system
    try:
        fc_list = shutil.which("fc-list")
        if fc_list:
            fl = subprocess.check_output(
                ["fc-list", ":", "family"], timeout=4,
            ).decode(errors="ignore")
            has_dejavu = "DejaVu Sans" in fl
            has_noto = ("Noto Sans" in fl or "Noto Serif" in fl)
            has_noto_cjk = ("Noto Sans CJK" in fl or "Noto Serif CJK" in fl)
            if has_dejavu and has_noto and has_noto_cjk:
                out["fonts"] = _ok({
                    "dejavu": True, "noto": True, "noto_cjk": True,
                })
            else:
                out["fonts"] = _fail(
                    f"missing fonts — dejavu={has_dejavu} noto={has_noto} "
                    f"noto_cjk={has_noto_cjk}. Notebook cell 1 apt-installs them; "
                    f"re-run it if you booted with an older repo."
                )
        else:
            out["fonts"] = _fail("fc-list not on PATH — fontconfig missing")
    except Exception as e:
        out["fonts"] = _fail(f"font check failed: {e}")

    # 5. Uploader honors language
    try:
        import inspect
        from modules import uploader
        sig = inspect.signature(uploader.upload_video)
        src = inspect.getsource(uploader.upload_video)
        if "language" in sig.parameters and '"defaultLanguage": eff_lang' in src:
            out["uploader_lang"] = _ok()
        else:
            out["uploader_lang"] = _fail(
                "upload_video still hardcodes defaultLanguage or omits the language kwarg"
            )
    except Exception as e:
        out["uploader_lang"] = _fail(f"uploader probe failed: {e}")

    # 6. seo_writer reads channel_cfg.language
    try:
        import inspect
        from modules import seo_writer
        src = inspect.getsource(seo_writer.write_seo_metadata) if hasattr(seo_writer, "write_seo_metadata") else ""
        if 'channel_cfg' in src and 'language' in src:
            out["seo_writer_lang"] = _ok("write_seo_metadata reads channel_cfg language")
        else:
            out["seo_writer_lang"] = _fail("seo_writer doesn't read language from channel_cfg")
    except Exception as e:
        out["seo_writer_lang"] = _fail(f"seo_writer probe failed: {e}")

    return out


# ── Pipeline wiring (main.py) ─────────────────────────────────────

def _check_pipeline() -> dict:
    out: dict[str, Any] = {}
    try:
        with open("main.py", "r", encoding="utf-8") as f:
            src = f.read()
    except Exception as e:
        return {"main_py_readable": _fail(f"main.py not readable at CWD: {e}")}

    # 1. Single-source-of-truth for language
    if "_pipeline_lang" in src and 'channel_cfg["language"] = _pipeline_lang' in src:
        out["language_single_source"] = _ok()
    else:
        out["language_single_source"] = _fail(
            "main.py doesn't merge _pipeline_lang into channel_cfg — SEO writer will read wrong language"
        )

    # 2. voice_override is plumbed into generate_voiceover
    if "voice_override=voice_override" in src:
        out["voice_override_plumbed"] = _ok()
    else:
        out["voice_override_plumbed"] = _fail("voice_override param declared but not passed")

    # 3. bg SDXL warm kicks at step 2 (not step 3)
    m = re.search(r"\[2/6\] bg SDXL warm", src)
    m3 = re.search(r"\[3/6\] bg SDXL warm", src)
    if m and not m3:
        out["sdxl_warm_step2"] = _ok()
    elif m3:
        out["sdxl_warm_step2"] = _fail("warm still labelled [3/6] — old placement")
    else:
        out["sdxl_warm_step2"] = _fail("bg SDXL warm log line not found in main.py")

    # 4. research_agent gets language
    if "language=_pipeline_lang" in src:
        out["research_agent_lang"] = _ok()
    else:
        out["research_agent_lang"] = _fail("research_agent call sites don't pass language")

    # 5. summary carries language
    if '"language": _pipeline_lang' in src:
        out["summary_carries_lang"] = _ok()
    else:
        out["summary_carries_lang"] = _fail(
            "summary dict doesn't persist language — publish side-jobs won't find it"
        )

    return out


# ── Public entrypoint ─────────────────────────────────────────────

def run(text: bool = False) -> Any:
    report = {
        "gpu":      _check_gpu(),
        "language": _check_language(),
        "pipeline": _check_pipeline(),
    }
    # Aggregate pass/fail summary
    fails = []
    for section, checks in report.items():
        for name, result in checks.items():
            if isinstance(result, dict) and result.get("pass") is False:
                fails.append(f"{section}.{name}: {result.get('reason', '(no reason)')}")
    report["_summary"] = {
        "ok": not fails,
        "fail_count": len(fails),
        "fails": fails,
    }
    if not text:
        return report
    lines = []
    for section, checks in report.items():
        if section == "_summary":
            continue
        lines.append(f"-- {section} --")
        for name, result in checks.items():
            if isinstance(result, dict) and "pass" in result:
                mark = "PASS" if result["pass"] else "FAIL"
                reason = "" if result["pass"] else f" -- {result.get('reason','')}"
                lines.append(f"  [{mark}] {name}{reason}")
            else:
                lines.append(f"    {name}: {result}")
    lines.append("")
    if report["_summary"]["ok"]:
        lines.append("SELF-CHECK: PASS (all wiring checks green)")
    else:
        lines.append(f"SELF-CHECK: FAIL ({report['_summary']['fail_count']} issues)")
        for f in report["_summary"]["fails"]:
            lines.append(f"  - {f}")
    return "\n".join(lines)


if __name__ == "__main__":
    print(run(text=True))
