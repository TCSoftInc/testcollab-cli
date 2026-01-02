import path from 'path';

const DISCOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    families: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['backend', 'ui', 'cli', 'job', 'lib'] },
          paths: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string' },
          output_root: { type: 'string' },
        },
        required: ['name', 'paths'],
      },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          family: { type: 'string' },
          type: { type: 'string' },
          entry: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string' },
          output_path: { type: 'string' },
        },
        required: ['id', 'family', 'entry'],
      },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['families', 'targets'],
};

export function buildDiscoveryPrompt(summaries, snippetLines) {
  const header = [
    'You are specgen. Infer target families and targets from the supplied source files.',
    '',
    'Definitions:',
    '- Target family: domain bucket with name, kind (backend/ui/cli/job/lib), and paths (globs/dirs).',
    '- Target: concrete unit with id, family, type (api_controller/service/ui_component/page/job/cli_command/module), and entry file(s).',
    '',
    'Rules:',
    '- Use directory names for stable ids; prefer one target per route/controller/component/job/cli.',
    '- Skip vendor/build/test/config files.',
    '- Return JSON matching the schema.',
    '',
    'Files:',
  ];
  const body = summaries.map((s, idx) => {
    const trimmed = (s.snippet || '').split('\n').slice(0, snippetLines).join('\n');
    return `#${idx + 1} ${s.rel}\n---\n${trimmed}\n---`;
  });
  return [...header, ...body].join('\n');
}

export async function aiDiscoverTargets({ provider, anthropic, gemini, model, summaries, outRoot, snippetLines }) {
  const prompt = buildDiscoveryPrompt(summaries, snippetLines);
  if (provider === 'anthropic') {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 4000,
      temperature: 0.1,
      response_format: { type: 'json_schema', json_schema: { name: 'DiscoverySpec', schema: DISCOVERY_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
    });
    const text = resp?.content?.[0]?.text;
    if (!text) return null;
    return normalizeDiscovery(JSON.parse(text), outRoot);
  }

  if (provider === 'gemini') {
    const modelHandle = gemini.getGenerativeModel({
      model,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: DISCOVERY_SCHEMA,
      },
    });
    const result = await modelHandle.generateContent([{ text: prompt }]);
    const text = result?.response?.text();
    if (!text) return null;
    return normalizeDiscovery(JSON.parse(text), outRoot);
  }

  throw new Error(`Unsupported provider for discovery: ${provider}`);
}

function normalizeDiscovery(parsed, outRoot) {
  const normalizedFamilies = (parsed.families || []).map((f) => ({
    ...f,
    output_root: f.output_root || path.join(outRoot, f.name),
  }));
  const targets = (parsed.targets || []).map((t) => ({
    ...t,
    output_path:
      t.output_path ||
      path.join(
        normalizedFamilies.find((f) => f.name === t.family)?.output_root || outRoot,
        `${t.id}.feature`,
      ),
  }));
  if (parsed.notes?.length) {
    console.log(`ℹ️  AI discovery notes: ${parsed.notes.join(' | ')}`);
  }
  return { families: normalizedFamilies, targets };
}
