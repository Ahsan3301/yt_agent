"""
bootstrap.py — runs ON the Colab VM, launched by `colab exec` from
.github/workflows/colab-dispatch.yml.

This is the CLI-driven replacement for yt_agent_colab.ipynb. The
notebook is still the manual path (open in a browser, run the cells);
this file is the same bootstrap with the browser removed.

Two things the notebook needed and this does not:

  * `google.colab.userdata` — the Secrets panel is a browser-UI feature
    and is not reachable from a headless `colab exec`. Secrets arrive
    as environment variables instead, injected by the workflow from
    GitHub secrets.
  * The JS keep-alive in cell 8, which clicked the connect button once
    a minute to beat Colab's ~90 minute tab-idle timeout. There is no
    tab, so there is nothing to keep alive. Colab's ~12 hour hard
    session cap still applies — that one is Google's and we cannot
    touch it.

DETACHED BY DESIGN. `colab exec` blocks until the script it is given
returns, and a GitHub Actions runner cannot sit attached for the hours
a worker should live (6h job cap, and it would burn Actions minutes for
nothing). So this spawns the real work — clone, install, run — into a
separate session and returns immediately.

That mirrors how Kaggle already works: the dispatch pushes the kernel
and walks away, and the success signal is the worker appearing in the
Monitor when it heartbeats, not the workflow going green. A green
workflow here means "the VM accepted the bootstrap", nothing more.
"""
import os
import pathlib
import subprocess
import sys

REPO = os.environ.get("YT_AGENT_REPO", "https://github.com/Ahsan3301/yt_agent.git")
BRANCH = os.environ.get("YT_AGENT_BRANCH", "main")
WORKDIR = pathlib.Path(os.environ.get("YT_AGENT_DIR", "/content/yt_agent"))
LOG = "/content/yt_agent_boot.log"

# Bootstrap secrets. Everything else — provider API keys, storage
# providers — is pulled from PocketBase once the worker is up, which is
# why this list is short and why it is the same list the notebook
# declares REQUIRED.
REQUIRED = [
    "COOLIFY_BASE_URL",
    "PB_URL",
    "POCKETBASE_ADMIN_EMAIL",
    "POCKETBASE_ADMIN_PASSWORD",
    "RENDER_TRIGGER_KEY",
    "STORAGE_PROVIDERS_ENC_KEY",
]

missing = [k for k in REQUIRED if not os.environ.get(k)]
if missing:
    # Fail loudly and early. A worker that boots without these
    # registers, heartbeats, claims a job and then dies partway through
    # it — which reads as a render bug rather than a missing secret.
    print("MISSING REQUIRED BOOTSTRAP SECRETS:", ", ".join(missing))
    print("Add them as repository secrets; colab-dispatch.yml passes them through.")
    sys.exit(1)

# Defaults for the outbound-poll model. INSTANCE_TIER matters to the
# claim gate: it rejects a `target: gpu` job on a non-gpu worker and a
# `target: cpu` job on a gpu one. The notebook hardcoded tier=gpu
# because it always booted a GPU runtime; this path is CPU by default,
# so the workflow sets both and we only fill in the gaps.
DEFAULTS = {
    "DB_BACKEND": "pocketbase",
    "STORAGE_BACKEND": "registry",
    "WORKER_MODE": "outbound_poll",
    "INSTANCE_TIER": "cpu",
    "INSTANCE_LABEL": "colab-cpu",
    # The dashboard's claim route reads "colab" out of the label
    # substring, so any label containing it routes correctly.
    #
    # Idle shutdown left ENABLED here, unlike the notebook which set
    # -1 to keep the runtime up until manually stopped. A browser
    # session is visible and gets closed; a headless VM nobody can see
    # is exactly the thing that quietly runs for 12 hours against the
    # account's quota. Override IDLE_TIMEOUT_SECONDS to change it.
    "IDLE_TIMEOUT_SECONDS": os.environ.get("IDLE_TIMEOUT_SECONDS", "1800"),
}
for k, v in DEFAULTS.items():
    os.environ.setdefault(k, v)

# The child re-execs a shell so clone + install + run survive as one
# unit after this process returns. setsid detaches it from the exec
# session, so the CLI disconnecting does not take the worker with it.
script = f"""
set -x
if [ ! -d "{WORKDIR}/.git" ]; then
  git clone --depth 1 --branch "{BRANCH}" "{REPO}" "{WORKDIR}"
fi
cd "{WORKDIR}"
python -m pip install -q -r requirements.txt
exec python -u -m uvicorn backend.server:app --host 0.0.0.0 --port 8000 --log-level info
"""

with open(LOG, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        ["bash", "-lc", script],
        cwd="/content",
        env=os.environ.copy(),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

print(f"bootstrap detached: pid={proc.pid} log={LOG}")
print(f"  tier={os.environ['INSTANCE_TIER']} label={os.environ['INSTANCE_LABEL']}")
print(f"  dashboard={os.environ['COOLIFY_BASE_URL']}")
print("This VM will appear in the Monitor once the worker registers and heartbeats.")
print(f"Tail progress with: colab exec -s <session> <<< 'print(open(\"{LOG}\").read()[-4000:])'")
