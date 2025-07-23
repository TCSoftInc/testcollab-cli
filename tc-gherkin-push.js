#!/usr/bin/env node

/**
 * tc-gherkin-push.js
 * 
 * A CLI tool that uploads local *.feature files to Test Collab.
 * 
 * Usage:
 *   tc-gherkin-push --project <id> [--dir <path>] [--remove-orphaned]
 * 
 * Options:
 *   --project <id>        Test Collab project ID
 *   --dir <path>          Directory containing feature files (default: "features")
 *   --remove-orphaned     Remove orphaned test cases/suites not in feature files
 *   --api-url <url>       Test Collab API base URL (default: "https://api.testcollab.io")
 * 
 * Environment variables:
 *   TESTCOLLAB_TOKEN  API token for Test Collab authentication
 */

import { Command } from 'commander';
import { glob } from 'glob';
import fs from 'fs/promises';
import path from 'path';

// Initialize commander
const program = new Command();

program
  .name('tc-gherkin-push')
  .description('Upload Gherkin feature files to Test Collab')
  .requiredOption('--project <id>', 'Test Collab project ID')
  .option('--dir <path>', 'Directory containing feature files', 'features')
  .option('--remove-orphaned', 'Remove orphaned test cases/suites not in feature files', false)
  .option('--api-url <url>', 'Test Collab API base URL', 'https://api.testcollab.io')
  .version('1.0.0');

// Main execution logic
program.action(async (options) => {
  try {
    // Validate environment
    const token = process.env.TESTCOLLAB_TOKEN;
    if (!token) {
      console.error('Error: TESTCOLLAB_TOKEN environment variable is not set');
      process.exit(1);
    }

    // Validate directory exists
    try {
      await fs.access(options.dir);
    } catch (error) {
      console.error(`Error: Directory "${options.dir}" does not exist`);
      process.exit(1);
    }
    
    // Build gherkin tree from feature files
    console.log(`📁 Scanning directory: ${options.dir}`);
    const gherkinTree = await buildGherkinTree(options.dir);
    
    if (gherkinTree.length === 0) {
      console.log(`No feature files found in ${options.dir}`);
      return;
    }
    
    console.log(`📄 Found ${countFeatureFiles(gherkinTree)} feature file(s)`);
    
    console.log({options})
    // Send to Test Collab API
    await syncWithTestCollab(options.project, gherkinTree, options.removeOrphaned, options.apiUrl, token);
    
    console.log('✅ Synchronization completed successfully');
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
});

/**
 * Build a gherkin tree structure from the feature files directory
 * @param {string} directoryPath - The root directory containing feature files
 * @returns {Array} Array of GherkinTree nodes
 */
async function buildGherkinTree(directoryPath) {
  const tree = [];
  
  try {
    // Get all items in the directory
    const items = await fs.readdir(directoryPath, { withFileTypes: true });
    
    for (const item of items) {
      const itemPath = path.join(directoryPath, item.name);
      
      if (item.isDirectory()) {
        // Recursively process subdirectories
        const children = await buildGherkinTree(itemPath);
        
        // Only include directories that contain feature files (directly or in subdirectories)
        if (children.length > 0) {
          tree.push({
            name: item.name,
            type: 'directory',
            children: children
          });
        }
      } else if (item.isFile() && item.name.endsWith('.feature')) {
        // Read feature file content
        const content = await fs.readFile(itemPath, 'utf8');
        const relativePath = path.relative(process.cwd(), itemPath);
        
        tree.push({
          name: item.name,
          type: 'file',
          path: relativePath,
          content: content
        });
      }
    }
    
    return tree;
  } catch (error) {
    throw new Error(`Failed to build gherkin tree: ${error.message}`);
  }
}

/**
 * Count the total number of feature files in the tree
 * @param {Array} tree - The gherkin tree
 * @returns {number} Total count of feature files
 */
function countFeatureFiles(tree) {
  let count = 0;
  
  for (const node of tree) {
    if (node.type === 'file') {
      count++;
    } else if (node.type === 'directory' && node.children) {
      count += countFeatureFiles(node.children);
    }
  }
  
  return count;
}

/**
 * Sync the gherkin tree with Test Collab
 * @param {string} projectId - The Test Collab project ID
 * @param {Array} gherkinTree - The gherkin tree structure
 * @param {boolean} removeOrphaned - Whether to remove orphaned items
 * @param {string} apiUrl - The API base URL
 * @param {string} token - The authentication token
 */
async function syncWithTestCollab(projectId, gherkinTree, removeOrphaned, apiUrl, token) {
  const payload = {
    project: parseInt(projectId),
    gherkinTree: gherkinTree,
    removeOrphaned: removeOrphaned
  };
  
  console.log('🚀 Syncing with Test Collab...');
  console.log({payload, apiUrl})
  try {
    const response = await fetch(`${apiUrl}/testcases/gherkin?token=${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        //'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed (${response.status}): ${errorText}`);
    }
    
    const result = await response.json();
    
    // Display sync results
    if (result.created) {
      console.log(`✨ Created: ${result.created.suites || 0} suite(s), ${result.created.testCases || 0} test case(s)`);
    }
    
    if (result.updated) {
      console.log(`🔄 Updated: ${result.updated.suites || 0} suite(s), ${result.updated.testCases || 0} test case(s)`);
    }
    
    if (result.deleted && removeOrphaned) {
      console.log(`🗑️  Deleted: ${result.deleted.suites || 0} suite(s), ${result.deleted.testCases || 0} test case(s)`);
    }
    
    return result;
  } catch (error) {
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error(`Failed to connect to Test Collab API at ${apiUrl}. Please check your network connection and API URL.`);
    }
    throw error;
  }
}

// Parse command line arguments and execute the program
program.parse(process.argv);
