# Local models (Qwen on your own GPU)

**Optional. Skip this file unless you want models on your own machine.** Phosphor-OS works without it, with Claude only.
What it takes: Arch or Omarchy, an AMD GPU with about 18 GB of free VRAM (ROCm; another GPU needs a different
`device` in the preset), and about 31 GB of disk for the model files (downloaded to `~/models`, or the folder in
`PHOSPHOR_MODELS_DIR`). The sizes and speeds below were measured on one 20 GB AMD card; yours will differ.

Four entries in the model picker: "Qwen3.8 27B (local)", "Qwen3.6 35B MoE (local)", "Gemma 4 26B MoE (local)" and "Gemma 4 E4B (local)". They run on your PC: no plan
limits, no network. Claude Code (the Agent SDK) talks to a llama.cpp server in Claude's own API format, so tools,
edits and permission cards work. Only one model fits in GPU memory: picking the other one swaps them (the first
message waits about 30 to 50 s, the activity line says "Loading local model").
All four see images (screenshots Claude reads, pictures you attach): each loads its own vision file (`mmproj`,
about 1 GB, on the GPU with the model). Without it a model fails on any image with "image input is not supported".

## Set up

1. `sudo pacman -S llama-cpp ggml-hip` (llama.cpp with the ROCm backend; `llama-server --list-devices` shows `ROCm0`).
2. `bash scripts/setup-local-model.sh` (downloads about 31 GB to `~/models`, installs the service, writes `.env`).
   `--dry-run` prints every step first.
3. `systemctl --user restart phosphor-os-server` (when idle: it stops the running chats).

Undo: `bash scripts/setup-local-model.sh --undo` (model files stay). Re-running the script is safe: it rewrites the
unit, the preset and the `.env` lines (an older single-model install moves to the new layout).

## What it is

| Part | Choice | Why |
|---|---|---|
| Engine | llama.cpp, ROCm backend (Arch `llama-cpp` + `ggml-hip`) | Speaks Claude's API (`/v1/messages`); vLLM did not fit a 20 GB card |
| Models | Unsloth `Qwen3.8-27B-UD-IQ3_S.gguf` (12 GB); `Qwen3.6-35B-A3B-UD-IQ3_S.gguf` (13.7 GB, mixture of experts); `gemma-4-26B-A4B-it-UD-IQ4_XS.gguf` (13.6 GB, mixture of experts, about 16 GB VRAM loaded); `gemma-4-E4B-it-Q4_K_M.gguf` (5 GB, about 5.5 GB VRAM loaded) | Q4 of the 27B (17 GB) leaves too little VRAM for a long chat |
| Speed-up (27B only) | MTP: `mtp-Qwen3.8-27B-Q4_0.gguf` guesses 3 words ahead, the big model checks them | Same answers, faster. Measured 69 tok/s, 89% of guesses kept |
| Context | 98304 tokens, KV cache q8_0 | About 18.8 GB VRAM (27B) or 16.1 GB (35B) in use with the desktop running |
| Chat template | `os/local-model/qwen3.8-chat-template.jinja`, both models | Stock one refuses the mid-chat system notes Claude Code sends (HTTP 500) |
| Service | `phosphor-local-model.service` (user), port 8081, 127.0.0.1, API key | One llama-server in router mode, see below |

## Router mode: how two models share one port

The service runs `llama-server --models-preset ~/.config/phosphor-os/local-models.ini --models-max 1`. The preset file
has a `[*]` section (GPU, context, cache types, template, 15 min idle sleep) and one section per model. The `model` field
of a request (`qwen3.8-27b`, `qwen3.6-35b`, `gemma4-26b`, `gemma4-e4b`) selects the section; llama-server starts a child process for it and stops the
other one first (`--models-max 1`). The settings stay per model: the MTP draft file and `spec-type` are only in the 27B's
section. The 35B's section sets a default thinking level of low for callers that send none (the template's own default
is xhigh); Claude Code through the picker always sends a level. `GET /v1/models` (with the key) lists both with
`status.value` loaded or unloaded. Something else calling the server (Home Assistant, curl) names the model it wants;
`qwen3.8-27b` is the 27B. Add a model: a new section in the preset and a `name=label` in `PHOSPHOR_LOCAL_MODELS`.

## How the picker works

`.env` gets `PHOSPHOR_LOCAL_URL`, `_MODELS`, `_KEY`, `_CONTEXT`. `PHOSPHOR_LOCAL_MODELS` is `name=label,name=label`: the name
is what a request calls the model (a preset section), the label is the picker text. The first entry is the picker value
`local` (so saved tabs keep working), the others are `local:<name>`. An older `.env` with `PHOSPHOR_LOCAL_MODEL` and
`_LABEL` (one model) still works. `server/config.ts` reads them; `server/tabs.ts` adds the entries to `/api/models`;
`server/tab.ts` starts that tab's Claude Code with `ANTHROPIC_BASE_URL` pointing at the local server and the chosen
model name as every Claude model alias. Switching a chat between Claude and a local model, or between the two local
models, restarts its Claude Code process and resumes the same session. AUTO only picks Claude models; choosing a
local model turns AUTO off for that tab.

## Thinking levels

The picker shows THINK: LOW, MEDIUM, XHIGH for both local models (Qwen's own levels; the default is XHIGH, the slowest).
The levels are a line the chat template puts in the system prompt; Qwen3.8 is trained for it, Qwen3.6 follows it as a
plain instruction (it gets the same template), so its levels may differ less.
Claude Code sends the level on every request (`output_config.effort`). `server/localrelay.ts` (127.0.0.1, server
port + 1) turns it into the chat template's `reasoning_effort` and forwards the request. HIGH and MAX count as XHIGH.
Changing the level needs no restart. Tested live: the Qwen3.6 answer to the same question took 412 tokens at LOW and 873 at XHIGH, so the level reaches the template.

## On and off

`bash scripts/local-model.sh on|off|status|unload`. Off stops the service and frees the GPU at once (19 GB -> 1.5 GB).
Unload keeps the router running and gives back every model it holds.
On starts the router only; a model loads on the first request that names it. Idle: each model's child sleeps after
15 minutes (`sleep-idle-seconds` in the preset): GPU memory drops to about 1.9 GB, the model shows as `sleeping`
in `/v1/models`, and the next request wakes it (about 17 s measured for the 35B). The relay answers "not reachable" while the service is off.

Gemma uses the chat template inside its own file (the Qwen template is set per Qwen section). The THINK levels
are Qwen's: Gemma ignores them (it thinks on its own; tested: a short answer came back with a thinking block).

## Strata: a 125B model beside the router (optional)

[Strata](https://github.com/Niko1221/Strata) runs one model family, Qwen3.8-Flash-Next (125B mixture of experts,
about 6B active per token), on a card far smaller than the model: it keeps the experts used most on the GPU, the
rest in RAM, and reads what does not fit from the SSD. `bash scripts/setup-strata.sh` (`--dry-run`, `--undo`)
installs one size and adds its picker entry; run it again with another size for a second entry (e.g.
`STRATA_FAMILY=qwen STRATA_MODEL=IQ3_XXS`). Settings are environment variables at the top of the script (folder,
model files, size, port, context); the files can live on another drive (`STRATA_DATA_DIR`). Sizes share the engine
and a 29 GB file.

| Part | Choice | Why |
|---|---|---|
| Engine | Strata, pinned release, compiled for the card (HIP on AMD) | the only engine built around this model's small experts |
| Model | ISTA-DASLab's Coder (`IQ1_M` by name, experts stored like IQ3_S; 256 of the 512 experts per layer kept, chosen for code and tools; 23 GB of experts, plus a 29 GB table read from the SSD) | Strata's pick for a 32 GB PC; weaker outside code. `STRATA_FAMILY=qwen` installs a size with every expert (`IQ2_XS`: 35.5 GB of experts, `IQ3_XXS`: 43 GB; see the RAM note below) |
| Server | its own per size: the Coder on port 8082, a qwen size on 8083; `phosphor-strata-<size>.service` (user), not started at login | not a llama.cpp model, so not in the router |
| VRAM reserve | 3072 MiB | Strata's docs: an AMD card that drives the desktop lost the compositor with less |
| Idle | unloads after 15 minutes (`idle_unload_s`), RAM and GPU go back | it holds tens of GB |
| Context | 131072 (`STRATA_CONTEXT`) | the window Claude Code compacts to (`PHOSPHOR_LOCAL_CONTEXTS`). Past 32K the older KV cache lives in RAM (`--kv-resident 32768`, about 13.7 KB a token, 1.7 GB at 128K), not on the card. A 57K-token prompt read in 74 s (Coder) and 90 s (`IQ3_XXS`) |
| Output cap | `fit_max_tokens` | Claude Code asks for 32000 output tokens on every request; Strata refused (400) once prompt + 32000 passed the context. With the switch it shortens the output to the room left |

One model on the GPU at a time: the relay sends a request for the Strata entry to Strata's server
(`PHOSPHOR_LOCAL_URLS`), and before that has the router unload its models and starts the service when it does not
answer (`PHOSPHOR_LOCAL_UNITS`; the first start reads tens of GB and takes 1-3 minutes, the activity line says
"Loading local model"). Another Strata size unloads first too. Before a router model runs, the relay asks Strata to unload (`POST /unload?wait=300`, a
running answer finishes first). Strata also runs `local-model.sh unload --keep <its own URL>` before it loads
(`before_load` in its config), for callers that do not go through the relay: the router and the other sizes unload. Callers that talk to the router directly (Home Assistant)
are not covered the other way: while Strata holds the GPU, such a request would load a second model. Tests:
`npx tsx tests/localrelay.ts`.

Measured on one PC (20 GB AMD card, 31 GB RAM unless noted, model files on an NVMe SSD), all through Claude Code:

| Size | First prompt (Claude Code's, 16-22K tokens) | Writing | RAM tier that fit |
|---|---|---|---|
| Coder | 16.6K tokens in 25 s; later turns 2 s | 52-62 tok/s; a 4-turn bug fix (read, edit, run) took 36 s | 11.2 of 12.8 GB |
| `IQ3_XXS` (48 GB RAM) | 17K tokens in about 28 s; later turns 1-2 s | 53-65 tok/s (828 tokens of code at 59 tok/s); the same bug fix took 40 s | 31.4 GB, all of it |
| `IQ2_XS` | 22K tokens in 80 s | 1-3 tok/s; the engine stopped once (`verify: timed out`, #267) and Strata restarted it | 7 of 21.5 GB |

With `IQ2_XS` most experts a code prompt needs are read from the SSD for every token; the Coder's fit in RAM and
VRAM. A short plain-English answer from `IQ2_XS` ran at 44 tok/s, so a quick chat test does not show this. Strata keeps
the reading of earlier turns (at each turn's end, every 16K tokens and the end of the system prompt), so a chat's later
turns read only what is new.

RAM: a size runs fast when the part of its experts the card does not hold fits in RAM (the start log's
`FileExpertSource` line says how much did); Strata's own table: 48 GB of RAM for `Q2_0` and `IQ2_XS`, 64 GB for every
size. Quality, Strata's measurement (same top token as Q8_0): `IQ3_S` 87.7%, `IQ3_XXS` 84.5%, `Q2_0` 80.6%.

Picker entries from this installer live in `PHOSPHOR_LOCAL_MORE_MODELS` (labels without commas: the lists split on
them), so re-running `setup-local-model.sh` keeps them. An install from before per-size units
(`phosphor-strata.service`) moves to the new unit when the installer runs again for that size. Strata's THINK levels: low, medium, high (XHIGH and MAX count as high). No pictures (Strata's AMD image
encoder runs on the CPU; turned off here).

## Speed in the SYS panel

With a local model set up, SYS shows its speed under LOADED (`server/localmeter.ts`, measured in the relay on a copy
of each streamed answer; only numbers and the model name are kept). While a request runs: LOADING MODEL, READING
PROMPT, THINKING or WRITING, the live speed over the last 3 s, tokens so far (estimated from the stream, about 4
characters a token) and time since the request came in. After it (dim): LAST `write` = answer tokens / time from the
first to the last piece, `read` = prompt tokens read (cache left out) / time to the first token (`~`: estimated this
way; without `~` the model server sent its own number), `first token` = time from sending to the first piece of
thinking or text (a model switch before that is not counted), then the server's token count and the total time.
RECENT is the middle value of the last 5 finished requests, so one odd request does not move it. LAST STOPPED /
FAILED: the answer was cancelled or broke. Tests: `npx tsx tests/localmeter.ts`.

## Traps

- Claude Code assumes a 200k window; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set to the local context so it compacts in time.
- Local thinking blocks have empty signatures. Switching a chat back to Claude after local turns may be refused
  by the Claude API (untested). Start a new chat if it is.
- A 27B model at 3-bit is weaker than Claude at long, many-step jobs (untested here; quality is not measured).
- Another quant or engine (EXL3 + DFlash via TabbyAPI) was faster at long context in one third-party test; not tried.
