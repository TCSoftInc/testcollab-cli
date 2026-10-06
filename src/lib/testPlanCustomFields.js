import { redactToken } from './redact.js';

export function collectCustomField(value, previous) {
  return [...previous, value];
}

function parseCustomFields(inputs) {
  return inputs.map(input => {
    const separator = typeof input === 'string' ? input.indexOf('=') : -1;
    const reference = separator > 0 ? input.slice(0, separator).trim() : '';
    if (!reference) {
      throw new Error('--custom-field must be in the form "name=value" (repeat the flag for multiple fields)');
    }
    // Split on the first = only; URLs and free text can contain more of them.
    return { reference, value: input.slice(separator + 1) };
  });
}

async function request(apiUrl, apiKey, endpoint, body) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${apiUrl.replace(/\/+$/, '')}${endpoint}${separator}token=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    // The plan update endpoint can report validation failures with HTTP 200.
    if (!response.ok || data?.status === false) {
      const message = data?.message || data?.title || data?.error || raw || response.statusText;
      throw new Error(`${endpoint.split('?')[0]}: ${message || `HTTP ${response.status}`}`);
    }
    if (data === null) throw new Error(`Invalid JSON response from ${endpoint.split('?')[0]}`);
    return data;
  } catch (error) {
    throw new Error(redactToken(error?.message || String(error), apiKey));
  }
}

function findField(definitions, reference) {
  const exact = definitions.filter(field => field.name === reference || String(field.id) === reference);
  const matches = exact.length ? exact : definitions.filter(field => field.label === reference);
  if (!matches.length) throw new Error(`Test-plan custom field "${reference}" was not found in this project`);
  if (matches.length !== 1) throw new Error(`Custom field "${reference}" is ambiguous; use its system name or ID`);
  return matches[0];
}

function optionValue(field, input) {
  const options = field.extra?.options || [];
  const exact = options.filter(option => String(option.systemValue) === String(input));
  const matches = exact.length ? exact : options.filter(option => option.label === String(input));
  if (matches.length !== 1) {
    throw new Error(`Invalid or ambiguous option for custom field "${field.label || field.name}"; use an option label or system value`);
  }
  return matches[0];
}

function convertValue(field, raw, projectUsers) {
  const label = field.label || field.name;
  const trimmed = raw.trim();
  const multiple = field.type === 'multipleSelect' || (field.type === 'dropdown' && field.extra?.act_as_config);
  let value = raw;
  let valueLabel = raw;
  let color;
  if (!trimmed && !field.is_required) return { value: multiple ? [] : null, valueLabel: '' };

  switch (field.type) {
    case 'dropdown':
    case 'multipleSelect': {
      let inputs = [trimmed];
      if (multiple && trimmed.startsWith('[')) {
        try { inputs = JSON.parse(trimmed); } catch { throw new Error(`Custom field "${label}" needs a valid JSON array of options`); }
        if (!Array.isArray(inputs) || inputs.some(input => !['string', 'number'].includes(typeof input))) {
          throw new Error(`Custom field "${label}" needs a JSON array of option labels or system values`);
        }
      }
      const options = [...new Map(inputs.map(input => {
        const option = optionValue(field, input);
        return [String(option.systemValue), option];
      })).values()];
      value = multiple ? options.map(option => option.systemValue) : options[0].systemValue;
      valueLabel = multiple ? options.map(option => option.label).join(',') : options[0].label;
      if (!multiple) color = options[0].color;
      break;
    }
    case 'number':
      if (!trimmed || !Number.isFinite(Number(trimmed))) throw new Error(`Custom field "${label}" needs a number`);
      value = Number(trimmed);
      valueLabel = trimmed;
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || !Number.isFinite(Date.parse(`${trimmed}T00:00:00Z`)) || new Date(`${trimmed}T00:00:00Z`).toISOString().slice(0, 10) !== trimmed) {
        throw new Error(`Custom field "${label}" needs a valid date in YYYY-MM-DD format`);
      }
      value = valueLabel = trimmed;
      break;
    case 'url':
      try {
        const url = new URL(trimmed);
        if (!['http:', 'https:', 'ftp:'].includes(url.protocol)) throw new Error();
      } catch { throw new Error(`Custom field "${label}" needs an http://, https:// or ftp:// URL`); }
      value = valueLabel = trimmed;
      break;
    case 'user': {
      const member = projectUsers.find(item => String(item.user?.id || item.user) === trimmed);
      if (!member) throw new Error(`Custom field "${label}" needs a user ID belonging to this project`);
      value = Number(trimmed);
      valueLabel = member.user?.name || [member.user?.first_name, member.user?.last_name].filter(Boolean).join(' ') || trimmed;
      break;
    }
    case 'text':
    case 'textarea':
    case 'editor':
      break;
    default:
      throw new Error(`Unsupported type "${field.type}" for custom field "${label}"`);
  }
  if (field.is_required && (value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length))) {
    throw new Error(`Required custom field "${label}" cannot be empty`);
  }
  return { value, valueLabel, ...(color === undefined ? {} : { color }) };
}

/** Resolve and validate plan fields before any report writes. No flag means no extra requests. */
export async function prepareTestPlanCustomFields({ apiUrl, apiKey, projectId, testPlanId, inputs = [] }) {
  if (!inputs.length) return null;
  const entries = parseCustomFields(inputs);
  const [project, existingPlan] = await Promise.all([
    request(apiUrl, apiKey, `/projects/${projectId}`),
    testPlanId ? request(apiUrl, apiKey, `/testplans/${testPlanId}`) : null
  ]);
  if (String(project?.id) !== String(projectId)) throw new Error('Project not found');
  const companyId = project.company?.id || project.company;
  if (!companyId) throw new Error('The project company was not returned by the API');
  if (testPlanId) {
    if (String(existingPlan?.id) !== String(testPlanId)) throw new Error('Test plan not found');
    const planProject = existingPlan.project?.id || existingPlan.project;
    if (String(planProject) !== String(projectId)) throw new Error('Test plan does not belong to project');
    if (!existingPlan.title) throw new Error('Test plan title was not returned by the API');
    if (existingPlan.custom_fields != null && !Array.isArray(existingPlan.custom_fields)) {
      throw new Error('Invalid existing test-plan custom fields returned by the API');
    }
  }
  // Custom-field definitions are company scoped, with a separate project filter.
  const allDefinitions = await request(apiUrl, apiKey, `/customfields?company=${encodeURIComponent(companyId)}&projects=${projectId}&entity=TestPlan&_limit=-1`);
  if (!Array.isArray(allDefinitions)) throw new Error('Invalid custom field definitions returned by the API');
  const definitions = allDefinitions.filter(field => field.entity === 'TestPlan');
  const resolved = entries.map(entry => ({ ...entry, field: findField(definitions, entry.reference) }));
  const ids = resolved.map(entry => entry.field.id);
  if (new Set(ids).size !== ids.length) throw new Error('The same custom field was supplied more than once');
  const needsUsers = resolved.some(entry => entry.field.type === 'user' && entry.value.trim());
  const projectUsers = needsUsers ? await request(apiUrl, apiKey, `/projectusers?project=${projectId}&_limit=-1`) : [];
  if (!Array.isArray(projectUsers)) throw new Error('Invalid project users returned by the API');
  const supplied = resolved.map(({ field, value }) => ({
    id: field.id, name: field.name, label: field.label, ...convertValue(field, value, projectUsers)
  }));
  // PUT replaces the array, so preserve every field the caller did not supply.
  const customFields = (existingPlan?.custom_fields || []).filter(field =>
    !supplied.some(update => String(update.id) === String(field.id) || update.name === field.name)
  ).concat(supplied);
  const missing = definitions.filter(field => field.is_required && !customFields.some(value => value.name === field.name));
  if (missing.length) throw new Error(`Missing required test-plan custom fields: ${missing.map(field => field.label || field.name).join(', ')}`);
  return { customFields, existingPlan };
}

export async function updateTestPlanCustomFields({ apiUrl, apiKey, projectId, prepared }) {
  const { customFields, existingPlan } = prepared;
  const result = await request(apiUrl, apiKey, `/testplans/${existingPlan.id}`, {
    project: projectId,
    title: existingPlan.title,
    custom_fields: customFields
  });
  if (!result?.id) throw new Error('Failed to update test-plan custom fields');
}
