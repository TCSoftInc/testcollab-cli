import fs from 'fs';
import path from 'path';
import readline from 'readline';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { aiDiscoverTargets } from '../ai/discovery.js';

const DEFAULT_MODEL = 'claude-opus-4-5-20251101';
const IGNORED_DIRS = new Set(['node_modules', '.git', '.testcollab', 'dist', 'build', 'coverage', '.next', '.turbo']);
const MAX_FILES_FOR_AI_DISCOVERY = 40;
const SNIPPET_LINES = 80;

export async function specgen(options) {
  const cwd = process.cwd();
  const srcRoot = path.resolve(cwd, options.src || './src');
  const outRoot = path.resolve(cwd, options.out || './features');
  const cachePath = path.resolve(cwd, options.cache || '.testcollab/specgen.json');
  const model = options.model || DEFAULT_MODEL;
  const skipConfirm = options.yes === true;
  const dryRun = options.dryRun === true;

  console.log(`🔍 Discovering targets in ${srcRoot}`);
  const srcExists = fs.existsSync(srcRoot);
  if (!srcExists) {
    console.error(`❌ Source directory not found: ${srcRoot}`);
    process.exit(1);
  }

  const provider = detectProvider(model);
  const { anthropic, gemini } = initProviders(provider);

  const cacheInfo = await loadCache(cachePath);
  let discovery;

  if (!cacheInfo.exists) {
    console.log('🧭 No cache found; running AI-assisted discovery for families and targets...');
    discovery = await aiDiscoverTargets({
      provider,
      anthropic,
      gemini,
      model,
      summaries: await collectFileSummaries(srcRoot, MAX_FILES_FOR_AI_DISCOVERY),
      outRoot,
      snippetLines: SNIPPET_LINES,
    });
    if (!discovery) {
      console.warn('⚠️  AI discovery unavailable; aborting.');
      process.exit(1);
    }
  } else {
    const fresh = await discoverTargets(srcRoot, outRoot);
    discovery = mergeCache(cacheInfo.data, fresh);
  }

  discovery = ensureOutputPaths(discovery, outRoot);

  printDiscovery(discovery);

  if (!skipConfirm) {
    const ok = await confirm(`Proceed with ${dryRun ? 'dry run (no files written)' : 'generation'}? [y/N] `);
    if (!ok) {
      console.log('🚫 Aborted.');
      return;
    }
  }

  await ensureDir(path.dirname(cachePath));
  const merged = discovery;

  if (dryRun) {
    console.log('✅ Dry run complete (cache not updated, no features written).');
    return;
  }

  for (const target of merged.targets) {
    try {
      const aiResult = await generateFeatureWithModel({
        provider,
        anthropic,
        gemini,
        model,
        target,
      });
      const featureText = aiResult?.feature || fallbackFeature(target);
      await writeFeature(target.output_path, featureText);
      if (aiResult?.notes?.length) {
        console.log(`ℹ️  Notes for ${target.id}: ${aiResult.notes.join(' | ')}`);
      }
      console.log(`✨ Wrote ${target.output_path}`);
    } catch (err) {
      console.error(`❌ Failed to generate for ${target.id}: ${err.message}`);
    }
  }

  await saveCache(cachePath, merged);
  console.log(`💾 Cached discovery at ${cachePath}`);
  console.log('✅ specgen finished');
}

async function discoverTargets(srcRoot, outRoot) {
  const files = await walkFiles(srcRoot);
  const families = new Map();
  const targets = [];

  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    if (!rel || rel.startsWith('..')) continue;
    const segments = rel.split(path.sep);
    const familyName = segments.length > 1 ? segments[0] : 'root';
    const familyKind = inferFamilyKind(familyName);
    const targetId = rel.replace(/\.[^.]+$/, '').replace(/[\\/]/g, '-');
    const type = inferTargetType(rel);
    const output_path = path.join(outRoot, familyName, `${targetId}.feature`);
    const snippet = await readSnippet(file);

    if (!families.has(familyName)) {
      families.set(familyName, {
        name: familyName,
        kind: familyKind,
        paths: [path.join(srcRoot, familyName)],
        priority: 'core',
        output_root: path.join(outRoot, familyName),
      });
    }

    targets.push({
      id: targetId,
      family: familyName,
      type,
      entry: [path.join(srcRoot, rel)],
      context: [],
      routes: [],
      priority: 'core',
      confidence_flags: [],
      output_path,
      snippet,
      relative: rel,
    });
  }

  return {
    families: Array.from(families.values()),
    targets,
  };
}

async function collectFileSummaries(srcRoot, limit = MAX_FILES_FOR_AI_DISCOVERY) {
  const files = await walkFiles(srcRoot);
  const limited = files.slice(0, limit);
  const summaries = [];
  for (const file of limited) {
    const rel = path.relative(srcRoot, file);
    const snippet = await readSnippet(file, SNIPPET_LINES);
    summaries.push({ rel, abs: file, snippet });
  }
  return summaries;
}

async function walkFiles(dir) {
  const out = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(full);
      out.push(...nested);
    } else if (entry.isFile() && isCodeFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isCodeFile(name) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name);
}

function inferFamilyKind(familyName) {
  if (familyName.includes('api')) return 'backend';
  if (familyName.includes('component') || familyName.includes('page')) return 'ui';
  return 'backend';
}

function inferTargetType(relPath) {
  const lower = relPath.toLowerCase();
  if (lower.includes('controller')) return 'api_controller';
  if (lower.includes('service')) return 'service';
  if (lower.includes('route') || lower.includes('router')) return 'api_controller';
  if (lower.includes('component') || lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'ui_component';
  if (lower.includes('job') || lower.includes('cron')) return 'job';
  if (lower.includes('cli')) return 'cli_command';
  return 'module';
}

async function readSnippet(file, lines = 120) {
  try {
    const contents = await fs.promises.readFile(file, 'utf8');
    return contents.split('\n').slice(0, lines).join('\n');
  } catch (err) {
    return '';
  }
}

const FEATURE_SCHEMA = {
  name: 'FeatureSpec',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      feature: {
        type: 'string',
        description: 'A single Gherkin feature file with 2-4 scenarios.',
      },
      notes: {
        type: 'array',
        description: 'Optional warnings or low-confidence callouts.',
        items: { type: 'string' },
      },
    },
    required: ['feature'],
  },
};

function buildPrompt(target) {
  return [
    'You are specgen. Produce a concise Gherkin feature for the given target.',
    '',
    `Target ID: ${target.id}`,
    `Family: ${target.family}`,
    `Type: ${target.type}`,
    `Relative path: ${target.relative}`,
    '',
    'Code (trimmed):',
    '---',
    target.snippet || '[no content]',
    '---',
    '',
    'Instructions:',
    '- Return JSON matching the provided schema.',
    '- feature: valid Gherkin with one Feature and 2-4 Scenarios.',
    '- Include at least one happy path and, if visible, one edge/error path.',
    '- Use domain-neutral, clear steps; mark uncertain titles with "(draft)".',
    '- notes: add warnings or gaps when context is thin.',
  ].join('\n');
}

async function callAnthropic(client, model, target) {
  const prompt = buildPrompt(target);
  const resp = await client.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0.2,
    response_format: { type: 'json_schema', json_schema: FEATURE_SCHEMA },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  });
  const text = resp?.content?.[0]?.text;
  if (!text) {
    throw new Error('Empty response from model');
  }
  return JSON.parse(text);
}

async function callGemini(geminiClient, model, target) {
  const prompt = buildPrompt(target);
  const modelHandle = geminiClient.getGenerativeModel({
    model,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: FEATURE_SCHEMA.schema,
    },
  });
  const result = await modelHandle.generateContent([{ text: prompt }]);
  const text = result?.response?.text();
  if (!text) {
    throw new Error('Empty response from model');
  }
  return JSON.parse(text);
}

async function generateFeatureWithModel({ provider, anthropic, gemini, model, target }) {
  if (provider === 'anthropic') {
    return callAnthropic(anthropic, model, target);
  }
  if (provider === 'gemini') {
    return callGemini(gemini, model, target);
  }
  throw new Error(`Unsupported provider for feature generation: ${provider}`);
}

function fallbackFeature(target) {
  return [
    `Feature: ${target.id} (draft)`,
    '',
    `  Scenario: Basic flow for ${target.id}`,
    '    Given the system initializes the module',
    `    When the ${target.id} behavior executes`,
    '    Then the expected outcome is observed',
  ].join('\n');
}

async function writeFeature(outPath, body) {
  await ensureDir(path.dirname(outPath));
  await fs.promises.writeFile(outPath, body, 'utf8');
}

function printDiscovery(discovery) {
  console.log(`📂 Families: ${discovery.families.length}`);
  for (const fam of discovery.families) {
    const count = discovery.targets.filter((t) => t.family === fam.name).length;
    console.log(`  - ${fam.name} (${count} targets) -> ${fam.output_root}`);
  }
  console.log(`🎯 Targets: ${discovery.targets.length}`);
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function loadCache(cachePath) {
  try {
    const data = await fs.promises.readFile(cachePath, 'utf8');
    return { exists: true, data: JSON.parse(data) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exists: false, data: { families: [], targets: [] } };
    }
    throw err;
  }
}

function mergeCache(cache, discovery) {
  // Keep latest discovery; carry over existing when ids match
  const familyMap = new Map((cache?.families || []).map((f) => [f.name, f]));
  for (const fam of discovery.families || []) {
    familyMap.set(fam.name, { ...familyMap.get(fam.name), ...fam });
  }

  const targetMap = new Map((cache?.targets || []).map((t) => [t.id, t]));
  for (const t of discovery.targets || []) {
    const prev = targetMap.get(t.id) || {};
    targetMap.set(t.id, { ...prev, ...t });
  }

  return {
    families: Array.from(familyMap.values()),
    targets: Array.from(targetMap.values()),
    updated_at: new Date().toISOString(),
  };
}

async function saveCache(cachePath, data) {
  await ensureDir(path.dirname(cachePath));
  await fs.promises.writeFile(cachePath, JSON.stringify(data, null, 2), 'utf8');
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

function ensureOutputPaths(discovery, outRoot) {
  const famMap = new Map();
  for (const fam of discovery.families || []) {
    famMap.set(fam.name, {
      ...fam,
      output_root: fam.output_root || path.join(outRoot, fam.name),
    });
  }

  const targets = (discovery.targets || []).map((t) => {
    const outputRoot = famMap.get(t.family)?.output_root || outRoot;
    const baseName = t.output_path
      ? path.basename(t.output_path, path.extname(t.output_path))
      : t.id || 'target';
    const finalPath =
      t.output_path ||
      path.join(outputRoot, `${baseName}.feature`);
    return {
      ...t,
      output_path: finalPath,
    };
  });

  return {
    families: Array.from(famMap.values()),
    targets,
  };
}

function detectProvider(model) {
  const lower = (model || '').toLowerCase();
  if (lower.includes('gemini')) return 'gemini';
  return 'anthropic';
}

function initProviders(provider) {
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.error('❌ Error: ANTHROPIC_API_KEY is required for specgen when using Claude models.');
      process.exit(1);
    }
    return { anthropic: new Anthropic({ apiKey: key }), gemini: null };
  }

  if (provider === 'gemini') {
    const key = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) {
      console.error('❌ Error: GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY) is required for specgen when using Gemini models.');
      process.exit(1);
    }
    return { anthropic: null, gemini: new GoogleGenerativeAI(key) };
  }

  console.error(`❌ Unsupported model/provider for specgen: ${provider}`);
  process.exit(1);
}
