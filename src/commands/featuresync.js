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
    const resolvedIds = await resolveIds(options.project, oldHashes, options.apiUrl, token);

    // Step 6: Build final payload
    console.log('📦 Building sync payload...');
    const payload = buildSyncPayload(
      options.project,
      lastSyncedCommit,
      headCommit,
      processedChanges,
      resolvedIds
    );

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
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch sync state: ${response.status} ${response.statusText}`);
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
    if (change.oldPath && lastSyncedCommit) {
      const oldContent = await git.show([`${lastSyncedCommit}:${change.oldPath}`]);
      const oldParsed = parseGherkinFile(oldContent);
      if (oldParsed) {
        processed.oldFeatureHash = oldParsed.featureHash;
        processed.oldScenarioHashes = oldParsed.scenarios.map(s => s.hash);
      }
    }

    // Get new file content for A, M, R changes
    if (change.newPath) {
      const newContent = await git.show([`HEAD:${change.newPath}`]);
      const newParsed = parseGherkinFile(newContent);
      if (newParsed) {
        processed.feature = {
          hash: newParsed.featureHash,
          title: newParsed.feature.name,
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
 * Parse a Gherkin file and extract structured data
 */
function parseGherkinFile(content) {
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
    
    // Process children to find scenarios and background
    for (const child of feature.children || []) {
      if (child.scenario) {
        const scenario = child.scenario;
        const steps = scenario.steps || [];
        const stepsText = steps.map(step => `${step.keyword}${step.text}`).join('\n');
        
        scenarios.push({
          hash: calculateHash(stepsText),
          title: scenario.name,
          steps: steps.map(step => ({
            keyword: step.keyword.trim(),
            text: step.text
          }))
        });
      } else if (child.background) {
        // Background is in children, not directly on feature
        background = child.background;
      }
    }
    
    // Calculate feature hash based on background + all scenario steps
    let featureContent = '';
    if (background) {
      const bgSteps = background.steps || [];
      featureContent += bgSteps.map(step => `${step.keyword}${step.text}`).join('\n');
    }
    featureContent += scenarios.map(s => s.steps.map(step => `${step.keyword}${step.text}`).join('\n')).join('\n');
    
    return {
      feature: {
        name: feature.name,
        background: background ? background.steps.map(step => ({
          keyword: step.keyword.trim(),
          text: step.text
        })) : undefined
      },
      featureHash: calculateHash(featureContent),
      scenarios
    };
  } catch (error) {
    throw new Error(`Failed to parse Gherkin file: ${error.message}`);
  }
}

/**
 * Calculate SHA-1 hash for content
 */
function calculateHash(content) {
  return createHash('sha1').update(content, 'utf8').digest('hex');
}

/**
 * Resolve old hashes to existing TestCollab IDs
 */
async function resolveIds(projectId, hashes, apiUrl, token) {
  if (hashes.features.length === 0 && hashes.scenarios.length === 0) {
    return { suites: {}, test_cases: {} };
  }
  
  const payload = { projectId };
  if (hashes.features.length > 0) {
    payload.features = hashes.features;
  }
  if (hashes.scenarios.length > 0) {
    payload.scenarios = hashes.scenarios;
  }
  
  try {
    const response = await fetch(`${apiUrl}/resolve-ids?token=${token}`, {
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
    
    return await response.json();
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
    
    if (change.feature) {
      payloadChange.feature = change.feature;
    }
    
    if (change.scenarios) {
      payloadChange.scenarios = change.scenarios.map(scenario => {
        const payloadScenario = {
          hash: scenario.hash,
          title: scenario.title
        };
        
        // Add caseId if this is an update to existing scenario
        const caseId = resolvedIds.test_cases[scenario.hash];
        if (caseId) {
          payloadScenario.caseId = caseId;
        }
        
        // Include steps for new or modified scenarios
        if (!caseId || scenario.steps) {
          payloadScenario.steps = scenario.steps;
        }
        
        return payloadScenario;
      });
    }
    
    payload.changes.push(payloadChange);
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
