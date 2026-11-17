# Local video generator (short clips on your own GPU)

**Optional. Needs the local image generator first ([IMAGE-MODEL.md](IMAGE-MODEL.md)): it uses the same engine.** Also needs ffmpeg and about 16 GB of disk for the model files (in `~/models/video`, or the `video/` folder in `PHOSPHOR_MODELS_DIR`).

One entry in the model picker, "Wan 2.2 video (local)". In a tab set to it, a message is not sent to Claude: the text is the description of a short clip, and the clip plays in the chat (on a loop, muted). SAVE downloads the MP4.

- Words only: a clip from nothing.
- Words and a photo: the photo is the first frame, and the words say what moves ("she turns and smiles, the camera slowly pushes in").
- Words and a clip: the clip is changed ("make it night, rain on the street"). Its outlines keep the motion and layout; its first frame keeps the look of the people and things in it. Up to the first 5 seconds of the clip.

## Set up

1. The image generator: `bash scripts/setup-image-model.sh` (see [IMAGE-MODEL.md](IMAGE-MODEL.md)).
2. `bash scripts/setup-video-model.sh` (downloads about 16 GB; installs two services; writes `.env`). `--dry-run` prints every step first.
3. `systemctl --user restart phosphor-os-server` (when idle: it stops the running chats).

Undo: `bash scripts/setup-video-model.sh --undo` (the model files stay; it prints the `rm` line). The clips you made stay in `data/images/`.

## What it is

| Part | Choice | Why |
|---|---|---|
| Clip model | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) (Alibaba), GGUF Q8_0 (5.4 GB) + its VAE (1.4 GB) | Words or a photo to video in one small model; 24 fps; fits a 16-20 GB card |
| Edit model | Wan 2.1 VACE 1.3B, GGUF Q8_0 (2.4 GB) + the Wan 2.1 VAE (0.3 GB) | Changes a clip, guided by the clip's outlines (ffmpeg's edge filter) and its first frame; 16 fps |
| Text encoder | umT5-XXL, GGUF Q8_0 (6 GB) | Shared by both |
| Engine | The image model's [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) `sd-server` (same build) | Its job API has a video mode (`/sdcpp/v1/vid_gen`) |
| Services | `phosphor-video.service` (port 8085), `phosphor-video-edit.service` (8086), 127.0.0.1 only, not started at login | The app starts the one it needs and stops it after 5 idle minutes |
| Clips | `data/images/`, next to the pictures, as H.264 MP4 (ffmpeg converts the engine's WebM; plays on phones too) | |

License: Wan 2.2 and Wan 2.1 are Apache 2.0.

## How to use it

Words that start with `--` set the clip and are taken out of the prompt:

| Word | What it does |
|---|---|
| `--wide` / `--tall` / `--square` | 832x480 (the default), 480x832, 640x640 |
| `--hd` | 1280x704 (720p, the 5B model's own size), 704x1280, 960x960. Much slower |
| `--size WxH` | Any size up to 1280 a side (rounded to 32) |
| `--long` | About 4 seconds (97 frames) instead of about 2 (49) |
| `--frames N` | Frame count (rounded to 4n+1; up to 121 for new clips, 81 for edits) |
| `--best` | 40 steps instead of 20 |
| `--steps N` / `--seed N` | As for pictures |

With an attached photo or clip, the result keeps its shape unless a shape word says otherwise. Example: attach a photo, then `the man laughs and raises his glass, warm bar light, handheld camera --long`.

Clips and pictures share one queue and the card: one engine runs at a time, the others stop first (`server/imagegen.ts`). The chat models unload before a clip, as before a picture (see "The GPU is shared" in [IMAGE-MODEL.md](IMAGE-MODEL.md)). `bash scripts/local-model.sh unload` stops the video engines too.

## Untested

Written 2026-11-17 without running the engine on the GPU (the owner tests). Not yet known: speed, peak VRAM and RAM, whether Wan's VAE decode fits in tiles (`vae_tiling_params`), whether the edge-guided edits look good, and whether the engine shows steps for clips (the activity line may stay at "Painting" with no count). Measure and fill in a table like the image model's.

## Traps

- Uploads are capped at 30 MB (`server/uploads.ts`): trim or shrink a long phone clip first.
- Wan's negative prompt is the makers' default, in Chinese as the models were trained (`server/videogen.ts`).
- A bigger model later (Wan 2.2 14B, LTX-2.5): the engine supports them (its `docs/wan.md`, `docs/ltx2.md`); add the files and a unit the same way. `--offload-to-cpu` keeps the weights in RAM and moves them to the card part by part, so a model larger than the card can still run, slower.
