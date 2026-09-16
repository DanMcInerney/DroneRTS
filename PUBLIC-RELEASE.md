# Public release preparation — September 16, 2026

Prepared from DroneRTS `e496116` in a separate worktree. This change updates documentation, media, license/package metadata, and repository automation. Gameplay, model configuration, and the Nervelet pin are unchanged. The GitHub repository remains private; this preparation does not publish it or submit anything to Hacker News.

## Prepared

- New README with the orchflows credit, early Zenoh/MAVLink explanation, network diagram, quick start, and source-specific gameplay evidence.
- Embedded demo GIF from 1:10 through the end (23.4 seconds), plus the complete 93-second MP4 in an expandable native GitHub player. The full clip is 4,335,472 bytes, H.264/AAC at 1920 × 1080, with the original duration and audio retained. Its SHA-256 is `5ea943a3fdbf90f15fb07e9936a15bbb438c31366142cb6da110c5f7414a6e2f`.
- MIT license selected by the maintainer, matching package metadata, geographic/source notices, contributor instructions, and security reporting guidance.
- Original README preserved as `GUIDE.md`; historical QA reports retain their existing paths and contents.
- Windows/Linux CI with Node 24, Python 3.12, exact-revision GitHub Actions, read-only repository permissions, verified Nervelet setup, production build, and native protocol tests without inference.
- Issue and pull-request templates. Gitleaks configuration retains default rules and excludes only the exact public RFC WebSocket example value in its fixture file.

## Local verification

Windows, Node **24.15.0**, Python **3.14.6**:

- Built the pinned Nervelet revision from its public GitHub source; the expected archive SHA-256 matched.
- Fresh `npm ci` and `npm run network:setup` succeeded. The updated package/lockfile also passed `npm ci --ignore-scripts`.
- **535/535 tests passed** with `npm test -- --test-concurrency=2`, without model inference.
- `npm run build` passed. Vite's existing large-chunk advisory remains.
- `npm audit` reported zero known vulnerabilities in the installed JavaScript dependency graph. This is a dated registry result, not a general security certification.
- Gitleaks **8.30.1** scanned all available Git refs and a snapshot of the current tracked/new deliverable files. Its one initial finding was the public RFC 6455 WebSocket nonce in `tests/trial-host.test.ts`; the narrowly configured scans pass after that classification. No real credentials were identified by these scans.
- Local Markdown file links and anchors were checked; workflow YAML parsed; GitHub's Markdown API rendered the animated preview and full-video link. The complete recompressed video decoded without errors.

The raw native-test result is in the newest managed `artifacts/test-runs/` directory. Hosted GitHub Actions have not been dispatched; Linux CI execution remains unverified. No live match was started for this preparation.

## Before public launch

1. **Resolve Nervelet's license.** Exact revision `6c36b0a4845c72ac2aa9fba85df7ea3d8389ff8c` has no license declaration. Obtain upstream licensing that covers it, or qualify a licensed revision and update the pin, integrity, notices, and measured package manifest together. DroneRTS's MIT license does not resolve this dependency's terms.
2. Review and merge this change, then let both hosted CI jobs finish. Enable private vulnerability reporting before relying on the reporting link in `SECURITY.md`.
3. Make the repository public only when ready. Check the clone/setup path and README media from a signed-out browser afterward.

The full video was uploaded with `gh api` to GitHub's user-attachment endpoint and embedded using the returned URL. No browser sign-in, issue, or comment was required. The repository-backed GIF and MP4 download are also retained. [Media notes](docs/media/README.md) record the clip boundaries and attachment URL.

Suggested Hacker News title:

> Show HN: Six LLM drone pilots, peer-to-peer radio, and MAVLink in a Three.js RTS

Keep the submission linked to the public repository and the measured results. The demo is an illustration; the dated QA reports establish which autonomy claims have actually been tested.
