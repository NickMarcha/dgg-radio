# Project instructions

## Engineering principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

Source: https://x.com/MarcosHernanz/status/2083954734487212511

## External-source hygiene

- Cache website responses in an OS temporary directory, keyed by the full URL and any request options that affect the response. Reuse the cached response during the task. Refresh it only when freshness matters or the user asks for a refresh. If a fetch tool exposes a stable result reference or its own cache, reuse that instead of fetching the page again.
- When a GitHub repository is needed, clone or download it once into a uniquely named OS temporary directory with the `gh` CLI. Search and read the local copy instead of repeatedly fetching GitHub pages or raw files. Pull or re-clone only when a freshness check is required.
