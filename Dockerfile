# syntax=docker/dockerfile:1.7
# Baked equivalent of compose.plugin.yml's jar-download mode: same jar, same
# server invocation, but resolved at build time so first boot is JVM warmup
# only (no apt, no 200MB download) and the running version is pinned by digest.
#
# Alpine rather than the Ubuntu-based tag the fragment uses: it drops ~120MB
# for no loss — validator_cli is pure Java, and a full validate with terminology
# lookup was verified working on musl. That leaves the 201MB fat jar as ~54% of
# the image, so further slimming of the base (jlink, distroless) buys little.
FROM eclipse-temurin:17-jre-alpine

# Default mirrors VALIDATOR_URL in itb-plugin.yaml; CI passes the resolved one.
ARG VALIDATOR_URL=https://github.com/costateixeira/org.hl7.fhir.core/releases/download/wip/validator_cli.jar
# The "wip" release is republished in place under a stable URL, so the URL
# alone is not a cache key. CI sets this to the asset's Last-Modified to force
# a refetch when the jar changes; without it BuildKit serves a stale jar.
ARG VALIDATOR_STAMP=unset

LABEL org.opencontainers.image.source=https://github.com/OpenTestBed/itb-plugin-fhir-validator \
      org.opencontainers.image.description="HL7 validator_cli in GITB REST server mode" \
      org.opencontainers.image.licenses=BSD-3-Clause \
      org.opentestbed.validator.url="${VALIDATOR_URL}"
# ^ records which jar this image actually contains, so `docker inspect`
# answers "fork build or official release?" without reading the tag and hoping.

WORKDIR /app

# ADD fetches on the build host rather than inside the container, so the
# multi-arch build needs no emulated RUN step at all. Keep it that way: any
# RUN here costs a QEMU round trip on the arm64 leg.
ADD ${VALIDATOR_URL} /app/validator_cli.jar

# MEOW + transitive deps push past 4G. Overridable per deployment.
ENV JAVA_TOOL_OPTIONS=-Xmx8g

# fhir-settings.json stays a mount, not a layer — it points at a deployment's
# own package server, which must not be baked into a published image.

EXPOSE 8080

# Probes the endpoint itb-plugin.yaml declares. busybox wget is in the base,
# so this needs no extra package and no shell tricks.
HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=90s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/itb/fhir/getModuleDefinition || exit 1

# Args in CMD, not ENTRYPOINT, so a deployment can override the FHIR version or
# drop -allowNetworkAccess without rebuilding.
ENTRYPOINT ["java", "-jar", "/app/validator_cli.jar"]
CMD ["server", "8080", "-version", "4.0", "-allowNetworkAccess"]
