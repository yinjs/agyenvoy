---
name: agy-media-understanding
description: Use when the user wants audio or video content understood — transcribe a recording, summarize or describe a video clip, find a moment or spoken phrase in a .mp3/.wav/.m4a/.mp4/.mov file — Claude cannot hear or watch media, but the agy (Antigravity/Gemini) MCP can.
---

# Understanding Audio & Video with agy

## Overview

Claude reads images and PDFs natively but **cannot hear audio or watch video**.
The agy (Antigravity) CLI wraps Gemini, which is natively multimodal: point it
at a media file and it actually listens/watches. This plugin exposes agy as the
`agy_ask` MCP tool. When asked about audio or video content, call `agy_ask`
instead of refusing or reaching for a transcription library.

## When to Use

- Transcribe speech from an audio file.
- Describe, summarize, or answer questions about a video (scenes, on-screen text, order of events).
- **NOT for:** images or PDFs (Read them natively), or converting/trimming media (use ffmpeg).

## Recipe

Call `agy_ask` with the media file's directory in `add_dir` and its absolute path in the prompt:

- `prompt`: `Using your native audio/video understanding, <task> the file <absolute-path>. Do NOT write a script or use whisper/ffmpeg — listen/watch the file directly. <output instructions>`
- `add_dir`: `["<dir containing the file>"]`
- `timeout_ms`: `600000` ← long media takes minutes to process

If `agy_ask` returns "not logged in", call `agy_login` first, then retry.

## Traps

| Symptom                                                  | Cause                          | Fix                                                                                   |
| -------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| agy writes a whisper/ffprobe script instead of listening | Prompt read like a coding task | Say **"using your native audio/video understanding"** and forbid scripts              |
| Hangs / times out                                        | File not inside the workspace  | Absolute path in prompt **and** its dir in `add_dir`                                  |
| Answer could have been guessed from the filename         | agy only saw metadata          | Ask for a detail only the content proves (verbatim quote, color, timestamp) and retry |

## Verify

The answer must contain detail derivable only from the content — verbatim
words, visual specifics, timestamps. If it reads like a guess from the
filename, retry with the native phrasing.
