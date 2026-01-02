#!/usr/bin/env node

/**
 * TestCollab CLI - Main Entry Point
 * 
 * A command-line interface for TestCollab operations.
 * Provides various commands for managing TestCollab projects.
 */

import { Command } from 'commander';
import { featuresync } from './commands/featuresync.js';
import { createTestPlan } from './commands/createTestPlan.js';
import { report } from './commands/report.js';
import { specgen } from './commands/specgen.js';

// Initialize commanderq
const program = new Command();

program
  .name('tc')
  .description('TestCollab CLI - Command-line interface for TestCollab operations')
  .version('1.0.0');

// Add sync command
program
  .command('sync')
  .description('Synchronize Gherkin feature files with TestCollab using Git')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(featuresync);

// Add createTestPlan command
program
  .command('createTestPlan')
  .description('Create a new Test Plan, add CI-tagged cases, and assign it')
  .requiredOption('--api-key <key>', 'TestCollab API key (was TESTCOLLAB_API_KEY)')
  .requiredOption('--project <id>', 'TestCollab project ID (was TESTCOLLAB_PROJECT_ID)')
  .requiredOption('--ci-tag-id <id>', 'CI tag ID to include cases (was TESTCOLLAB_CI_TAG_ID)')
  .requiredOption('--assignee-id <id>', 'User ID to assign execution (was TESTCOLLAB_ASSIGNEE_ID)')
  .requiredOption('--company-id <id>', 'Company ID (was TESTCOLLAB_COMPANY_ID)')
  // .option('--node-env <env>', 'Node environment (was NODE_ENV)', process.env.NODE_ENV || 'production')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(createTestPlan);

// Add report command
program
  .command('report')
  .description('Upload a Mochawesome JSON result to TestCollab and attach to a Test Plan')
  .requiredOption('--api-key <key>', 'TestCollab API key (was TESTCOLLAB_API_KEY)')
  .requiredOption('--project <id>', 'TestCollab project ID (was TESTCOLLAB_PROJECT_ID)')
  .requiredOption('--company-id <id>', 'Company ID (was TESTCOLLAB_COMPANY_ID)')
  .requiredOption('--test-plan-id <id>', 'Test Plan ID (was TESTCOLLAB_TEST_PLAN_ID)')
  .option('--api-url <url>', 'TestCollab API base URL override')
  .option('--mocha-json-result <path>', 'Path to mochawesome.json', './mochawesome-report/mochawesome.json')
  .action(report);

// Add specgen command
program
  .command('specgen')
  .description('Generate Gherkin `.feature` files by crawling source code with AI assistance')
  .option('--src <path>', 'Source directory to analyze', './src')
  .option('--out <path>', 'Output directory for generated `.feature` files', './features')
  .option('--cache <path>', 'Cache file for discovered targets/families', '.testcollab/specgen.json')
  .option('--model <name>', 'Anthropic model to use', 'claude-sonnet-4-5-20250929')
  .option('--yes', 'Skip confirmation prompts', false)
  .option('--dry-run', 'Discover and preview targets without generating files', false)
  .action(specgen);

// Parse command line arguments and execute the program
program.parse(process.argv);

// Show help if no command is provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
