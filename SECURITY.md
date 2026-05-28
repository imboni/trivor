# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.0.x   | Yes       |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Instead, use [GitHub Security Advisories](https://github.com/imboni/trivor/security/advisories/new) (preferred) or contact the maintainer via GitHub.

We will acknowledge reports as soon as possible and work on a fix before public disclosure when appropriate.

## Scope

- Local file handling and sandbox boundaries
- Tauri / WebView attack surface
- Dependency vulnerabilities in direct build tooling

Out of scope: malicious 3D model files designed to exploit GPU or browser engines (report upstream to model-viewer / Chromium when applicable).
