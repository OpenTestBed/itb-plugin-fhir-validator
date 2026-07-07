# itb-plugin-fhir-validator

ITB plugin wrapping the HL7 validator_cli (server mode) — the canonical example plugin.
Upstream engine: HL7/org.hl7.fhir.core (untouched); handler contract:
documentation/itb-rest-spec.md there.

Bundle: itb-plugin.yaml + compose.plugin.yml + suite/ (starter) + dialect/ (Gherkin ext).
Install: `itb plugins add fhir-validator`.
