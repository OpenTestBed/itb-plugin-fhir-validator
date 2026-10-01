// `itb-suite registry validate <pluginDir>` — schema-check a plugin repo
// before it enters the registry. Validates:
//   - itb-plugin.yaml   (apiVersion, name, version, runtime, provides, …)
//   - compose fragment  (fragment rules: no host ports, no container_name,
//                        healthcheck required on every service)
//   - dialect/          (component.yml + steps.yml; versioned language block:
//                        version/base/baseVersion against the core spec)
//   - starterSuite path
//
// CANONICAL COPY — itb-plugins/scripts/registry-validate.mjs. Plugin repos
// vendor it verbatim (scripts/registry-validate.mjs) so their CI needs no PAT
// for the private itb-cli repo. Change it here, then re-copy to every vendored
// copy; `node scripts/registry-validate.mjs --check-copies <dir>...` reports
// any that have drifted.
//
// NOTE: an earlier comment claimed itb-cli/src/registry-validate.mjs was
// canonical. That file does not exist.
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

// Evaluate the same semver-lite subset (mirrors satisfiesRange in the
// workbench's languageCatalog.ts — keep the two in sync).
function parseVer(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
export function satisfies(version, range) {
  const v = parseVer(version);
  if (!v || !validRange(range)) return false;
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(part);
    const op = m[1] || '=';
    const b = parseVer(m[2]);
    const c = cmpVer(v, b);
    let ok;
    switch (op) {
      case '>=': ok = c >= 0; break;
      case '<=': ok = c <= 0; break;
      case '>': ok = c > 0; break;
      case '<': ok = c < 0; break;
      case '^': ok = c >= 0 && v[0] === b[0]; break;
      case '~': ok = c >= 0 && v[0] === b[0] && v[1] === b[1]; break;
      default: ok = c === 0;
    }
    if (!ok) return false;
  }
  return true;
}

// ── dialect steps: both language generations ─────────────────────────
// Generation 1 is `steps:` with a hand-written `match:` regex. Generation 2 is
// `verbs:` with a typed `text:` sentence. A file may carry both while it is
// being migrated, and a dialect that only serves generation-1 features ships
// its verbs in the separate file named by component.yml `language.legacy`.

/** Placeholder types the core language compiles. An unknown one THROWS at
 *  catalog-merge time, which breaks every feature in the project — not just
 *  the ones using this dialect — so it has to be caught here. */
const PARAM_TYPES = new Set([
  'actor', 'var', 'ref', 'value', 'string', 'path', 'url', 'canonical',
  'int', 'word', 'kind', 'type',
]);
const KIND_RE = /^[a-z][a-z0-9-]*$/;

export function validateSteps(steps, SF, err, warn) {
  const gen1 = Array.isArray(steps?.steps) ? steps.steps : (Array.isArray(steps) ? steps : []);
  const gen2 = Array.isArray(steps?.verbs) ? steps.verbs : [];

  if (gen1.length === 0 && gen2.length === 0) {
    err(SF, 'no steps found — expected a `verbs:` list (generation 2) or a `steps:` list (generation 1)');
    return;
  }

  gen1.forEach((s, i) => {
    if (!s?.match) { err(SF, `steps[${i}]: match missing`); return; }
    try { new RegExp(s.match); } catch (e) { err(SF, `steps[${i}]: match is not a valid regex: ${e.message}`); }
    if (!Array.isArray(s.actions) || s.actions.length === 0) err(SF, `steps[${i}] (${s.match}): actions missing`);
  });

  gen2.forEach((v, i) => {
    if (typeof v?.text !== 'string' || !v.text.trim()) {
      err(SF, `verbs[${i}]: text missing — a verb without a string \`text:\` is silently skipped by the compiler`);
      return;
    }
    // Unterminated brace, then unknown placeholder name. Both throw in the
    // compiler rather than producing a diagnostic.
    const braces = (v.text.match(/\{/g) || []).length - (v.text.match(/\}/g) || []).length;
    if (braces !== 0) err(SF, `verbs[${i}] (${v.text}): unbalanced { } in text`);
    for (const m of v.text.matchAll(/\{([A-Za-z]+)(?::([^}]+))?\}/g)) {
      if (!PARAM_TYPES.has(m[1])) {
        err(SF, `verbs[${i}] (${v.text}): unknown placeholder {${m[1]}} — this throws at catalog load and breaks EVERY feature in the project, not only ones using this dialect`);
      }
      if (m[1] === 'actor' && m[2] && !KIND_RE.test(m[2])) {
        err(SF, `verbs[${i}] (${v.text}): actor kind "${m[2]}" must match ${KIND_RE}`);
      }
    }
    if (!Array.isArray(v.actions) || v.actions.length === 0) {
      warn(SF, `verbs[${i}] (${v.text}): no actions — the step matches and emits nothing`);
    }
    if (v.requires !== undefined) {
      warn(SF, `verbs[${i}] (${v.text}): \`requires:\` warns on every compile because the CLI never populates the service list — drop it`);
    }
  });

  // `kinds:` must be a LIST. Written as a mapping it is valid YAML, so it gets
  // past the parse and used to throw "object is not iterable" out of this very
  // loop — the validator crashing instead of reporting is the worst outcome of
  // all, since it reports nothing else either.
  if (steps?.kinds !== undefined && !Array.isArray(steps.kinds)) {
    err(SF, `kinds: must be a list, not a ${typeof steps.kinds === 'object' ? 'mapping' : typeof steps.kinds} — write "kinds: [${Object.keys(steps.kinds ?? {}).join(', ')}]"`);
  } else {
    // An actor kind that is not lower-kebab can never be written in a feature,
    // because the core's `is a/an {kind}` sentence will not match it.
    for (const k of steps?.kinds ?? []) {
      if (!KIND_RE.test(String(k))) err(SF, `kinds: "${k}" must match ${KIND_RE} — no one can declare an actor of this kind`);
    }
  }
  for (const key of ['verbs', 'steps']) {
    if (steps?.[key] !== undefined && !Array.isArray(steps[key])) {
      err(SF, `${key}: must be a list of entries, not a ${typeof steps[key] === 'object' ? 'mapping' : typeof steps[key]} — as a mapping it is ignored and none of its steps exist`);
    }
  }

  // A dialect may not add these; the merge silently ignores them.
  for (const key of ['refs', 'pathEvaluators']) {
    if (steps?.[key]) warn(SF, `${key}: is not merged from a dialect — only the core language may define it`);
  }
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

  // A dialect-only plugin deploys nothing: it contributes vocabulary and the
  // service it talks to belongs to some other plugin. `runtime: {}` with
  // `provides: []` is the deliberate way to say so, so the runtime and
  // capability checks below do not apply to it.
  const services = m.runtime?.services ?? {};
  const dialectOnly = !!m.dialect
    && !m.runtime?.compose
    && Object.keys(services).length === 0;

  // runtime + compose fragment
  if (dialectOnly) {
    if (Array.isArray(m.provides) && m.provides.length > 0) {
      err(MF, 'declares no runtime but lists provides — a capability needs a service to serve it');
    }
  } else if (!m.runtime?.compose) {
    err(MF, Object.keys(services).length > 0
      ? 'runtime.compose missing — this plugin declares services but ships no compose fragment, so it cannot be deployed. That is the normal state for a spec-first plugin whose image does not exist yet; such a plugin is not ready for the registry. If it is meant to contribute vocabulary only, drop runtime.services and provides.'
      : 'runtime.compose missing (path to the compose fragment)');
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
  if (!dialectOnly && Object.keys(services).length === 0) err(MF, 'runtime.services must declare at least one service');
  for (const [name, svc] of Object.entries(services)) {
    if (!svc?.image) err(MF, `runtime.services.${name}: image missing`);
    if (svc?.port == null) err(MF, `runtime.services.${name}: port missing`);
    if (!svc?.healthcheck) warn(MF, `runtime.services.${name}: healthcheck missing`);
  }

  // provides / requires
  if (!Array.isArray(m.provides) || m.provides.length === 0) {
    if (!dialectOnly) warn(MF, 'provides is empty — plugin registers no capabilities');
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

  // ── app → dialect-spec drift (component.yml implementsDialect) ─────
  // Three independent version axes — don't confuse them:
  //   component.yml version            = the app/component build
  //   component.yml language.version   = the dialect spec itself
  //   component.yml language.baseVersion = dialect → core-spec compatibility
  // implementsDialect (root-level, optional) closes the missing direction:
  // the range of dialect specs this app build satisfies. The dialect spec is
  // authoritative — a mismatch means THE APP is out of date, so the
  // diagnostic points at the app. Absent field = no check, no noise.
  const compFileForDrift = m.dialect
    ? path.join(typeof m.dialect.path === 'string' ? m.dialect.path.replace(/steps\.yml$/, '') : 'dialect/', 'component.yml')
    : null;
  if (compFileForDrift && exists(compFileForDrift)) {
    let comp;
    try { comp = yaml.load(read(compFileForDrift)); } catch { comp = null; }
    const range = comp?.implementsDialect;
    const specVer = typeof comp?.language === 'object' ? comp?.language?.version : undefined;
    if (range != null) {
      if (typeof range !== 'string' || !validRange(range)) {
        warn(compFileForDrift, `implementsDialect is not a valid range (${JSON.stringify(range)}) — drift check skipped`);
      } else if (specVer && SEMVER_RE.test(String(specVer)) && !satisfies(String(specVer), range)) {
        err(compFileForDrift, `app (version ${JSON.stringify(comp?.version)}) declares implementsDialect ${JSON.stringify(range)} but ships dialect spec ${specVer} — the app is out of date; update the app (and its implementsDialect), not the dialect`);
      }
    }
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
        // sync-dialects names the synced folder after itb-plugin.yaml `name`,
        // while the compiler keys kinds, types, `@dialect:` tags and
        // enablement off component.yml `id`. If they differ, the dialect
        // loads but none of those work, and nothing else reports it.
        if (comp.id && m.name && String(comp.id) !== String(m.name)) {
          err(CF, `id "${comp.id}" must equal itb-plugin.yaml name "${m.name}" — the sync uses the name for the folder and the compiler uses the id for kinds, types and @dialect: tags`);
        }
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
            validateSteps(steps, SF, err, warn);
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
    // A dialect-only plugin deploys no service, so it can provide no
    // capability: `provides: []` is the deliberate statement of that, exactly
    // as it is in itb-plugin.yaml. Requiring a non-empty list here would make
    // every vocabulary-only plugin unlistable.
    const dialectOnly = p?.kind === 'dialect' || (p?.dialect === true && Array.isArray(p?.provides) && p.provides.length === 0);
    if (!Array.isArray(p?.provides)) {
      err(IX, `${name}: provides must be a list`);
    } else if (p.provides.length === 0 && !dialectOnly) {
      err(IX, `${name}: provides is empty — say kind: dialect if this plugin is vocabulary only`);
    }
    if (dialectOnly && p?.dialect !== true) {
      err(IX, `${name}: kind: dialect but dialect: ${JSON.stringify(p?.dialect)} — a dialect-only plugin that ships no dialect is nothing`);
    }
    for (const cap of p?.provides ?? []) {
      const cf = path.join('capabilities', `${cap}.yaml`);
      if (!exists(cf)) warn(IX, `${name}: capability "${cap}" has no spec file ${cf}`);
    }
    // requires: the capabilities this plugin needs someone else to provide.
    // Unlike provides, a missing spec here is an ERROR: nothing can resolve a
    // requirement at deploy time against a capability that is not defined.
    if (p?.requires !== undefined) {
      if (!Array.isArray(p.requires)) {
        err(IX, `${name}: requires must be a list of capability names`);
      } else {
        for (const cap of p.requires) {
          if (typeof cap !== 'string') {
            err(IX, `${name}: requires entries are capability names, not ${JSON.stringify(cap)} — the uri and version live in the plugin's own itb-plugin.yaml`);
            continue;
          }
          if (!exists(path.join('capabilities', `${cap}.yaml`))) {
            err(IX, `${name}: requires capability "${cap}", which has no spec in capabilities/`);
          }
        }
      }
    }
  }
  // every capability file must parse
  const capDir = path.join(dir, 'capabilities');
  const capFiles = fs.existsSync(capDir)
    ? fs.readdirSync(capDir).filter(f => /\.ya?ml$/.test(f))
    : [];
  for (const f of capFiles) {
    try { yaml.load(read(path.join('capabilities', f))); } catch (e) { err(`capabilities/${f}`, `YAML parse error: ${e.message}`); }
  }
  const defined = new Set(capFiles.map(f => f.replace(/\.ya?ml$/, '')));

  // ── drift between the registry and what is actually on disk ────────
  // Only runs when the plugin repos are checked out beside this one, which is
  // true locally and false in the registry's own CI. Skipped, never failed,
  // when they are absent — a CI run must not depend on a sibling checkout.
  const parent = path.resolve(dir, '..');
  const siblings = fs.existsSync(parent)
    ? fs.readdirSync(parent, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('itb-plugin-'))
        .map(e => ({ name: e.name, dir: path.join(parent, e.name) }))
        .filter(s => fs.existsSync(path.join(s.dir, 'itb-plugin.yaml')))
    : [];

  const used = new Set();
  for (const p of Object.values(plugins)) {
    for (const c of p?.provides ?? []) used.add(c);
    for (const c of p?.requires ?? []) if (typeof c === 'string') used.add(c);
  }

  if (siblings.length === 0) {
    console.log('note  no plugin repos beside this one — on-disk cross-checks skipped');
  } else {
    for (const s of siblings) {
      let sm;
      try { sm = yaml.load(fs.readFileSync(path.join(s.dir, 'itb-plugin.yaml'), 'utf8')); } catch { continue; }
      const key = String(sm?.name ?? '');
      if (!key) continue;
      if (!plugins[key]) {
        err(IX, `plugin "${key}" exists at ${s.name}/ but is not listed — add it, or say why it is unpublished`);
      } else if (sm.version && plugins[key].latest && String(sm.version) !== String(plugins[key].latest)) {
        warn(IX, `${key}: index says latest ${plugins[key].latest}, the repo is at ${sm.version}`);
      }
      // A required capability nobody defines cannot be resolved at deploy time.
      const repoRequires = new Set();
      for (const r of sm?.requires ?? []) {
        if (r?.capability) {
          repoRequires.add(r.capability);
          used.add(r.capability);
          if (!defined.has(r.capability)) {
            err(IX, `${key} requires capability "${r.capability}", which has no spec in capabilities/`);
          }
        }
      }
      // The index's requires list is a summary of the repo's, so a difference
      // means one of the two is stale. The repo is authoritative — it is what
      // a deploy actually reads — so the diagnostic points at the index.
      const indexRequires = new Set((plugins[key]?.requires ?? []).filter(c => typeof c === 'string'));
      for (const c of repoRequires) {
        if (!indexRequires.has(c)) warn(IX, `${key}: the repo requires "${c}" but the index does not list it`);
      }
      for (const c of indexRequires) {
        if (!repoRequires.has(c)) err(IX, `${key}: the index says it requires "${c}", but ${s.name}/itb-plugin.yaml does not`);
      }
      for (const p of sm?.provides ?? []) if (p?.capability) used.add(p.capability);
    }
  }

  for (const c of defined) {
    if (!used.has(c)) warn(IX, `capability "${c}" is defined but no plugin provides or requires it`);
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

/** Report vendored copies of this file that have drifted from this one. */
export function checkCopies(dirs) {
  const selfPath = fileURLToPath(import.meta.url);
  const self = fs.readFileSync(selfPath, 'utf8');
  let ok = true;
  let found = 0;
  for (const d of dirs) {
    const copy = path.join(d, 'scripts', 'registry-validate.mjs');
    if (!fs.existsSync(copy)) continue;
    found++;
    if (path.resolve(copy) === path.resolve(selfPath)) continue;
    if (fs.readFileSync(copy, 'utf8') === self) {
      console.log(`ok    ${copy}`);
    } else {
      console.log(`ERROR ${copy}: differs from the canonical copy — re-copy it`);
      ok = false;
    }
  }
  if (found === 0) console.log('note  no vendored copies found in the given directories');
  return ok;
}

// Standalone entrypoint:
//   node scripts/registry-validate.mjs <dir> [<dir> …]
//   node scripts/registry-validate.mjs --check-copies <dir> [<dir> …]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirs = args.filter(a => !a.startsWith('--'));
  let ok = true;
  if (args.includes('--check-copies')) {
    ok = checkCopies(dirs.length ? dirs : ['.']);
  } else {
    for (const d of dirs.length ? dirs : ['.']) ok = validateAny(d) && ok;
  }
  process.exit(ok ? 0 : 1);
}
