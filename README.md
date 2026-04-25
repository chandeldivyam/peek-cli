# peek-cli

Media analysis and generation CLI powered by Gemini, Veo, and xAI.

## Install

Prerequisite: Node.js 20+.

Remote sources also require system tools:

- `yt-dlp` for YouTube and Instagram video downloads
- `ffmpeg` for merged remote video outputs
- `instaloader` for Instagram photo posts and photo carousels

```bash
curl -fsSL https://raw.githubusercontent.com/chandeldivyam/peek-cli/main/install.sh | bash
```

The installer downloads the latest GitHub Release asset and installs `peek` into `~/.local/bin` by default.

## Usage

```bash
peek image.jpg
peek video.mp4
peek https://www.instagram.com/reels/DSzu-VrjCdX/
peek https://www.instagram.com/p/DWjuLqzEbJb
peek https://www.youtube.com/shorts/SJT-eFH4Zs0
peek analyze image.jpg --json
peek ask video.mp4 "What is being advertised here?"
peek inspect https://www.instagram.com/p/DWjuLqzEbJb
peek cache clear https://www.youtube.com/shorts/SJT-eFH4Zs0
peek create image --provider gemini "A bold product poster for a coffee brand"
peek create image --provider xai "A bold product poster for a coffee brand"
peek create video --provider gemini "A cinematic shot of a shoe rotating on a pedestal"
peek create video --provider xai --duration 10 "A cinematic shot of a shoe rotating on a pedestal"
peek --agent-help
peek install
```

`peek` accepts either local image/video file paths or supported remote URLs. Multi-asset sources such as Instagram carousels are analyzed as one ordered bundle report.

## Generation

Generation requires an explicit provider for agent workflows. Gemini uses `GEMINI_API_KEY`; xAI uses `XAI_API_KEY`. You can set those environment variables or store keys locally. Bare `peek auth` prompts for both provider keys; use `--provider` to configure just one:

```bash
peek auth
peek auth --provider gemini
peek auth --provider xai
```

```bash
peek create image --provider gemini "A bold product poster for a coffee brand"
peek create image --provider gemini "Turn this into a polished launch graphic" --input ./reference.jpg --model pro
peek create image --provider gemini "A flat icon set for a payments app" --count 3 --output ./artboards --json

peek create image --provider xai "A bold product poster for a coffee brand"
peek create image --provider xai "Render this as a pencil sketch" --input ./reference.jpg --size 2k
peek create image --provider xai "A flat icon set for a payments app" --count 3 --output ./artboards --json

peek create video --provider gemini "A cinematic shot of a shoe rotating on a pedestal"
peek create video --provider gemini "Animate this packaging render" --image ./packshot.png --model fast
peek create video --provider gemini "Move from frame A to frame B" --image ./start.png --last-frame ./end.png
peek create video --provider gemini "Keep the same character and scene language" --reference ./ref1.jpg --reference ./ref2.jpg --duration 8
peek create video --provider gemini "Extend this clip by another beat" --video ./clip.mp4 --duration 8 --resolution 720p

peek create video --provider xai "A cinematic shot of a shoe rotating on a pedestal" --duration 10 --resolution 720p
peek create video --provider xai "Animate this packaging render" --image ./packshot.png --duration 8
peek create video --provider xai "Keep the same character and scene language" --reference ./ref1.jpg --reference ./ref2.jpg --duration 8
peek create video --provider xai "Extend this clip by another beat" --video ./clip.mp4 --duration 8 --resolution 720p
```

Model aliases:

- `peek create image --model flash` -> `gemini-3.1-flash-image-preview`
- `peek create image --model pro` -> `gemini-3-pro-image-preview`
- `peek create image --provider xai --model imagine` -> `grok-imagine-image`
- `peek create video --model fast` -> `veo-3.1-fast-generate-preview`
- `peek create video --model quality` -> `veo-3.1-generate-preview`
- `peek create video --model lite` -> `veo-3.1-lite-generate-preview`
- `peek create video --provider xai --model imagine` -> `grok-imagine-video`

Generated files are written to `./peek-output/...` by default, or to the path supplied with `--output`. Those outputs can be fed straight back into `peek`, `peek ask`, and `peek inspect`.

## Agent Help

`--agent-help` prints deterministic, agent-oriented usage guidance with provider constraints and examples:

```bash
peek --agent-help
peek create --agent-help
peek create image --agent-help
peek create video --agent-help
```

## Remote Notes

- Public YouTube videos and Shorts are supported through `yt-dlp`.
- Public Instagram reels and video posts are supported through `yt-dlp`.
- Public Instagram photo posts and photo carousels are supported through `instaloader`.
- Private, age-restricted, or region-blocked remote media is not supported in this version.

## Updating

If `peek` is already installed, users can upgrade to the newest GitHub Release with:

```bash
peek install
```

They can also install a specific tagged release:

```bash
peek install --version v0.1.3
```

## Release Flow

1. Merge changes to `main`.
2. Create and push a tag like `v0.1.3`.
3. GitHub Actions builds the CLI, creates `peek.tgz`, and publishes a GitHub Release.
4. `install.sh` resolves that latest release asset automatically.
