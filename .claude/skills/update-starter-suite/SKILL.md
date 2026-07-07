---
name: update-starter-suite
description: Modify or extend this plugin's starter suite (smoke + forkable example). Use when handler inputs/operations change.
---
1. Starter suite proves wiring; it is NOT a conformance suite. Keep it to smoke + one example.
2. Handler refs only via $DOMAIN{...} parameters from itb-plugin.yaml `endpoints`.
3. Keep #114 metadata in sync (identifier `<id>@<range>`, uri `...|version`).
4. If a dialect step's compilation changes, update dialect/steps.yml in the same PR —
   dialect and runtime share one version.
5. Verify: `npx itb-cli dev smoke .`
