/**
 * featuresync.js
 * 
 * Git-based synchronization command for Gherkin feature files with TestCollab.
 * 
 * This command follows the workflow described in gherkin-docs/bdd-integration/README.md:
 * 1. Fetch last synced commit from server
 * 2. Run git diff to find changes
 * 3. Calculate hashes for old and new file versions
 * 4. Resolve IDs for existing items
 * 5. Build and send GherkinSyncDelta payload
 */

import { simpleGit } from 'simple-git';
import * as gherkin from '@cucumber/gherkin';
import * as messages from '@cucumber/messages';
import { createHash } from 'crypto';
import path from 'path';
// fs - file
import fs from 'fs';

// Enable extra debug logs by setting BDD_SYNC_DEBUG=1
const DEBUG_BDD_SYNC = process.env.BDD_SYNC_DEBUG === '1';

// TCV-7031: the TestCollab step view styles a synced data table and doc string
// by these class names.
const DATA_TABLE_CLASS = 'bdd-data-table';
const DOC_STRING_CLASS = 'bdd-doc-string';

/**
 * Main featuresync command handler
 * @param {Object} options - Command options from commander
 */
export async function featuresync(options) {
  try {
    // Resolve API key: --api-key flag takes precedence, then TESTCOLLAB_TOKEN env var
    const token = options.apiKey || process.env.TESTCOLLAB_TOKEN;
    if (!token) {
      console.error('❌ Error: No API key provided');
      console.error('   Pass --api-key <key> or set the TESTCOLLAB_TOKEN environment variable.');
      process.exit(1);
    }

    // Initialize Git
    const git = simpleGit();
    
    // Check if we're in a Git repository
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      console.error('❌ Error: Not in a Git repository');
      console.error('   Please run this command from within a Git repository.');
      process.exit(1);
    }

    // Check for uncommitted changes to .feature files
    await checkUncommittedChanges(git);

    console.log('🔍 Fetching sync state from TestCollab...');
    
    // Step 1: Fetch last synced commit from server
    const lastSyncedCommit = await fetchSyncState(options.project, options.apiUrl, token);
    console.log(`📊 Last synced commit: ${lastSyncedCommit || 'none (initial sync)'}`);

    // Step 2: Get current HEAD commit
    const headCommit = await git.revparse(['HEAD']);
    console.log(`📊 Current HEAD commit: ${headCommit}`);

    if (lastSyncedCommit === headCommit) {
      console.log('✅ Already up to date - no sync needed');
      return;
    }

    // Step 3: Run git diff to find changes
    console.log('🔍 Analyzing changes...');
    let changes;
    
    if (lastSyncedCommit) {
      // Regular sync - compare with last synced commit
      const diffOptions = ['--name-status', '--find-renames', `${lastSyncedCommit}..HEAD`];

      const diffResult = await git.diff(diffOptions);
      console.log(diffResult);
      changes = parseDiffOutput(diffResult);
    } else {
      // Initial sync - get all .feature files in the repository
      const allFiles = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']);
      const featureFiles = allFiles.split('\n')
        .filter(file => file.trim().endsWith('.feature'))
        .map(file => ({
          status: 'A',
          oldPath: null,
          newPath: file.trim()
        }));
      changes = featureFiles;
    }
    
    console.log(`📄 Found ${changes.length} change(s)`);
    if (changes.length > 0) {
      console.log('   Details:');
      changes.forEach((c, i) => {
        const left = c.oldPath ? c.oldPath : '';
        const right = c.newPath ? c.newPath : '';
        const arrow = c.oldPath && c.newPath ? ' -> ' : '';
        console.log(`   ${String(i + 1).padStart(2, ' ')}. ${c.status} ${left}${arrow}${right}`);
      });
    }
    if (changes.length === 0) {
      console.log('✅ No changes to sync');
      return;
    }

    // Step 4: Process each change and calculate hashes
    console.log('🔧 Processing changes and calculating hashes...');
    const processedChanges = [];
    const oldHashes = { features: [], scenarios: [] };

    for (const change of changes) {
      const processed = await processChange(git, change, lastSyncedCommit);
      if (processed) {
        processedChanges.push(processed);
        
        // Collect old hashes for resolve-ids call
        if (processed.oldFeatureHash) {
          oldHashes.features.push(processed.oldFeatureHash);
        }
        if (processed.oldScenarioHashes) {
          oldHashes.scenarios.push(...processed.oldScenarioHashes);
        }
      }
    }

    // Step 5: Resolve IDs for existing items
    console.log('🔍 Resolving existing item IDs...');
    if (DEBUG_BDD_SYNC) {
      console.log(`   ↪️  Requesting ID resolution for:`);
      console.log(`      • feature hashes: ${oldHashes.features.length}`);
      console.log(`      • scenario hashes: ${oldHashes.scenarios.length}`);
    }
    const resolvedIds = await resolveIds(options.project, oldHashes, options.apiUrl, token);
    if (DEBUG_BDD_SYNC) {
      const suiteKeys = Object.keys(resolvedIds.suites || {});
      const caseKeys = Object.keys(resolvedIds.cases || {});
      console.log(`   ✅ Resolved IDs:`);
      console.log(`      • suites mapped: ${suiteKeys.length}`);
      console.log(`      • cases mapped: ${caseKeys.length}`);
      if (suiteKeys.length > 0) {
        const sample = suiteKeys.slice(0, 5).map(k => ({ hash: k, suiteId: resolvedIds.suites[k]?.suiteId }));
        console.log(`      • sample suites:`, sample);
      }
      if (caseKeys.length > 0) {
        const sample = caseKeys.slice(0, 5).map(k => ({ hash: k, caseId: resolvedIds.cases[k]?.caseId }));
        console.log(`      • sample cases:`, sample);
      }
    }

    // Step 6: Build final payload
    console.log('📦 Building sync payload...');
    const payload = buildSyncPayload(
      options.project,
      lastSyncedCommit,
      headCommit,
      processedChanges,
      resolvedIds
    );
    //console.log({payload});
    // log payload in file
    //const payloadFilePath = path.join(process.cwd(), 'sync-payload.json');
    //fs.writeFileSync(payloadFilePath, JSON.stringify(payload, null, 2));
    //console.log(`📂 Payload written to ${payloadFilePath}`);

    // Step 7: Send to TestCollab
    console.log('🚀 Syncing with TestCollab...');
    const result = await syncWithTestCollab(payload, options.apiUrl, token);
    
    // Display results
    displaySyncResults(result);
    console.log('✅ Synchronization completed successfully');
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Fetch the last synced commit SHA from TestCollab
 */
async function fetchSyncState(projectId, apiUrl, token) {
  const url = `${apiUrl}/bdd/sync?project=${projectId}&token=${token}`;
  console.log(`Fetching sync state from: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch sync state: ${response.status} ${response.statusText}! Check if project ID and API URL are correct.`);
    }
    
    const data = await response.json();
    return data.lastSyncedCommit;
  } catch (error) {
    throw new Error(`Failed to connect to TestCollab API: ${error.message}`);
  }
}

/**
 * Parse git diff output into structured changes
 */
function parseDiffOutput(diffOutput) {
  if (!diffOutput.trim()) {
    return [];
  }
  
  const lines = diffOutput.trim().split('\n');
  const changes = [];
  
  for (const line of lines) {
    const match = line.match(/^([AMDRC]\d*)\s+(.+?)(?:\s+(.+))?$/);
    if (match) {
      const [, status, path1, path2] = match;
      
      const change = {
        status,
        oldPath: status.startsWith('D') || status.startsWith('R') ? path1 : null,
        newPath: status.startsWith('A') || status.startsWith('M') || status.startsWith('R') ? (path2 || path1) : null
      };
      
      // Only include .feature files
      if ((change.oldPath && change.oldPath.endsWith('.feature')) ||
          (change.newPath && change.newPath.endsWith('.feature'))) {
        changes.push(change);
      }
    }
  }
  
  return changes;
}

/**
 * Process a single change from git diff
 */
async function processChange(git, change, lastSyncedCommit) {
  const processed = {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath
  };

  try {
    // Get old file content for M, D, R changes (skip for A)
    if (lastSyncedCommit && change.status !== 'A') {
      const oldPathForLookup = change.oldPath || change.newPath;
      if (oldPathForLookup) {
        const oldContent = await git.show([`${lastSyncedCommit}:${oldPathForLookup}`]);
        const oldParsed = parseGherkinFile(oldContent, oldPathForLookup);
      if (oldParsed) {
        processed.oldFeatureHash = oldParsed.featureHash;
        processed.oldScenarioHashes = oldParsed.scenarios.map(s => s.hash);
        processed.oldScenarios = oldParsed.scenarios; // keep titles and hashes for smarter mapping
      }
    }
    }

    // Get new file content for A, M, R changes
    if (change.newPath) {
      const newContent = await git.show([`HEAD:${change.newPath}`]);
      const newParsed = parseGherkinFile(newContent, change.newPath);
      if (newParsed) {
        processed.feature = {
          hash: newParsed.featureHash,
          title: newParsed.feature.name,
          description: newParsed.feature.FeatureDescription,
          background: newParsed.feature.background,
          backgroundText: newParsed.feature.backgroundText
        };
        processed.scenarios = newParsed.scenarios;
      }
    }

    return processed;
  } catch (error) {
    console.warn(`⚠️  Warning: Could not process ${change.oldPath || change.newPath}: ${error.message}`);
    return null;
  }
}

/**
 * Extract feature description text that appears between Feature: and Background/Scenario tags
 */
function extractFeatureDescription(content) {
  const lines = content.split('\n');
  let description = '';
  let inDescription = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('Feature:')) {
      inDescription = true;
      continue;
    }
    
    if (inDescription) {
      if (line.startsWith('Background:') || line.startsWith('Scenario:')) {
        break;
      }
      
      if (line && !line.startsWith('#')) {
        if (description) description += '\n';
        description += line;
      }
    }
  }
  
  return description.trim();
}

/**
 * Extract any textual content inside Background: block (including non-step lines)
 */
function extractBackgroundText(content) {
  const lines = content.split('\n');
  let inBackground = false;
  const backgroundLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('Background:')) {
      inBackground = true;
      continue;
    }
    if (inBackground) {
      if (
        line.startsWith('Scenario:') ||
        line.startsWith('Scenario Outline:') ||
        line.startsWith('Rule:') ||
        line.startsWith('Feature:')
      ) {
        break;
      }
      if (line && !line.startsWith('#')) {
        backgroundLines.push(line);
      }
    }
  }
  return backgroundLines;
}

/**
 * TCV-7031: a step as it is sent to TestCollab — the keyword and step line,
 * followed by the step's data table or doc string. The API sorts steps from
 * expected results line by line, so everything a step carries stays on its
 * one line: rows become HTML table rows and line breaks become <br>.
 *
 * The hashes do not use this. They stay on keyword + step line, so a case
 * synced before tables were sent keeps its hash and is not created again.
 *
 * TCV-6057: `parameters` are a Scenario Outline's Examples columns. Each
 * <name> in the step line, a table cell or the doc string becomes {{name}},
 * the reference TestCollab fills from the linked test dataset. It is replaced
 * before escaping, so the HTML the step is wrapped in is never touched.
 */
function formatStep(step, parameters = []) {
  const withParameters = text => toDatasetReferences(text, parameters);
  return `${step.keyword}${withParameters(step.text)}${formatStepArgument(step, withParameters)}`;
}

function formatStepArgument(step, withParameters) {
  if (step.dataTable) {
    const rows = step.dataTable.rows.map(row =>
      `<tr>${row.cells.map(cell => `<td>${escapeStepHtml(withParameters(cell.value))}</td>`).join('')}</tr>`
    );
    return `<table class="${DATA_TABLE_CLASS}"><tbody>${rows.join('')}</tbody></table>`;
  }
  if (step.docString) {
    return `<pre class="${DOC_STRING_CLASS}">${escapeStepHtml(withParameters(step.docString.content))}</pre>`;
  }
  return '';
}

// TCV-6057: Cucumber puts the Examples value where <name> is; TestCollab puts the dataset value where {{name}} is
function toDatasetReferences(text, parameters) {
  return parameters.reduce((result, name) => result.split(`<${name}>`).join(`{{${name}}}`), text);
}

/**
 * TCV-6057: a Scenario Outline's Examples tables, as one table for a TestCollab
 * test dataset. A test case holds one dataset, so every Examples block goes
 * into it: the columns in the order they first appear, one row per example
 * row, and an empty value where a block has no such column. Null when there
 * is no column or no row, so a plain Scenario sends nothing.
 */
function extractExamples(scenario) {
  const parameters = [];
  const valuesByRow = [];
  for (const block of scenario.examples || []) {
    if (!block.tableHeader) {
      continue;
    }
    const header = block.tableHeader.cells.map(cell => cell.value);
    header.filter(Boolean).forEach(name => {
      if (!parameters.includes(name)) {
        parameters.push(name);
      }
    });
    for (const row of block.tableBody || []) {
      const values = new Map();
      row.cells.forEach((cell, index) => {
        values.set(header[index], cell.value);
      });
      valuesByRow.push(values);
    }
  }
  if (parameters.length === 0 || valuesByRow.length === 0) {
    return null;
  }
  return {
    parameters,
    rows: valuesByRow.map(values => parameters.map(name => (values.has(name) ? values.get(name) : '')))
  };
}

// Cell and doc string text is shown as written, never read as markup.
function escapeStepHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Parse a Gherkin file and extract structured data
 */
function parseGherkinFile(content, filePath) {
  try {
    // Use the v33 syntax with proper Parser/AstBuilder approach
    const uuidFn = messages.IdGenerator.uuid();
    const builder = new gherkin.AstBuilder(uuidFn);
    const matcher = new gherkin.GherkinClassicTokenMatcher();
    const parser = new gherkin.Parser(builder, matcher);
    
    // Parse the Gherkin content
    const gherkinDocument = parser.parse(content);
    
    if (!gherkinDocument || !gherkinDocument.feature) {
      return null;
    }
    
    const feature = gherkinDocument.feature;
    const scenarios = [];
    let background = null;
    // TCV-6912: scenarios written under a Rule: heading
    const ruleScenarios = [];

    // TCV-6912 / TCV-6202: the line-based extractors below read on to the next Scenario:
    // heading, so they took in what is written above it: a rule, and the first scenario's
    // tags, which became part of the feature description or of the background text the
    // server writes as the case description. So each one gets only its own block, which
    // ends where the next child starts, tags included. A background is always the first child.
    const [firstChild, secondChild] = feature.children || [];
    const featureDescription = extractFeatureDescription(linesBetween(content, 1, startOfChild(content, firstChild)));
    const backgroundText = firstChild && firstChild.background
      ? extractBackgroundText(linesBetween(content, firstChild.background.location.line, startOfChild(content, secondChild)))
      : [];

    // Process children to find scenarios and background
    for (const child of feature.children || []) {
      if (child.scenario) {
        scenarios.push(toSyncScenario(child.scenario, filePath));
      } else if (child.background) {
        // Background is in children, not directly on feature
        background = child.background;
      } else if (child.rule) {
        ruleScenarios.push(...parseRule(child.rule, content, filePath));
      }
    }
    
    // Calculate feature hash based on description + background + all scenario steps
    // TCV-6912 / TCV-6202: this stays what older CLIs hashed, the whole-file description
    // (with the rule or scenario tags it read on into) and the top-level scenarios only.
    // The suite they created is found by that hash, so changing it would lose the suite
    // on the next sync.
    const hashedDescription = extractFeatureDescription(content);
    let featureContent = '';
    if (hashedDescription) {
      featureContent += hashedDescription + '\n';
    }
    if (background) {
      const bgSteps = background.steps || [];
      featureContent += bgSteps.map(step => `${step.keyword}${step.text}`).join('\n');
    }
    featureContent += scenarios.map(s => s.steps.map(step => `${step.keyword}${step.text}`).join('\n')).join('\n');
    
    return {
      feature: {
        name: feature.name,
      FeatureDescription: featureDescription || '',
      // TCV-7031: a background table reaches every case of the feature
      background: background ? background.steps.map(step => formatStep(step)) : undefined,
      backgroundText: backgroundText && backgroundText.length > 0 ? backgroundText : undefined
      },
      featureHash: calculateHash(featureContent, filePath),
      scenarios: scenarios.concat(ruleScenarios)
    };
  } catch (error) {
    throw new Error(`Failed to parse Gherkin file: ${error.message}`);
  }
}

/**
 * A scenario as it is sent to TestCollab. TCV-6912: top-level scenarios and scenarios
 * under a Rule: both go through here, so a Scenario Outline is read the same way in both.
 */
function toSyncScenario(scenario, filePath) {
  const steps = scenario.steps || [];
  const stepsText = steps.map(step => `${step.keyword}${step.text}`).join('\n');
  // TCV-6057: a Scenario Outline's Examples become a test dataset its steps reference
  const examples = extractExamples(scenario);
  // TCV-7031: send the step's data table / doc string too; stepsText, the hash input, leaves them out
  const normalizedSteps = steps.map(step => formatStep(step, examples ? examples.parameters : []));

  return {
    hash: calculateHash(stepsText, filePath),
    // TCV-6057: the title's <name> too. The server strips anything tag-like from a new
    // case's title, so "Return after <days> days" would be stored as "Return after  days".
    title: examples ? toDatasetReferences(scenario.name, examples.parameters) : scenario.name,
    steps: normalizedSteps,
    tags: tagNames(scenario.tags),
    examples
  };
}

function tagNames(tags) {
  return (tags || [])
    .map(tag => (tag.name || '').trim())
    .filter(Boolean)
    .map(tagName => (tagName.startsWith('@') ? tagName.slice(1) : tagName));
}

/**
 * TCV-6912: the scenarios under a Rule: heading. A rule creates no suite, so its
 * scenarios sync into the feature suite like any other scenario. The rule's background
 * steps go ahead of each scenario's own steps (the server puts the feature background
 * ahead of both), and the rule's tags ahead of its own tags, as Cucumber inherits them.
 *
 * The rule itself travels in `rule`, from which the server writes the case description.
 * The hash stays on the scenario's own steps, so a scenario moved to another rule of the
 * same file updates its case.
 */
function parseRule(rule, content, filePath) {
  let background = null;
  const scenarios = [];
  for (const child of rule.children || []) {
    if (child.background) {
      background = child.background;
    } else if (child.scenario) {
      scenarios.push(child.scenario);
    }
  }
  if (scenarios.length === 0) {
    return [];
  }

  const syncRule = { title: rule.name };
  if (background) {
    // Read like the feature background text: the lines of the block, up to the first scenario
    const backgroundText = extractBackgroundText(
      linesBetween(content, background.location.line, firstLineOf(scenarios[0]))
    );
    if (backgroundText.length > 0) {
      syncRule.backgroundText = backgroundText;
    }
  }
  // Not rewritten for an outline's Examples, like the feature background (TCV-6057)
  const backgroundSteps = background ? background.steps.map(step => formatStep(step)) : [];
  const ruleTags = tagNames(rule.tags);

  return scenarios.map(scenario => {
    const synced = toSyncScenario(scenario, filePath);
    return {
      ...synced,
      steps: backgroundSteps.concat(synced.steps),
      tags: ruleTags.concat(synced.tags),
      rule: syncRule
    };
  });
}

// TCV-6912: the line a rule or scenario starts on, counting the tags written above it
function firstLineOf(node) {
  return Math.min(node.location.line, ...(node.tags || []).map(tag => tag.location.line));
}

// TCV-6202: the line a feature child (background, scenario or rule) starts on, counting its
// tags; the line after the last one when there is no such child
function startOfChild(content, child) {
  if (!child) {
    return content.split('\n').length + 1;
  }
  return firstLineOf(child.background || child.scenario || child.rule);
}

// TCV-6912: lines fromLine up to, not including, toLine; numbered from 1 as Gherkin does
function linesBetween(content, fromLine, toLine) {
  return content.split('\n').slice(fromLine - 1, toLine - 1).join('\n');
}

/**
 * Calculate SHA-1 hash for content and file path
 * Including the file path ensures renames generate new hashes
 */
function calculateHash(content, filePath) {
  const data = `${filePath}:${content}`;
  return createHash('sha1').update(data, 'utf8').digest('hex');
}

/**
 * Resolve old hashes to existing TestCollab IDs
 */
async function resolveIds(projectId, hashes, apiUrl, token) {
  if (hashes.features.length === 0 && hashes.scenarios.length === 0) {
    return { suites: {}, cases: {} };
  }
  
  const payload = { projectId };
  if (hashes.features.length > 0) {
    payload.features = hashes.features;
  }
  if (hashes.scenarios.length > 0) {
    payload.scenarios = hashes.scenarios;
  }
  
  try {
    const response = await fetch(`${apiUrl}/bdd/resolve-ids?token=${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        //'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to resolve IDs: ${response.status} ${response.statusText}`);
    }
    
    const responseData = await response.json();
    
    // Extract the results from the nested structure
    const results = responseData.results || {};
    return {
      suites: results.suites || {},
      cases: results.cases || {},
      // TCV-7036: every live case of each hash; an older API does not send it
      caseLists: results.caseLists
    };
  } catch (error) {
    throw new Error(`Failed to resolve IDs: ${error.message}`);
  }
}

/**
 * Build the final GherkinSyncDelta payload
 */
function buildSyncPayload(projectId, prevCommit, headCommit, changes, resolvedIds) {
  const payload = {
    projectId: parseInt(projectId),
    prevCommit,
    headCommit,
    changes: []
  };
  
  for (const change of changes) {
    const payloadChange = {
      status: change.status,
      oldPath: change.oldPath,
      newPath: change.newPath
    };
    if (DEBUG_BDD_SYNC) {
      console.log(`\n🧱 Change: ${change.status} ${change.oldPath || ''} -> ${change.newPath || ''}`);
      if (change.oldFeatureHash) {
        console.log(`   • oldFeatureHash: ${change.oldFeatureHash}`);
      }
    }
    
    if (change.feature) {
      payloadChange.feature = change.feature;
      
      // Include prevHash for any non-add change (Rxx and M) so API can update suite hash
      if (change.oldFeatureHash && change.status !== 'A') {
        payloadChange.feature.prevHash = change.oldFeatureHash;
      }
      
      // For renames or modifications, include the suiteId if we have it
      if (change.oldFeatureHash) {
        const suiteInfo = resolvedIds.suites[change.oldFeatureHash];
        if (suiteInfo && suiteInfo.suiteId) {
          payloadChange.feature.suiteId = suiteInfo.suiteId;
          if (DEBUG_BDD_SYNC) {
            console.log(`   • suite mapping: ${change.oldFeatureHash} -> suiteId ${suiteInfo.suiteId}`);
          }
        } else if (DEBUG_BDD_SYNC) {
          console.log(`   • suite mapping: ${change.oldFeatureHash} -> NOT FOUND`);
        }
      }
    }
    
    // TCV-7036: the old scenario each scenario continues, one to one, and each old scenario's case
    const oldScenarios = change.oldScenarios || [];
    const match = matchScenarios(change.scenarios || [], oldScenarios, resolvedIds);

    if (change.scenarios) {
      payloadChange.scenarios = change.scenarios.map((scenario, index) => {
        const payloadScenario = {
          hash: scenario.hash,
          title: scenario.title
        };

        if (scenario.tags && scenario.tags.length > 0) {
          payloadScenario.tags = scenario.tags;
        }
        
        // TCV-6912: the rule the scenario sits under, for its case description
        if (scenario.rule) {
          payloadScenario.rule = scenario.rule;
        }
        
        // The old scenario this one continues (see matchScenarios), and its case
        const oldIndex = match.oldIndexOf[index];
        if (oldIndex !== -1) {
          payloadScenario.prevHash = oldScenarios[oldIndex].hash;
          if (match.caseIds[oldIndex]) {
            payloadScenario.caseId = match.caseIds[oldIndex];
          }
          if (DEBUG_BDD_SYNC) {
            console.log(`     · mapping by ${match.reasons[index]}`);
          }
        }
        
        // Include steps based on Git status:
        // - R100 = rename only, no content change → don't include steps
        // - R97, R95, etc. = rename + content change → include steps
        // - M = modification → include steps  
        // - A = addition → include steps
        const shouldIncludeSteps = change.status !== 'R100';
        
        if (shouldIncludeSteps) {
          payloadScenario.steps = scenario.steps;
          // TCV-6057: the Examples table travels with the steps that reference it
          if (scenario.examples) {
            payloadScenario.examples = scenario.examples;
          }
        }

        if (DEBUG_BDD_SYNC) {
          console.log(`   • scenario[${index}] title="${scenario.title}"`);
          console.log(`     - prevHash: ${payloadScenario.prevHash || 'none'}`);
          console.log(`     - caseId: ${payloadScenario.caseId || 'none'}`);
          console.log(`     - newHash: ${payloadScenario.hash}`);
          console.log(`     - stepsIncluded: ${shouldIncludeSteps}`);
          console.log(`     - examples: ${payloadScenario.examples ? payloadScenario.examples.rows.length + ' row(s)' : 'none'}`);
        }
        
        return payloadScenario;
      });
      if (DEBUG_BDD_SYNC) {
        const count = payloadChange.scenarios.length;
        console.log(`   • scenarios prepared: ${count}`);
      }
    }
    
    // Include deleted scenarios (present before, missing now)
    // TCV-7036: an old scenario that no scenario continues. It goes with its case id, because
    // a hash can stand for several cases. Without one, only when no remaining scenario has
    // its hash, as before; and never with the case id a remaining scenario sends, which an
    // API without caseLists gives to every scenario of a shared hash.
    if (oldScenarios.length > 0 && change.status !== 'A') {
      const existingScenarios = payloadChange.scenarios || [];
      const newHashes = new Set(existingScenarios.map(s => s.hash).filter(Boolean));
      const newPrevHashes = new Set(existingScenarios.map(s => s.prevHash).filter(Boolean));
      const newCaseIds = new Set(existingScenarios.map(s => s.caseId).filter(Boolean));
      oldScenarios.forEach((old, oldIndex) => {
        if (match.continued.has(oldIndex)) {
          return;
        }
        const caseId = match.caseIds[oldIndex];
        if (caseId && !newCaseIds.has(caseId)) {
          existingScenarios.push({ prevHash: old.hash, caseId, deleted: true });
        } else if (!caseId && !newHashes.has(old.hash) && !newPrevHashes.has(old.hash)) {
          existingScenarios.push({ prevHash: old.hash, deleted: true });
        } else {
          return;
        }
        if (DEBUG_BDD_SYNC) {
          console.log(`   • scenario deleted: prevHash ${old.hash}${caseId ? `, caseId ${caseId}` : ''}`);
        }
      });
      if (existingScenarios.length > 0) {
        payloadChange.scenarios = existingScenarios;
        if (DEBUG_BDD_SYNC) {
          const deletedCount = existingScenarios.filter(s => s.deleted).length;
          console.log(`   • scenarios after deletion mark: ${existingScenarios.length} (deleted: ${deletedCount})`);
        }
      }
    }
    
    payload.changes.push(payloadChange);
  }
  
  if (DEBUG_BDD_SYNC) {
    console.log(`\n📦 Payload summary:`);
    console.log(`   • projectId: ${payload.projectId}`);
    console.log(`   • prevCommit: ${payload.prevCommit}`);
    console.log(`   • headCommit: ${payload.headCommit}`);
    console.log(`   • changes: ${payload.changes.length}`);
  }
  
  return payload;
}

// TCV-6912: the title a scenario is matched by. Under a rule it includes the rule title,
// because the same example title often repeats under several rules of one file.
function titleInRule(scenario) {
  return scenario.rule ? `${scenario.rule.title}\n${scenario.title}` : scenario.title;
}

/**
 * TCV-7036: which old scenario each scenario of the new file continues, and the test case
 * of each old scenario. The hash is the file path and the step lines, so scenarios with
 * the same steps share it: a match is one to one, never two scenarios on one old scenario.
 * Each pass goes over the scenarios still unmatched, in file order, from the strongest
 * sign to the weakest: the same steps and title, the same steps, the same title, the same
 * title under another rule when only one old scenario has it (TCV-6912), and the same
 * position when the file has as many scenarios as before.
 */
function matchScenarios(scenarios, oldScenarios, resolvedIds) {
  const oldIndexOf = scenarios.map(() => -1);
  const reasons = scenarios.map(() => null);
  const continued = new Set();
  const pass = (reason, fits) => {
    scenarios.forEach((scenario, index) => {
      if (oldIndexOf[index] !== -1) {
        return;
      }
      const oldIndex = oldScenarios.findIndex((old, i) => !continued.has(i) && fits(scenario, old, index, i));
      if (oldIndex !== -1) {
        oldIndexOf[index] = oldIndex;
        reasons[index] = reason;
        continued.add(oldIndex);
      }
    });
  };
  const oldTitleCount = title => oldScenarios.filter(old => old.title === title).length;

  pass('steps-hash and title equality', (s, old) => s.hash === old.hash && titleInRule(s) === titleInRule(old));
  pass('steps-hash equality', (s, old) => s.hash === old.hash);
  pass('title match', (s, old) => titleInRule(s) === titleInRule(old));
  pass('title match across rules', (s, old) => s.title === old.title && oldTitleCount(old.title) === 1);
  if (scenarios.length === oldScenarios.length) {
    pass('index fallback', (s, old, index, oldIndex) => index === oldIndex);
  }

  return { oldIndexOf, reasons, continued, caseIds: caseOfEachOldScenario(oldScenarios, resolvedIds) };
}

/**
 * TCV-7036: the test case of each old scenario. A hash that one old scenario has gets the
 * case resolve-ids names for it, as before. Old scenarios that share a hash share out the
 * live cases the API lists for it (caseLists): first each takes the oldest free case with
 * its title, then the rest take the oldest free cases in file order, so scenarios with the
 * same steps and title keep the cases of their order. An API without caseLists names one
 * case per hash, which then stands for all of them, as before.
 */
function caseOfEachOldScenario(oldScenarios, resolvedIds) {
  const caseIds = oldScenarios.map(old => {
    const caseInfo = resolvedIds.cases[old.hash];
    return caseInfo && caseInfo.caseId ? caseInfo.caseId : undefined;
  });
  const caseLists = resolvedIds.caseLists || {};
  const indexesByHash = new Map();
  oldScenarios.forEach((old, index) => {
    indexesByHash.set(old.hash, (indexesByHash.get(old.hash) || []).concat([index]));
  });

  indexesByHash.forEach((indexes, hash) => {
    if (indexes.length < 2 || !Array.isArray(caseLists[hash])) {
      return;
    }
    const free = caseLists[hash].slice();
    const shared = new Map();
    indexes.forEach(index => {
      const at = free.findIndex(entry => entry.title === oldScenarios[index].title);
      if (at !== -1) {
        shared.set(index, free.splice(at, 1)[0].caseId);
      }
    });
    indexes.forEach(index => {
      if (!shared.has(index) && free.length > 0) {
        shared.set(index, free.shift().caseId);
      }
    });
    indexes.forEach(index => {
      caseIds[index] = shared.get(index);
    });
  });
  return caseIds;
}

/**
 * Send the sync payload to TestCollab
 */
async function syncWithTestCollab(payload, apiUrl, token) {
  try {
    const response = await fetch(`${apiUrl}/bdd/sync?token=${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      let errorMessage = `API request failed (${response.status})`;
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
        const errorText = await response.text();
        if (errorText) {
          errorMessage = errorText;
        }
      }
      throw new Error(errorMessage);
    }
    
    return await response.json();
  } catch (error) {
    throw new Error(`Sync failed: ${error.message}`);
  }
}

/**
 * Display sync results to the user
 */
function displaySyncResults(result) {
  // TCV-7029: the API answers { success, message, results }; the counts and warnings are in results
  const counts = result.results || {};
  console.log('\n📊 Synchronization Results:');
  
  if (counts.createdSuites > 0) {
    console.log(`✨ Created ${counts.createdSuites} suite(s)`);
  }
  if (counts.createdCases > 0) {
    console.log(`✨ Created ${counts.createdCases} test case(s)`);
  }
  if (counts.renamedSuites > 0) {
    console.log(`🔄 Renamed ${counts.renamedSuites} suite(s)`);
  }
  if (counts.renamedCases > 0) {
    console.log(`🔄 Renamed ${counts.renamedCases} test case(s)`);
  }
  if (counts.updatedCases > 0) {
    console.log(`🔄 Updated ${counts.updatedCases} test case(s)`);
  }
  if (counts.deletedSuites > 0) {
    console.log(`🗑️  Deleted ${counts.deletedSuites} suite(s)`);
  }
  if (counts.deletedCases > 0) {
    console.log(`🗑️  Deleted ${counts.deletedCases} test case(s)`);
  }
  // TCV-7034: a removed scenario archives its test case, and one that comes back restores it
  if (counts.archivedCases > 0) {
    console.log(`🗄️  Archived ${counts.archivedCases} test case(s) whose scenario was removed`);
  }
  if (counts.restoredCases > 0) {
    console.log(`♻️  Restored ${counts.restoredCases} archived test case(s) whose scenario is back`);
  }
  
  if (counts.warnings && counts.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    counts.warnings.forEach(warning => console.log(`   ${warning}`));
  }
  
  // Show if no changes were made
  const totalChanges = (counts.createdSuites || 0) + (counts.createdCases || 0) + 
                      (counts.renamedSuites || 0) + (counts.renamedCases || 0) + 
                      (counts.updatedCases || 0) + (counts.deletedSuites || 0) + 
                      (counts.deletedCases || 0) + (counts.archivedCases || 0) + 
                      (counts.restoredCases || 0);
  
  if (totalChanges === 0) {
    console.log('ℹ️  No changes were required - everything is already in sync');
  }
}

/**
 * Check for uncommitted changes to .feature files and warn the user
 */
async function checkUncommittedChanges(git) {
  try {
    // Get both staged and unstaged changes
    const statusResult = await git.status();
    
    // Filter for .feature files only
    const uncommittedFeatureFiles = [];
    
    // Check staged files
    statusResult.staged.forEach(file => {
      if (file.endsWith('.feature')) {
        uncommittedFeatureFiles.push(file);
      }
    });
    
    // Check modified (unstaged) files
    statusResult.modified.forEach(file => {
      if (file.endsWith('.feature') && !uncommittedFeatureFiles.includes(file)) {
        uncommittedFeatureFiles.push(file);
      }
    });
    
    // Check created (untracked) files
    statusResult.created.forEach(file => {
      if (file.endsWith('.feature') && !uncommittedFeatureFiles.includes(file)) {
        uncommittedFeatureFiles.push(file);
      }
    });
    
    // Show warning if uncommitted changes exist
    if (uncommittedFeatureFiles.length > 0) {
      console.log('⚠️  Warning: You have uncommitted changes in the following .feature files:');
      uncommittedFeatureFiles.forEach(file => {
        console.log(`   📄 ${file}`);
      });
      console.log('   These changes will not be synced. Please commit them first if you want them included.\n');
    }
  } catch (error) {
    // If git status fails, just continue - don't block the sync
    console.warn(`⚠️  Warning: Could not check for uncommitted changes: ${error.message}`);
  }
}
