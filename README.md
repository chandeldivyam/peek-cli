# peek-cli

Deep video analysis CLI powered by Gemini.

## Install

Prerequisite: Node.js 20+.

```bash
curl -fsSL https://raw.githubusercontent.com/chandeldivyam/peek-cli/main/install.sh | bash
```

The installer downloads the latest GitHub Release asset and installs `peek` into `~/.local/bin` by default.

## Usage

```bash
peek video.mp4
peek analyze video.mp4 --json
peek ask video.mp4 "What is being advertised here?"
peek inspect video.mp4
peek install
```

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
