---
name: agy-second-opinion
description: Use when the user wants a second opinion from a different model family — "ask gemini", "what does agy think", "cross-check this plan/diff/answer with another model" — the agy (Antigravity) MCP dispatches Gemini and GPT-OSS models.
---

# Second Opinions via agy

## Overview

agy exposes non-Anthropic models (Gemini Pro/Flash, GPT-OSS — see
`agy_list_models`). A cross-family review catches blind spots that every model
in one family shares. Use `agy_ask` to get a written opinion, then report it
back with attribution.

## Recipe

1. **Give it the context.** Put the relevant files' directory in `add_dir` and
   name each file by absolute path in the prompt. For a diff or plan that isn't
   a file, paste it into the prompt verbatim.
2. **Call `agy_ask`:**
   - `model`: an exact string from `agy_list_models`. `Gemini 3.1 Pro (High)`
     for depth, `Gemini 3.5 Flash (High)` for speed. Skip the Claude entries —
     same family is not a second opinion.
   - `prompt`: frame it as review, not work:
     `You are giving a written second opinion — do NOT edit any files. <question, with context paths or pasted content>. End with a verdict (agree/disagree) and your top 3 concerns.`
   - `timeout_ms`: `600000`
3. **Report with attribution.** Separate agy's points from your own, deliver
   its disagreements verbatim rather than softened, and state where you concur
   or push back.

To debate a point, call `agy_ask` again with `continue_conversation: true`.

## Traps

| Symptom                        | Cause                                  | Fix                                                              |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------------------- |
| agy starts editing files       | It's an agent; prompt read like a task | Lead with "written second opinion — do NOT edit any files"       |
| Opinion is generic boilerplate | agy never saw the actual code/plan     | `add_dir` + absolute paths, or paste the content into the prompt |
| "model not found"              | Guessed model name                     | Run `agy_list_models`, copy the exact string                     |
