// `itb-suite registry validate <pluginDir>` — schema-check a plugin repo
// before it enters the registry. Validates:
//   - itb-plugin.yaml   (apiVersion, name, version, runtime, provides, …)
//   - compose fragment  (fragment rules: no host ports, no container_name,
//                        healthcheck required on every service)
//   - dialect/          (component.yml + steps.yml; versioned language block:
//                        version/base/baseVersion against the core spec)
//   - starterSuite path
//
// CANONICAL COPY — plugin repos vendor this file (scripts/registry-validate.mjs)
// so their CI needs no PAT for the private itb-cli repo; keep changes here and
// re-copy (candidate for a sync-dialects-style sync).
//
// Usage: node bin/itb-suite.mjs registry validate <dir>
//        node src/registry-validate.mjs <dir>          (standalone/vendored)
// Exit code 0 = valid, 1 = errors (each printed as "ERROR <file>: <msg>").
// Warnings ("WARN …") don't fail the run.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const yaml = loadYaml();

function loadYaml() {
  // Standard node resolution from this file's location first (works both in
  // itb-cli and as a vendored copy in a plugin repo after `npm i js-yaml`),
  // then itb-cli's vendor/ fallback (same trick as sync-dialects).
  try { return createRequire(import.meta.url)('js-yaml'); } catch { /* next */ }
  for (const base of [path.resolve(here, '..'), path.resolve(here, '../vendor')]) {
    try { return createRequire(path.join(base, 'package.json'))('js-yaml'); } catch { /* next */ }
  }
  throw new Error('js-yaml not found — npm install js-yaml (CI) or npm install in itb-cli');
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^v?\d+(\.\d+){0,2}([-+].*)?$/;
// semver-lite range: space-separated AND comparators (>=, <=, >, <, =, ^, ~ or bare)
const RANGE_PART_RE = /^(>=|<=|>|<|=|\^|~)?\s*v?\d+(\.\d+){0,2}$/;

export function validRange(range) {
  if (typeof range !== 'string' || !range.trim()) return false;
  return range.trim().split(/\s+/).every(p => RANGE_PART_RE.test(p));
}

export function validatePluginDir(dir) {
  const errors = [];
  const warnings = [];
  const err = (file, msg) => errors.push(`${file}: ${msg}`);
  const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const exists = f => fs.existsSync(path.join(dir, f));

  // ── itb-plugin.yaml ────────────────────────────────────────────────
  const MF = 'itb-plugin.yaml';
  if (!exists(MF)) { err(MF, 'missing — every plugin repo must have an itb-plugin.yaml at its root'); return report(dir, errors, warnings); }
  let m;
  try { m = yaml.load(read(MF)); } catch (e) { err(MF, `YAML parse error: ${e.message}`); return report(dir, errors, warnings); }
  if (!m || typeof m !== 'object') { err(MF, 'empty or not a mapping'); return report(dir, errors, warnings); }

  if (m.apiVersion !== 'itb-plugins/v1') err(MF, `apiVersion must be "itb-plugins/v1" (got ${JSON.stringify(m.apiVersion)})`);
  if (!m.name || !NAME_RE.test(String(m.name))) err(MF, `name must match ${NAME_RE} (got ${JSON.stringify(m.name)})`);
  if (!m.version || !SEMVER_RE.test(String(m.version))) err(MF, `version must be semver (got ${JSON.stringify(m.version)})`);
  if (!m.description) warn(MF, 'description missing');
  if (!m.license) warn(MF, 'license missing');

  // runtime + compose fragment
  const services = m.runtime?.services ?? {};
  if (!m.runtime?.compose) {
    err(MF, 'runtime.compose missing (path to the compose fragment)');
  } else if (!exists(m.runtime.compose)) {
    err(MF, `runtime.compose points to ${m.runtime.compose}, which does not exist`);
  } else {
    let compose;
    try { compose = yaml.load(read(m.runtime.compose)); } catch (e) { err(m.runtime.compose, `YAML parse error: ${e.message}`); }
    if (compose) {
      const csvcs = compose.services ?? {};
      if (Object.keys(csvcs).length === 0) err(m.runtime.compose, 'no services defined');
      for (const [name, svc] of Object.entries(csvcs)) {
        if (svc?.container_name) err(m.runtime.compose, `service ${name}: container_name is forbidden in fragments`);
        if (svc?.ports?.length) err(m.runtime.compose, `service ${name}: host port mappings are forbidden in fragments (use \`itb plugins expose\`)`);
        if (!svc?.healthcheck) err(m.runtime.compose, `service ${name}: healthcheck is required in fragments`);
        if (!svc?.image && !svc?.build) warn(m.runtime.compose, `service ${name}: no image or build`);
      }
      for (const name of Object.keys(services)) {
        if (!csvcs[name]) err(MF, `runtime.services.${name} not present in ${m.runtime.compose}`);
      }
    }
  }
  if (Object.keys(services).length === 0) err(MF, 'runtime.services must declare at least one service');
  for (const [name, svc] of Object.entries(services)) {
    if (!svc?.image) err(MF, `runtime.services.${name}: image missing`);
    if (svc?.port == null) err(MF, `runtime.services.${name}: port missing`);
    if (!svc?.healthcheck) warn(MF, `runtime.services.${name}: healthcheck missing`);
  }

  // provides / requires
  if (!Array.isArray(m.provides) || m.provides.length === 0) {
    warn(MF, 'provides is empty — plugin registers no capabilities');
  } else {
    m.provides.forEach((p, i) => {
      for (const k of ['capability', 'uri', 'version', 'service', 'entrypoint']) {
        if (!p?.[k]) err(MF, `provides[${i}]: ${k} missing`);
      }
      if (p?.service && !services[p.service]) err(MF, `provides[${i}]: service "${p.service}" not in runtime.services`);
    });
  }
  if (m.requires !== undefined && !Array.isArray(m.requires)) err(MF, 'requires must be a list');

  // starter suite
  if (m.starterSuite?.path && !exists(m.starterSuite.path)) {
    err(MF, `starterSuite.path ${m.starterSuite.path} does not exist`);
  }

  // ── dialect (language extension) ───────────────────────────────────
  if (m.dialect) {
    const dpath = typeof m.dialect.path === 'string' ? m.dialect.path.replace(/steps\.yml$/, '') : 'dialect/';
    const dfile = f => path.join(dpath, f);
    if (!exists(dfile('component.yml'))) {
      err(MF, `dialect declared but ${dfile('component.yml')} missing`);
    } else {
      const CF = dfile('component.yml');
      let comp;
      try { comp = yaml.load(read(CF)); } catch (e) { err(CF, `YAML parse error: ${e.message}`); }
      if (comp) {
        for (const k of ['id', 'name', 'version']) if (!comp[k]) err(CF, `${k} missing`);
        const lang = comp.language;
        let stepsFile = 'steps.yml';
        if (lang == null) {
          warn(CF, 'no language block — dialect ships no step patterns');
        } else if (typeof lang === 'string') {
          stepsFile = lang;
          warn(CF, 'legacy string-form language — declare the versioned block (steps/version/base/baseVersion)');
        } else {
          stepsFile = lang.steps || 'steps.yml';
          if (!lang.version || !SEMVER_RE.test(String(lang.version))) err(CF, `language.version must be semver (got ${JSON.stringify(lang.version)})`);
          if (!lang.base) err(CF, 'language.base missing — extensions must declare which base language they extend (e.g. itb-core-en)');
          if (!lang.baseVersion) err(CF, 'language.baseVersion missing — declare the compatible core specVersion range (e.g. ">=1 <2")');
          else if (!validRange(lang.baseVersion)) err(CF, `language.baseVersion is not a valid range: ${JSON.stringify(lang.baseVersion)}`);
        }
        if (lang != null) {
          const SF = dfile(stepsFile);
          if (!exists(SF)) {
            err(CF, `language steps file ${SF} missing`);
          } else {
            let steps;
            try { steps = yaml.load(read(SF)); } catch (e) { err(SF, `YAML parse error: ${e.message}`); }
            const list = steps?.steps ?? (Array.isArray(steps) ? steps : null);
            if (!Array.isArray(list) || list.length === 0) {
              err(SF, 'no steps found (expected top-level `steps:` list)');
            } else {
              list.forEach((s, i) => {
                if (!s?.match) { err(SF, `steps[${i}]: match missing`); return; }
                try { new RegExp(s.match); } catch (e) { err(SF, `steps[${i}]: match is not a valid regex: ${e.message}`); }
                if (!Array.isArray(s.actions) || s.actions.length === 0) err(SF, `steps[${i}] (${s.match}): actions missing`);
              });
            }
          }
        }
        for (const sc of comp.scriptlets ?? []) {
          if (!exists(dfile(path.join('scriptlets', sc)))) err(CF, `scriptlets: ${sc} listed but ${dfile('scriptlets/' + sc)} missing`);
        }
      }
    }
  }

  return report(dir, errors, warnings);
}

function report(dir, errors, warnings) {
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  const name = path.resolve(dir);
  if (errors.length) {
    console.log(`\n${name}: INVALID — ${errors.length} error(s), ${warnings.length} warning(s)`);
  } else {
    console.log(`\n${name}: OK — 0 errors, ${warnings.length} warning(s)`);
  }
  return errors.length === 0;
}

// ── Registry index (itb-plugins repo) ────────────────────────────────
// Validates index.yaml + capabilities/*.yaml.
export function validateIndexDir(dir) {
  const errors = [];
  const warnings = [];
  const err = (file, msg) => errors.push(`${file}: ${msg}`);
  const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const exists = f => fs.existsSync(path.join(dir, f));

  const IX = 'index.yaml';
  if (!exists(IX)) { err(IX, 'missing'); return report(dir, errors, warnings); }
  let ix;
  try { ix = yaml.load(read(IX)); } catch (e) { err(IX, `YAML parse error: ${e.message}`); return report(dir, errors, warnings); }
  if (ix?.apiVersion !== 'itb-plugins/v1') err(IX, `apiVersion must be "itb-plugins/v1" (got ${JSON.stringify(ix?.apiVersion)})`);
  const plugins = ix?.plugins ?? {};
  if (Object.keys(plugins).length === 0) err(IX, 'plugins mapping is empty');
  for (const [name, p] of Object.entries(plugins)) {
    if (!NAME_RE.test(name)) err(IX, `plugin key "${name}" must match ${NAME_RE}`);
    if (!p?.repo || !/^https:\/\//.test(String(p.repo))) err(IX, `${name}: repo must be an https URL`);
    if (!p?.latest || !SEMVER_RE.test(String(p.latest))) err(IX, `${name}: latest must be semver (got ${JSON.stringify(p?.latest)})`);
    if (!Array.isArray(p?.provides) || p.provides.length === 0) err(IX, `${name}: provides must be a non-empty list`);
    for (const cap of p?.provides ?? []) {
      const cf = path.join('capabilities', `${cap}.yaml`);
      if (!exists(cf)) warn(IX, `${name}: capability "${cap}" has no spec file ${cf}`);
    }
  }
  // every capability file must parse
  if (fs.existsSync(path.join(dir, 'capabilities'))) {
    for (const f of fs.readdirSync(path.join(dir, 'capabilities')).filter(f => /\.ya?ml$/.test(f))) {
      try { yaml.load(read(path.join('capabilities', f))); } catch (e) { err(`capabilities/${f}`, `YAML parse error: ${e.message}`); }
    }
  }
  return report(dir, errors, warnings);
}

/** Auto-detect what `dir` is (plugin repo vs registry index) and validate it. */
export function validateAny(dir) {
  if (fs.existsSync(path.join(dir, 'itb-plugin.yaml'))) return validatePluginDir(dir);
  if (fs.existsSync(path.join(dir, 'index.yaml'))) return validateIndexDir(dir);
  console.log(`ERROR ${dir}: neither itb-plugin.yaml (plugin repo) nor index.yaml (registry) found`);
  return false;
}

// Standalone entrypoint: node src/registry-validate.mjs <dir> [<dir> …]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2).filter(a => !a.startsWith('--'));
  let ok = true;
  for (const d of dirs.length ? dirs : ['.']) ok = validateAny(d) && ok;
  process.exit(ok ? 0 : 1);
}
