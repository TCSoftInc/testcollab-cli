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
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(featuresync);

// Add createTestPlan command
program
  .command('createTestPlan')
  .description('Create a new Test Plan, add CI-tagged cases, and assign it')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--ci-tag-id <id>', 'CI tag ID to include cases')
  .requiredOption('--assignee-id <id>', 'User ID to assign execution')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(createTestPlan);

// Add report command
program
  .command('report')
  .description('Upload test results (Mochawesome JSON or JUnit XML) to TestCollab and attach to a Test Plan')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--test-plan-id <id>', 'Test Plan ID')
  .requiredOption('--format <type>', 'Result format: mochawesome or junit')
  .requiredOption('--result-file <path>', 'Path to test result file')
  .option('--api-url <url>', 'TestCollab API base URL override', 'https://api.testcollab.io')
  .option('--skip-missing', 'Mark test cases in the test plan but not in the result file as skipped', false)
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
