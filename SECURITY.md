# Security

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security → Advisories) on this repository rather than in a public issue.

## Model

- Each panel is served from `127.0.0.1` on a random port. Every request must carry that panel's random token.
- The extension reads your repositories with `git` and stores its data locally in `artifacts/` (or `MARGINAL_DATA_DIR`). It makes no network requests of its own.
- Writes to your repositories are limited to hidden checkpoint refs under `refs/marginal/checkpoints/`. Branches, HEAD, the index and working trees are never modified.
- Messages sent from a panel's chat go to that panel's own Copilot session.