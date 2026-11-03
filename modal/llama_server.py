"""llama-server on a Modal GPU, for the grammar track of bin/matrix.ts.

One deploy serves one model behind an OpenAI-compatible /v1 that accepts tamechat's
`grammar` field, which no hosted API does. The container scales to zero after five idle
minutes, so it bills only while a run is talking to it.

    uvx modal secret create tamechat-llama LLAMA_API_KEY=$(openssl rand -hex 24)
    MODEL=qwen3.6-35b uvx modal run modal/llama_server.py::download     # once per model, into a Volume
    MODEL=qwen3.6-35b uvx modal deploy modal/llama_server.py            # prints the endpoint URL
    uvx modal app stop tamechat-llama-qwen3.6-35b                       # when finished

Then point a matrix run at "<endpoint>/v1" with "keyEnv": "LLAMA_API_KEY" and "grammar": true.
"""

import hashlib
import os
import subprocess

import modal

# Each entry was checked against the Hugging Face API (repo and file exist). sha256 is set only
# where we have an independent record of it, so `download` can prove it is the file used before.
MODELS = {
    "qwen3.6-35b": {
        "repo": "unsloth/Qwen3.6-35B-A3B-GGUF",
        "file": "Qwen3.6-35B-A3B-UD-IQ4_XS.gguf",
        "sha256": "649d7508507b84638732c4f52c24c8b15843c6dca2f3ff793ae07c14a67ebbb3",  # findings/PROVENANCE.md
        "gpu": "L40S",
        "thinking": True,
    },
    "qwen3.8-27b": {
        "repo": "unsloth/Qwen3.8-27B-GGUF",
        "file": "Qwen3.8-27B-UD-IQ4_XS.gguf",
        "sha256": None,
        "gpu": "L40S",
        "thinking": True,
    },
    "gemma-4-12b": {
        "repo": "unsloth/gemma-4-12b-it-GGUF",
        "file": "gemma-4-12b-it-IQ4_XS.gguf",
        "sha256": None,
        "gpu": "L4",
        "thinking": False,
    },
    "mistral-small-3.2": {
        "repo": "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF",
        "file": "Mistral-Small-3.2-24B-Instruct-2506-IQ4_XS.gguf",
        "sha256": None,
        "gpu": "L40S",
        "thinking": False,
    },
}

KEY = os.environ.get("MODEL", "qwen3.6-35b")
if KEY not in MODELS:
    raise SystemExit(f"MODEL must be one of {', '.join(MODELS)}")
SPEC = MODELS[KEY]

# Pin the llama.cpp build with LLAMA_IMAGE (a ghcr.io/ggml-org/llama.cpp:server-cuda-bNNNN tag) for a
# run you intend to publish; the default floats. The server's own build number is logged at startup.
LLAMA_IMAGE = os.environ.get("LLAMA_IMAGE", "ghcr.io/ggml-org/llama.cpp:server-cuda")

app = modal.App(f"tamechat-llama-{KEY}")
models = modal.Volume.from_name("tamechat-models", create_if_missing=True)
image = (
    modal.Image.from_registry(LLAMA_IMAGE, add_python="3.12")
    .entrypoint([])
    .pip_install("huggingface_hub==0.36.0")
    .env({"MODEL": KEY, "LLAMA_IMAGE": LLAMA_IMAGE})
)
MODEL_DIR = "/models"
PATH = f"{MODEL_DIR}/{SPEC['file']}"


@app.function(image=image, volumes={MODEL_DIR: models}, timeout=3600)
def download():
    from huggingface_hub import hf_hub_download

    if not os.path.exists(PATH):
        hf_hub_download(repo_id=SPEC["repo"], filename=SPEC["file"], local_dir=MODEL_DIR)
        models.commit()
    digest = hashlib.sha256()
    with open(PATH, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            digest.update(block)
    got = digest.hexdigest()
    print(f"{SPEC['file']} sha256 {got}")
    if SPEC["sha256"] and got != SPEC["sha256"]:
        raise SystemExit(f"sha256 mismatch: expected {SPEC['sha256']}")


@app.function(
    image=image,
    gpu=SPEC["gpu"],
    volumes={MODEL_DIR: models},
    secrets=[modal.Secret.from_name("tamechat-llama")],
    scaledown_window=300,
    timeout=3600,
    max_containers=1,
)
@modal.concurrent(max_inputs=4)
@modal.web_server(8080, startup_timeout=900)
def serve():
    if not os.path.exists(PATH):
        raise SystemExit(f"{PATH} missing: run `MODEL={KEY} modal run modal/llama_server.py::download` first")
    subprocess.run(["/app/llama-server", "--version"], check=False)
    args = [
        "/app/llama-server",
        "--model", PATH,
        "--host", "0.0.0.0",
        "--port", "8080",
        "--api-key", os.environ["LLAMA_API_KEY"],
        "--n-gpu-layers", "999",
        "--ctx-size", "8192",
        "--parallel", "4",
        "--jinja",
    ]
    # The October runs had thinking off; keep it off so answers stay comparable.
    if SPEC["thinking"]:
        args += ["--reasoning-budget", "0"]
    subprocess.Popen(args)
