# Local image generator (pictures on your own GPU)

**Optional. Skip this file unless you want to make pictures on your own machine.** What it takes: Arch or Omarchy, an
AMD GPU with about 16 GB of VRAM free (ROCm), about 24 GB of RAM free while it paints, and about 19 GB of disk for the
model files (downloaded to `~/models/image`, or the `image/` folder in `PHOSPHOR_MODELS_DIR`). The sizes and speeds
below were measured on one 20 GB AMD card; yours will differ.

One entry in the model picker, "Qwen-Image 2.1 (local)". In a tab set to it, a message is not sent to Claude: the
text is the description of a picture, and the picture appears in the chat. Tap it for full size; SAVE downloads the
PNG; SHOW IN FOLDER (desktop app) opens the folder it is in. Attach a picture to change it ("make it night", "replace
the text with ...") instead of starting from nothing.

## Set up

1. ROCm with the compiler: `sudo pacman -S rocm-hip-sdk cmake` (the llama.cpp ROCm packages from
   [LOCAL-MODEL.md](LOCAL-MODEL.md) bring most of it).
2. `bash scripts/setup-image-model.sh` (compiles the engine for your card, 10-20 minutes; downloads about 19 GB; installs
   the service; writes `.env`). `--dry-run` prints every step first.
3. `systemctl --user restart phosphor-os-server` (when idle: it stops the running chats).

Undo: `bash scripts/setup-image-model.sh --undo` (the engine and the model files stay; it prints the `rm` line). The
pictures you made stay in `data/images/`.

## What it is

| Part | Choice | Why |
|---|---|---|
| Model | [Qwen-Image 2.1](https://github.com/QwenLM/Qwen-Image-2.1) (Alibaba, September 2026; 7B), GGUF Q8_0 (7.7 GB) | The best open-weight model on the Artificial Analysis text-to-image board (October 2026); text in pictures, photos, editing one picture or up to 10 in one model |
| Text encoder | Qwen3-VL 8B Instruct, Q8_0 (8.7 GB) + its vision part (1.2 GB) | The model reads the prompt (and the attached picture) with it |
| Default mode | The makers' Turbo LoRA (0.9 GB): 8 steps, no CFG | About 21 s a picture; in the tests here as good as the full model. `--best` runs the full model (30 steps, CFG 4, about 2.5 min) |
| Engine | [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) `sd-server`, compiled for the card (HIP), pinned to one commit | Small C++ server like llama.cpp: no Python, a job API with steps, runs on ROCm |
| Service | `phosphor-image.service` (user), port 8084, 127.0.0.1 only, not started at login | The app starts it for a picture and stops it after 5 idle minutes |
| Pictures | `data/images/` (or `PHOSPHOR_IMAGE_DIR`), named `<date>_<time>_<first words>_<seed>.png` | Inside the app's own data folder, never committed |

License: Qwen-Image 2.1's weights are under the Qwen Research License (non-commercial). For pictures you sell or use in
paid work, read its terms first.

## How to use it

Pick "Qwen-Image 2.1 (local)" in the tab's model picker. Write what the picture should show; the more you describe
(place, light, style, any words that must appear, in quotes), the better it follows. Words that start with `--` set
the picture and are taken out of the prompt:

| Word | What it does |
|---|---|
| `--wide` / `--tall` / `--square` | 16:9 (1344x768), 9:16 (768x1344), 1:1 (1024x1024, the default) |
| `--size WxH` | Any size, for example `--size 1600x900` (rounded to 32, sides 256 to 2752) |
| `--hd` | Twice the size per side (2048x2048 square; the model's own size). About 7 times slower; see the table |
| `--best` | The full model, 30 steps, without the Turbo LoRA. About 6 times slower; try it when a picture or an edit is not right |
| `--steps N` | Steps (default 8, or 30 with `--best`; 1 to 100) |
| `--seed N` | The same seed and prompt give the same picture; the seed of each picture is shown under it |

Example: `a lighthouse at sunset with a sign reading "PHOSPHOR" --wide --seed 42`.
With an attached picture the result keeps its shape (about one megapixel, or 4 with `--hd`) unless a shape word says
otherwise. Pictures wait their turn: send several, they are made one after the other. STOP drops the ones still
waiting; a picture being painted finishes (the engine cannot stop one halfway). When you switch the tab back to
Claude, its next message tells Claude where the pictures are, so it can use them.

## Speed and memory (one 20 GB AMD card)

Measured 2026-10-19 with the desktop running, model files in the page cache unless noted, through the engine's job
API. VRAM is the whole card's use at its peak (the desktop alone uses about 1 GB).

| Picture | Time | Peak VRAM |
|---|---|---|
| 1024x1024, default (Turbo, 8 steps) | 21-24 s (2.3 s a step) | 12.1 GB |
| 1344x768 `--wide`, default, engine not running yet (start + first read of 17 GB) | 66 s | |
| 1024x1024 `--best` (30 steps, CFG 4), first picture | 177 s (4.0 s a step; the first read of the weights took 28 s of it) | 9.9 GB |
| 2048x2048 `--hd`, default | 145 s (16 s a step; the VAE decode ran out of memory once and retried in tiles) | 15.6 GB |
| Edit of a 1024x1024 picture, default | 38 s | 18.5 GB |
| Edit of a 1024x1024 picture, `--best` 20 steps | 113 s | 19.9 GB |

The engine holds about 17 GB of RAM and 1.5 GB of VRAM while it waits between pictures; stopped, it holds nothing.

Quality, judged by eye on these tests: text in the picture was spelled right every time ("PHOSPHOR", "PHOSPHOR-OS"),
photos look like photos, the prompt was followed. Edits kept the composition and the text, but looked over-processed
(strong HDR look, and the night edit kept a daylit foreground): weaker than text-to-image. The `--hd` test showed
banding in a smooth sky.

## The GPU is shared

The card holds one engine at a time: the chat models (router, Strata) or the image model. The app hands it over
(`server/gpu.ts`): before a picture, the chat models unload (a Strata answer still running finishes first;
llama.cpp router requests through the app finish first); before a local chat model runs again, the image engine
stops. A running request is never cut off: the other waits. The first message to a local chat model after a picture
loads that model again (the activity line says "Loading local model"). `bash scripts/local-model.sh unload` stops
the image engine too (after the picture it is painting). Callers that talk to the llama.cpp router directly (Home
Assistant) are not covered: while a picture is made, such a request would load a second model.

The engine keeps its weights in RAM while it runs (about 18 GB, `--offload-to-cpu`) and moves each part to the card
when it is needed, so the whole set fits a 20 GB card next to the desktop. Its service has a RAM cap (28 GB) so a
full RAM ends the engine, not the desktop.

## Traps

- stable-diffusion.cpp's server has no key of its own. It listens on 127.0.0.1 only and is stopped when idle.
- The engine's own steps are only reported through its preview: the app asks for the cheapest one (a projection of
  the latents) to show "PAINTING 12/30".
- Changing the engine version: set `SD_VERSION` (a commit) and run the setup again; it recompiles.
- Another GPU: change the `cmake` line in the setup script (`-DSD_VULKAN=ON` or `-DSD_CUDA=ON`).
