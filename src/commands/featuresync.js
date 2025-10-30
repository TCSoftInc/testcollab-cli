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

/**
 * Main featuresync command handler
 * @param {Object} options - Command options from commander
 */
export async function featuresync(options) {
  try {
    // Validate environment
    const token = process.env.TESTCOLLAB_TOKEN;
    if (!token) {
      console.error('❌ Error: TESTCOLLAB_TOKEN environment variable is not set');
      console.error('   Please set your TestCollab API token as an environment variable.');
      console.error('   Example: export TESTCOLLAB_TOKEN=your_api_token_here');
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
    // Get old file content for M, D, R changes
    if (lastSyncedCommit) {
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
          background: newParsed.feature.background
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
    
    // Extract feature description text that appears between Feature: and Background/Scenario
    const featureDescription = extractFeatureDescription(content);
    
    // Process children to find scenarios and background
    for (const child of feature.children || []) {
      if (child.scenario) {
        const scenario = child.scenario;
        const steps = scenario.steps || [];
        const stepsText = steps.map(step => `${step.keyword}${step.text}`).join('\n');
        
        scenarios.push({
          hash: calculateHash(stepsText, filePath),
          title: scenario.name,
          steps: steps.map(step => `${step.keyword}${step.text}`)
        });
      } else if (child.background) {
        // Background is in children, not directly on feature
        background = child.background;
      }
    }
    
    // Calculate feature hash based on description + background + all scenario steps
    let featureContent = '';
    if (featureDescription) {
      featureContent += featureDescription + '\n';
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
        background: background ? background.steps.map(step => `${step.keyword}${step.text}`) : undefined
      },
      featureHash: calculateHash(featureContent, filePath),
      scenarios
    };
  } catch (error) {
    throw new Error(`Failed to parse Gherkin file: ${error.message}`);
  }
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
      cases: results.cases || {}
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
      
      // For renames, include the prevHash
      if (change.status.startsWith('R') && change.oldFeatureHash) {
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
    
    if (change.scenarios) {
      // Build helper sets/maps for robust mapping
      const oldHashesSet = new Set(change.oldScenarioHashes || []);
      const oldTitleToHash = new Map((change.oldScenarios || []).map(s => [s.title, s.hash]));
      const sameLengthAsOld = !!change.oldScenarioHashes && change.oldScenarioHashes.length === change.scenarios.length;

      payloadChange.scenarios = change.scenarios.map((scenario, index) => {
        const payloadScenario = {
          hash: scenario.hash,
          title: scenario.title
        };
        
        // Determine prevHash robustly:
        // 1) If steps unchanged, new hash equals some old hash → use that
        if (oldHashesSet.has(scenario.hash)) {
          payloadScenario.prevHash = scenario.hash;
          if (DEBUG_BDD_SYNC) {
            console.log(`     · mapping by steps-hash equality`);
          }
        } else if (oldTitleToHash.has(scenario.title)) {
          // 2) Title unchanged → use old hash by title
          payloadScenario.prevHash = oldTitleToHash.get(scenario.title);
          if (DEBUG_BDD_SYNC) {
            console.log(`     · mapping by title match`);
          }
        } else if (sameLengthAsOld && change.oldScenarioHashes && change.oldScenarioHashes[index]) {
          // 3) Fallback: index mapping only when counts are equal
          payloadScenario.prevHash = change.oldScenarioHashes[index];
          if (DEBUG_BDD_SYNC) {
            console.log(`     · mapping by index fallback`);
          }
        }
        
        // Add caseId if this is an update to existing scenario (use prevHash to look up)
        if (payloadScenario.prevHash) {
          const caseInfo = resolvedIds.cases[payloadScenario.prevHash];
          if (caseInfo && caseInfo.caseId) {
            payloadScenario.caseId = caseInfo.caseId;
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
        }
        
        if (DEBUG_BDD_SYNC) {
          console.log(`   • scenario[${index}] title="${scenario.title}"`);
          console.log(`     - prevHash: ${payloadScenario.prevHash || 'none'}`);
          console.log(`     - caseId: ${payloadScenario.caseId || 'none'}`);
          console.log(`     - newHash: ${payloadScenario.hash}`);
          console.log(`     - stepsIncluded: ${shouldIncludeSteps}`);
        }
        
        return payloadScenario;
      });
      if (DEBUG_BDD_SYNC) {
        const count = payloadChange.scenarios.length;
        console.log(`   • scenarios prepared: ${count}`);
      }
    }
    
    // Include deleted scenarios (present before, missing now)
    if (change.oldScenarioHashes && change.oldScenarioHashes.length > 0 && change.status !== 'A') {
      const existingScenarios = payloadChange.scenarios || [];
      const newHashes = new Set(existingScenarios.map(s => s.hash).filter(Boolean));
      const newPrevHashes = new Set(existingScenarios.map(s => s.prevHash).filter(Boolean));
      for (const oldHash of change.oldScenarioHashes) {
        if (!newHashes.has(oldHash) && !newPrevHashes.has(oldHash)) {
          existingScenarios.push({ prevHash: oldHash, deleted: true });
          if (DEBUG_BDD_SYNC) {
            console.log(`   • scenario deleted: prevHash ${oldHash}`);
          }
        }
      }
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
  console.log('\n📊 Synchronization Results:');
  
  if (result.createdSuites > 0) {
    console.log(`✨ Created ${result.createdSuites} suite(s)`);
  }
  if (result.createdCases > 0) {
    console.log(`✨ Created ${result.createdCases} test case(s)`);
  }
  if (result.renamedSuites > 0) {
    console.log(`🔄 Renamed ${result.renamedSuites} suite(s)`);
  }
  if (result.renamedCases > 0) {
    console.log(`🔄 Renamed ${result.renamedCases} test case(s)`);
  }
  if (result.updatedCases > 0) {
    console.log(`🔄 Updated ${result.updatedCases} test case(s)`);
  }
  if (result.deletedSuites > 0) {
    console.log(`🗑️  Deleted ${result.deletedSuites} suite(s)`);
  }
  if (result.deletedCases > 0) {
    console.log(`🗑️  Deleted ${result.deletedCases} test case(s)`);
  }
  
  if (result.warnings && result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    result.warnings.forEach(warning => console.log(`   ${warning}`));
  }
  
  // Show if no changes were made
  const totalChanges = (result.createdSuites || 0) + (result.createdCases || 0) + 
                      (result.renamedSuites || 0) + (result.renamedCases || 0) + 
                      (result.updatedCases || 0) + (result.deletedSuites || 0) + 
                      (result.deletedCases || 0);
  
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
