Starter suite (ships with the plugin — NOT a conformance suite).

- smoke.xml         getModuleDefinition answers; known-good Patient → SUCCESS; known-bad → FAILURE
- example.xml       forkable template: loadIG → generate test data → validate → FHIRPath assert
- data/             good.json, bad.json

All handler references use $DOMAIN{fhirValidator} etc. — never hostnames.
Suite <metadata> carries #114 scopes/dependencies per itb-plugins/docs/dependency-conventions.md.
Deployed automatically by `itb plugins add` into the plugin-smoke specification.
