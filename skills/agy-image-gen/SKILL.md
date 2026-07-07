---
name: agy-image-gen
description: Use when the user asks to generate or edit an image — illustration, photo, logo, icon, concept art — from a text description. Claude has no native image tool, but the agy (Antigravity/Gemini) MCP produces real raster images.
---

# Generating Images with agy

## Overview

Claude has **no image-generation tool**. The agy (Antigravity) CLI wraps Google's
Gemini native image model and _can_ produce real raster images from a text prompt.
This plugin exposes agy as the `agy_ask` MCP tool. When asked for an image, call
`agy_ask` instead of refusing.

## When to Use

- User wants a generated image/illustration/photo/logo/icon/concept art from a description.
- User wants a placeholder, hero, avatar, or asset image for a site or doc.
- **NOT for:** charts/plots/diagrams _from data_ (write code — matplotlib/mermaid/SVG),
  or flat geometric/vector shapes (agy writes code for those too — see Traps).

## Recipe

Call `agy_ask` with the target directory in `add_dir` and an absolute save path in the prompt:

- `prompt`: `Using your native image generation model, create <rich photographic description>. Save the image to <absolute-dir>/<name>.png. Do NOT write a script or use matplotlib/PIL.`
- `add_dir`: `["<absolute-dir>"]` ← same dir as the save path
- `timeout_ms`: `600000` ← generation takes ~30–90s; give ≥5 min

Without both `add_dir` and an absolute save path, agy dumps the image to its own
scratch dir instead of where you want it.

If `agy_ask` returns "not logged in", call `agy_login` first, then retry.

## Traps

| Symptom                        | Cause                                                                                    | Fix                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tiny PNG (few KB), flat shapes | Simple/geometric prompt → agy writes matplotlib/PIL code instead of calling the AI model | Say **"Using your native image generation model"** and describe a rich, photographic scene |
| Image saved elsewhere          | No workspace set                                                                         | Pass `add_dir` **and** an absolute path in the prompt                                      |
| Command hangs / times out      | Prompt referenced an input file not in the workspace                                     | Only reference paths that exist; put any input image in the `add_dir` dir                  |

## Verify

Always confirm after the call:

```bash
file <name>.png   # expect: "PNG image data, 1024 x 1024, 8-bit/color RGB"
```

A real AI image is typically ~1 MB at 1024×1024. A **few-KB file means the
matplotlib trap fired** — retry with the native-model phrasing.

## Notes

- Image generation selects the Gemini image model automatically — you don't pick it
  via the `model` param. `model` only affects text responses.
- Editing an existing image uses the same recipe (reference the input path, which
  must be inside the `add_dir` dir). Verify the output actually changed.
