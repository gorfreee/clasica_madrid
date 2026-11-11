import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

const repoRoot = path.join(import.meta.dirname, '..');
const SECRET = 'GEMINI_API_KEY=supersecretvalue';

type Val = string | boolean | number | null;
type Outcome = 'success' | 'failure' | 'skipped' | 'cancelled';

type Step = {
  name: string;
  id?: string;
  if?: string;
  continueOnError: boolean;
  uses?: string;
  env: Record<string, string>;
  script: string;
  with: Record<string, string | string[]>;
  lines: string[];
};

type Scenario = {
  name: string;
  force?: Record<string, Outcome>;
  configMode?: string;
  report?: Record<string, string>;
  manifest?: 'absent' | Record<string, unknown>;
  prepare: (stateDir: string, outside: string) => void;
  expectReason: string;
  expectSaveStep: boolean;
  expectConclusion: 'success' | 'failure' | 'cancelled';
  /** success() es false en el paso de save y, aun así, el paso corre. */
  expectSaveDespiteFailure?: boolean;
  saveFails?: boolean;
  forbidSecret?: boolean;
};

const routeState = {
  day: '2026-11-11',
  requests: 49,
  nextAt: 0,
  cooldownUntil: 0,
  dailyUntil: 0,
  tokenScale: 1,
  recent: [] as Array<{ id: string; at: number; tokens: number }>,
};

export function assertPersistentAiPoolCache(workflowPath: string): void {
  const yaml = readFileSync(workflowPath, 'utf8');
  const label = path.basename(workflowPath);
  assertStructure(yaml, label);
  assertSelectedPaths(yaml, label);
  for (const scenario of scenarios()) {
    const result = runScenario(yaml, scenario);
    const where = `${label} / ${scenario.name}`;
    expect(result.reason, where).toBe(scenario.expectReason);
    expect(result.saveStepRan, where).toBe(scenario.expectSaveStep);
    expect(result.conclusion, where).toBe(scenario.expectConclusion);
    expect(result.snapshot, where).toBe(result.snapshotBefore);
    if (scenario.expectSaveDespiteFailure) {
      expect(result.successAtSave, where).toBe(false);
      expect(result.saveStepRan, where).toBe(true);
    }
    if (scenario.saveFails) {
      const save = result.steps.find((step) => step.name === 'Save persistent AI pool state');
      const ingest = result.steps.find((step) => step.id === 'ingest');
      expect(save?.outcome, where).toBe('failure');
      expect(save?.continueOnError, where).toBe(false);
      expect(ingest?.continueOnError, where).toBe(false);
    }
    if (scenario.forbidSecret) {
      expect(result.output, where).not.toContain('supersecretvalue');
      expect(result.stdout, where).not.toContain('supersecretvalue');
    }
  }
}

export function assertAiPoolCacheCoherence(leftPath: string, rightPath: string): void {
  const left = parseSteps(readFileSync(leftPath, 'utf8'));
  const right = parseSteps(readFileSync(rightPath, 'utf8'));
  for (const name of [
    'Restore persistent AI pool state',
    'Decide whether to save persistent AI pool state',
    'Save persistent AI pool state',
  ]) {
    const a = requiredStep(left, name);
    const b = requiredStep(right, name);
    expect(a.script, name).toBe(b.script);
    expect(a.if ?? '', name).toBe(b.if ?? '');
    expect(a.uses ?? '', name).toBe(b.uses ?? '');
    expect(a.env, name).toEqual(b.env);
    expect(a.with, name).toEqual(b.with);
    expect(a.continueOnError, name).toBe(b.continueOnError);
  }
}

function scenarios(): Scenario[] {
  const completed = { status: 'completed', lastStage: 'completed' };
  return [
    {
      name: 'éxito con cuota v2',
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'success',
    },
    {
      name: 'éxito con cuota v1 sin reescribirla',
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 1),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'success',
    },
    {
      name: 'éxito sin ficheros persistibles',
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => mkdirSync(dir, { recursive: true }),
      expectReason: 'empty',
      expectSaveStep: false,
      expectConclusion: 'success',
    },
    {
      name: 'batch fatal con estado válido',
      force: { ingest: 'failure' },
      report: { report_available: 'true', health: 'fatal' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'failure',
      expectSaveDespiteFailure: true,
    },
    {
      name: 'error de validación del diff con estado válido',
      force: { changes: 'failure' },
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'failure',
      expectSaveDespiteFailure: true,
    },
    {
      name: 'error de publicación con estado válido',
      force: { publish: 'failure' },
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'failure',
      expectSaveDespiteFailure: true,
    },
    {
      name: 'fallo antes de inicializar porque Install no llegó a la ingesta',
      force: { Install: 'failure' },
      prepare: (dir) => writePool(dir, 2),
      manifest: 'absent',
      expectReason: 'not-initialized',
      expectSaveStep: false,
      expectConclusion: 'failure',
    },
    {
      name: 'fallo en initialization con cuota restaurada',
      force: { ingest: 'failure' },
      manifest: { status: 'failed', lastStage: 'initialization' },
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'not-initialized',
      expectSaveStep: false,
      expectConclusion: 'failure',
    },
    {
      name: 'fallo de la ingesta sin run.json',
      force: { ingest: 'failure' },
      manifest: 'absent',
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'not-initialized',
      expectSaveStep: false,
      expectConclusion: 'failure',
    },
    {
      name: 'cancelación tras la clasificación',
      force: { ingest: 'cancelled' },
      manifest: { status: 'interrupted', lastStage: 'classification' },
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'cancelled',
      expectSaveDespiteFailure: true,
    },
    {
      name: 'estado corrupto tras un batch completado',
      force: { ingest: 'failure' },
      manifest: completed,
      prepare: (dir) => {
        writePool(dir, 2);
        writeFileSync(path.join(dir, 'quota.json'), '{not json\n');
      },
      expectReason: 'corrupt',
      expectSaveStep: false,
      expectConclusion: 'failure',
    },
    {
      name: 'run.lock presente',
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => {
        writePool(dir, 2);
        writeFileSync(path.join(dir, 'run.lock'), 'locked-on-purpose\n');
      },
      expectReason: 'lock-present',
      expectSaveStep: false,
      expectConclusion: 'success',
    },
    {
      name: 'symlink hacia una credencial',
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir, outside) => {
        writePool(dir, 2);
        const secret = path.join(outside, 'secret.env');
        writeFileSync(secret, `${SECRET}\n`);
        symlinkSync(secret, path.join(dir, 'cache', 'linked.json'));
      },
      expectReason: 'untrusted',
      expectSaveStep: false,
      expectConclusion: 'success',
      forbidSecret: true,
    },
    ...(['success', 'failure', 'cancelled'] as const).flatMap((outcome): Scenario[] =>
      ['pending/linked.json', 'pending/nested/linked.json', 'pending/linked-directory'].map((entry) => ({
        name: `cache normal y symlink en ${entry}, ingesta ${outcome}`,
        force: { ingest: outcome },
        manifest: completed,
        prepare: (dir, outside) => {
          writePool(dir, 2);
          const secret = path.join(outside, 'secret.env');
          writeFileSync(secret, `${SECRET}\n`);
          mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
          symlinkSync(entry.endsWith('directory') ? outside : secret, path.join(dir, entry));
        },
        expectReason: 'untrusted',
        expectSaveStep: false,
        expectConclusion: outcome,
        forbidSecret: true,
      })),
    ),
    {
      name: 'el fallo del guardado no oculta el del catálogo',
      force: { ingest: 'failure' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'failure',
      expectSaveDespiteFailure: true,
      saveFails: true,
    },
    {
      name: 'un guardado fallido tras el éxito deja el job en rojo',
      configMode: 'publish',
      report: { report_available: 'true', health: 'clean' },
      manifest: completed,
      prepare: (dir) => writePool(dir, 2),
      expectReason: 'valid',
      expectSaveStep: true,
      expectConclusion: 'failure',
      saveFails: true,
    },
  ];
}

function writePool(dir: string, version: 1 | 2): void {
  mkdirSync(path.join(dir, 'cache'), { recursive: true });
  mkdirSync(path.join(dir, 'pending'), { recursive: true });
  const quota = version === 2
    ? { version: 2, routes: { 'gemini:gemini-3.1-flash-lite': routeState } }
    : { version: 1, models: { 'gemini-2.5-flash': { ...routeState, requests: 3 } } };
  writeFileSync(path.join(dir, 'quota.json'), `${JSON.stringify(quota)}\n`);
  writeFileSync(path.join(dir, 'cache', 'abc.json'), '{"version":2,"key":"abc"}\n');
  writeFileSync(path.join(dir, 'pending', 'p.json'), '{"version":2,"key":"p"}\n');
}

function runScenario(yaml: string, scenario: Scenario) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'ai-pool-cache-'));
  const stateDir = path.join(workspace, '.local', 'ai');
  const outside = path.join(workspace, 'outside');
  const manifestPath = path.join(workspace, 'run.json');
  const outputPath = path.join(workspace, 'github-output.txt');
  mkdirSync(outside, { recursive: true });
  scenario.prepare(stateDir, outside);
  if (scenario.manifest && scenario.manifest !== 'absent') {
    writeFileSync(manifestPath, JSON.stringify(scenario.manifest));
  }
  const snapshotBefore = snapshot(stateDir);
  try {
    const steps = parseSteps(yaml);
    const recorded: Array<{
      name: string;
      id?: string;
      outcome: Outcome;
      ran: boolean;
      continueOnError: boolean;
    }> = [];
    const stepState: Record<string, { outcome: Outcome; outputs: Record<string, string> }> = {};
    let reason = '';
    let stdout = '';
    let output = '';
    let successAtSave = true;

    for (const step of steps) {
      const prior = recorded.map((item) => item.outcome);
      const ctx = expressionContext(prior, stepState);
      const shouldRun = truthy(evaluate(step.if ?? 'success()', ctx));
      if (!shouldRun) {
        recorded.push({ name: step.name, id: step.id, outcome: 'skipped', ran: false, continueOnError: step.continueOnError });
        if (step.id) stepState[step.id] = { outcome: 'skipped', outputs: {} };
        continue;
      }

      let outcome: Outcome = scenario.force?.[step.id ?? ''] ?? scenario.force?.[step.name] ?? 'success';
      const outputs: Record<string, string> = {};
      if (step.id === 'ai_pool_restore') outputs['cache-hit'] = 'false';
      if (step.id === 'config' && scenario.configMode) outputs.mode = scenario.configMode;
      if (step.id === 'report' && scenario.report) Object.assign(outputs, scenario.report);

      if (step.id === 'ai_pool_save') {
        if (step.env.RUN_OUTCOME === undefined) throw new Error('el gate no define RUN_OUTCOME');
        const runOutcome = interpolate(step.env.RUN_OUTCOME, ctx);
        const gate = runGate(step.script, {
          RUN_OUTCOME: runOutcome,
          RUN_MANIFEST: manifestPath,
          AI_STATE_DIR: stateDir,
          GITHUB_OUTPUT: outputPath,
        });
        outputs.save = gate.save;
        outputs.reason = gate.reason;
        reason = gate.reason;
        stdout = gate.stdout;
        output = gate.output;
        outcome = 'success';
      }

      if (step.name === 'Save persistent AI pool state') {
        successAtSave = ctx.fn.success();
        if (scenario.saveFails) outcome = 'failure';
      }

      recorded.push({ name: step.name, id: step.id, outcome, ran: true, continueOnError: step.continueOnError });
      if (step.id) stepState[step.id] = { outcome, outputs };
    }

    const save = recorded.find((step) => step.name === 'Save persistent AI pool state');
    return {
      reason,
      stdout,
      output,
      successAtSave,
      saveStepRan: Boolean(save?.ran),
      conclusion: conclude(recorded),
      steps: recorded,
      snapshotBefore,
      snapshot: snapshot(stateDir),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function conclude(steps: Array<{ ran: boolean; outcome: Outcome; continueOnError: boolean }>): Scenario['expectConclusion'] {
  if (steps.some((step) => step.ran && step.outcome === 'cancelled')) return 'cancelled';
  if (steps.some((step) => step.ran && step.outcome === 'failure' && !step.continueOnError)) return 'failure';
  return 'success';
}

function runGate(script: string, env: Record<string, string>): { save: string; reason: string; stdout: string; output: string } {
  const file = path.join(os.tmpdir(), `ai-pool-gate-${randomUUID()}.sh`);
  writeFileSync(file, script, { mode: 0o700 });
  try {
    const stdout = execFileSync('bash', [file], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = readFileSync(env.GITHUB_OUTPUT, 'utf8');
    return {
      save: output.match(/^save=(.*)$/m)?.[1] ?? '',
      reason: output.match(/^reason=(.*)$/m)?.[1] ?? '',
      stdout,
      output,
    };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    throw new Error(`el gate salió ${failed.status ?? 'sin código'}\n${failed.stderr ?? ''}\n${failed.stdout ?? ''}`);
  } finally {
    rmSync(file, { force: true });
  }
}

function assertStructure(yaml: string, label: string): void {
  const steps = parseSteps(yaml);
  const restore = requiredStep(steps, 'Restore persistent AI pool state');
  const gate = requiredStep(steps, 'Decide whether to save persistent AI pool state');
  const save = requiredStep(steps, 'Save persistent AI pool state');
  const ingest = steps.find((step) => step.id === 'ingest');
  expect(ingest, label).toBeTruthy();
  expect(restore.uses, label).toBe('actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25 # v5');
  expect(save.uses, label).toBe('actions/cache/save@caa296126883cff596d87d8935842f9db880ef25 # v5');
  expect(restore.with.key, label).toBe('ingestion-ai-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}');
  expect(save.with.key, label).toBe(restore.with.key);
  expect(restore.with['restore-keys'], label).toEqual([
    'ingestion-ai-${{ runner.os }}-',
    'ingestion-gemini-${{ runner.os }}-',
  ]);
  expect(save.with['restore-keys'], label).toBeUndefined();
  expect(save.with.path, label).toEqual(restore.with.path);
  expect(save.if, label).toBe("always() && steps.ai_pool_save.outputs.save == 'true'");
  expect(gate.if, label).toBe('always()');
  expect(gate.env.RUN_OUTCOME, label).toBe('${{ steps.ingest.outcome }}');
  expect(gate.env.RUN_MANIFEST, label).toBe('${{ env.OBS_DIR }}/run.json');
  expect(save.continueOnError, label).toBe(false);
  expect(gate.continueOnError, label).toBe(false);
  expect(ingest?.continueOnError, label).toBe(false);
  expect(yaml, label).not.toMatch(/uses:\s*actions\/cache@/);
  expect(yaml, label).toContain('group: ingestion-production');
  expect(yaml, label).toContain('cancel-in-progress: false');
  expect(yaml, label).toMatch(/permissions:\n {2}actions: read\n {2}contents: read\n/);
  expect(yaml, label).not.toMatch(/actions:\s*write/);
  expect(yaml, label).not.toMatch(/contents:\s*write/);

  const names = steps.map((step) => step.name);
  const at = (name: string) => names.indexOf(name);
  expect(at('Restore persistent AI pool state'), label).toBeLessThan(at(ingest!.name));
  expect(at('Install'), label).toBeLessThan(at(ingest!.name));
  expect(at(ingest!.name), label).toBeLessThan(at('Enforce publication diff boundary'));
  expect(at('Enforce publication diff boundary'), label).toBeLessThan(at('Publish data pull request'));
  expect(at('Publish data pull request'), label).toBeLessThan(at(gate.name));
  expect(at(gate.name), label).toBeLessThan(at(save.name));
  expect(at(save.name), label).toBe(names.length - 1);
}

function assertSelectedPaths(yaml: string, label: string): void {
  expect(globToRegExp('.local/ai/cache/**').test('.local/ai/cache/abc.json')).toBe(true);
  expect(globToRegExp('.local/ai/cache/**').test('.local/ai/cache/nested/abc.json')).toBe(true);
  expect(globToRegExp('.local/ai/**/run.lock').test('.local/ai/run.lock')).toBe(true);
  expect(globToRegExp('.local/ai/**/run.lock').test('.local/ai/cache/run.lock')).toBe(true);
  expect(globToRegExp('.local/ai/*.tmp').test('.local/ai/quota.json.uuid.tmp')).toBe(true);
  expect(globToRegExp('.local/ai/**/*.tmp').test('.local/ai/cache/abc.json.uuid.tmp')).toBe(true);
  expect(globToRegExp('.local/ai/quota.json').test('.local/ai/.env')).toBe(false);

  const workspace = mkdtempSync(path.join(os.tmpdir(), 'ai-pool-paths-'));
  const root = path.join(workspace, '.local', 'ai');
  mkdirSync(path.join(root, 'cache', 'nested'), { recursive: true });
  mkdirSync(path.join(root, 'pending'), { recursive: true });
  writeFileSync(path.join(root, 'quota.json'), '{"version":2,"routes":{}}\n');
  writeFileSync(path.join(root, 'cache', 'abc.json'), '{}\n');
  writeFileSync(path.join(root, 'cache', 'nested', 'def.json'), '{}\n');
  writeFileSync(path.join(root, 'pending', 'p.json'), '{}\n');
  writeFileSync(path.join(root, 'run.lock'), 'lock\n');
  writeFileSync(path.join(root, 'cache', 'run.lock'), 'lock\n');
  writeFileSync(path.join(root, 'quota.json.uuid.tmp'), 'partial\n');
  writeFileSync(path.join(root, 'cache', 'abc.json.uuid.tmp'), 'partial\n');
  writeFileSync(path.join(root, '.env'), `${SECRET}\n`);
  writeFileSync(path.join(root, 'credentials.json'), `${SECRET}\n`);

  try {
    const patterns = requiredStep(parseSteps(yaml), 'Save persistent AI pool state').with.path;
    expect(Array.isArray(patterns), label).toBe(true);
    const selected = selectPaths(workspace, patterns as string[]);
    expect(selected, label).toEqual([
      '.local/ai/cache/abc.json',
      '.local/ai/cache/nested/def.json',
      '.local/ai/pending/p.json',
      '.local/ai/quota.json',
    ]);
    for (const file of selected) {
      expect(readFileSync(path.join(workspace, file), 'utf8'), label).not.toContain('supersecretvalue');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function selectPaths(root: string, patterns: string[]): string[] {
  const files = listFiles(root).map((file) => path.relative(root, file).split(path.sep).join('/'));
  const selected = new Set<string>();
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const regex = globToRegExp(negate ? raw.slice(1) : raw);
    for (const file of files) {
      if (!regex.test(file)) continue;
      if (negate) selected.delete(file);
      else selected.add(file);
    }
  }
  return [...selected].sort();
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (pattern.startsWith('**', index)) {
      source += '.*';
      index += 2;
      continue;
    }
    const char = pattern[index]!;
    if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

function snapshot(dir: string): string {
  if (!exists(dir)) return '<missing>';
  const rows: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) rows.push(`link ${rel} -> ${readlinkSync(full)}`);
      else if (entry.isDirectory()) walk(full);
      else rows.push(`file ${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return rows.join('\n');
}

function exists(file: string): boolean {
  try {
    readdirSync(file);
    return true;
  } catch {
    try {
      readFileSync(file);
      return true;
    } catch {
      return false;
    }
  }
}

function expressionContext(
  prior: Outcome[],
  steps: Record<string, { outcome: Outcome; outputs: Record<string, string> }>,
) {
  const failed = prior.includes('failure');
  const cancelled = prior.includes('cancelled');
  return {
    fn: {
      success: () => !failed && !cancelled,
      failure: () => failed,
      cancelled: () => cancelled,
      always: () => true,
    },
    lookup: (name: string): unknown => {
      if (name === 'steps') return steps;
      throw new Error(`contexto de expresión no soportado: ${name}`);
    },
  };
}

function interpolate(value: string, ctx: ReturnType<typeof expressionContext>): string {
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    const result = evaluate(expression.trim(), ctx);
    return result == null ? '' : String(result);
  });
}

function evaluate(expression: string, ctx: ReturnType<typeof expressionContext>): Val {
  const parser = new Parser(tokenize(expression), ctx);
  const value = parser.parseOr();
  if (parser.peek() !== undefined) throw new Error(`la expresión no se consumió: ${expression}`);
  return value;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (char === ' ' || char === '\n' || char === '\t') {
      index += 1;
      continue;
    }
    if (input.startsWith('!=', index) || input.startsWith('==', index) || input.startsWith('&&', index) || input.startsWith('||', index)) {
      tokens.push(input.slice(index, index + 2));
      index += 2;
      continue;
    }
    if ('!()[].'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < input.length && input[end] !== char) end += 1;
      if (input[end] !== char) throw new Error(`cadena sin cerrar en ${input}`);
      tokens.push(input.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[A-Za-z0-9_-]/.test(input[end]!)) end += 1;
      tokens.push(input.slice(index, end));
      index = end;
      continue;
    }
    throw new Error(`token inesperado «${char}» en ${input}`);
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: string[],
    private readonly ctx: ReturnType<typeof expressionContext>,
  ) {}

  peek(): string | undefined {
    return this.tokens[this.index];
  }

  private eat(expected?: string): string {
    const token = this.tokens[this.index];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`se esperaba ${expected ?? 'un token'} y llegó ${token ?? 'fin'}`);
    }
    this.index += 1;
    return token;
  }

  parseOr(): Val {
    let left = this.parseAnd();
    while (this.peek() === '||') {
      this.eat('||');
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  parseAnd(): Val {
    let left = this.parseCmp();
    while (this.peek() === '&&') {
      this.eat('&&');
      const right = this.parseCmp();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  parseCmp(): Val {
    const left = this.parseUnary();
    const op = this.peek();
    if (op !== '==' && op !== '!=') return left;
    this.eat(op);
    const right = this.parseUnary();
    const equal = left === right;
    return op === '==' ? equal : !equal;
  }

  parseUnary(): Val {
    if (this.peek() === '!') {
      this.eat('!');
      return !truthy(this.parseUnary());
    }
    return this.parsePrimary();
  }

  parsePrimary(): Val {
    const token = this.peek();
    if (token === '(') {
      this.eat('(');
      const value = this.parseOr();
      this.eat(')');
      return value;
    }
    if (token?.startsWith("'") || token?.startsWith('"')) {
      this.eat();
      return token.slice(1, -1);
    }
    if (token === 'true' || token === 'false') {
      this.eat();
      return token === 'true';
    }
    if (token === 'null') {
      this.eat();
      return null;
    }
    if (token !== undefined && /^\d+$/.test(token)) {
      this.eat();
      return Number(token);
    }
    const name = this.eat();
    if (this.peek() === '(') {
      this.eat('(');
      this.eat(')');
      const fn = this.ctx.fn[name as keyof ReturnType<typeof expressionContext>['fn']];
      if (!fn) throw new Error(`función desconocida ${name}`);
      return fn();
    }
    let value: unknown = this.ctx.lookup(name);
    while (this.peek() === '.' || this.peek() === '[') {
      let property: string;
      if (this.peek() === '.') {
        this.eat('.');
        property = this.eat();
      } else {
        this.eat('[');
        property = String(this.parsePrimary());
        this.eat(']');
      }
      value = value == null ? null : (value as Record<string, unknown>)[property];
    }
    return (value ?? null) as Val;
  }
}

function truthy(value: Val): boolean {
  return value !== null && value !== false && value !== '' && value !== 0;
}

function parseSteps(yaml: string): Step[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === '    steps:');
  if (start < 0) throw new Error('el workflow no tiene steps');
  const steps: Step[] = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^      - name: (.+)$/);
    if (match) {
      if (current) steps.push(finishStep(current.name, current.lines));
      current = { name: match[1]!.trim(), lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('  ') && !line.startsWith('      ') && line.trim() !== '') break;
    current.lines.push(line);
  }
  if (current) steps.push(finishStep(current.name, current.lines));
  return steps;
}

function finishStep(name: string, lines: string[]): Step {
  const id = lines.find((line) => line.startsWith('        id:'))?.slice('        id:'.length).trim();
  const ifLine = lines.find((line) => line.startsWith('        if:'));
  const ifValue = ifLine?.slice('        if:'.length).trim();
  if (ifValue === '|' || ifValue === '>' || ifValue === '|-') throw new Error(`if multilínea en ${name}`);
  const uses = lines.find((line) => line.startsWith('        uses:'))?.slice('        uses:'.length).trim();
  return {
    name,
    ...(id ? { id } : {}),
    ...(ifValue ? { if: ifValue } : {}),
    continueOnError: lines.some((line) => line.trim() === 'continue-on-error: true'),
    ...(uses ? { uses } : {}),
    env: parseEnv(lines),
    script: extractScript(lines),
    with: parseWith(lines),
    lines,
  };
}

function requiredStep(steps: Step[], name: string): Step {
  const found = steps.find((step) => step.name === name);
  if (!found) throw new Error(`falta el paso ${name}`);
  return found;
}

function parseEnv(lines: string[]): Record<string, string> {
  const start = lines.findIndex((line) => line === '        env:');
  if (start < 0) return {};
  const env: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('          ')) break;
    const match = line.match(/^          ([A-Z0-9_]+):\s*(.*)$/);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

function parseWith(lines: string[]): Record<string, string | string[]> {
  const start = lines.findIndex((line) => line === '        with:');
  if (start < 0) return {};
  const result: Record<string, string | string[]> = {};
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith('          ')) break;
    const match = line.match(/^          ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1]!;
    const rest = match[2] ?? '';
    if (rest === '|' || rest === '|-' || rest === '>') {
      const block: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index]!.startsWith('            ') || lines[index]!.trim() === '')) {
        if (lines[index]!.trim() !== '') block.push(lines[index]!.slice(12));
        index += 1;
      }
      result[key] = block;
      continue;
    }
    result[key] = rest;
    index += 1;
  }
  return result;
}

function extractScript(lines: string[]): string {
  const start = lines.findIndex((line) => line.startsWith('        run:'));
  if (start < 0 || !lines[start]!.includes('|')) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  while (body.at(-1) === '') body.pop();
  return body.length ? `${body.join('\n')}\n` : '';
}
