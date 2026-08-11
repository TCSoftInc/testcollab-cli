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
import { createBuild } from './commands/createBuild.js';
import { report } from './commands/report.js';
import { getTestPlan } from './commands/getTestPlan.js';
import { gate } from './commands/gate.js';

// Initialize commanderq
const program = new Command();

program
  .name('tc')
  .description('TestCollab CLI - Command-line interface for TestCollab operations')
  .version('1.0.0')
  // TCV-6794: only treat `tc`'s own options (-V/--version, -h) as such before the
  // subcommand name, so `tc createBuild --version <build version>` reaches the
  // command instead of printing the CLI version. `tc --version` still works.
  .enablePositionalOptions();

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
  .option('--build <idOrVersion>', 'Build ID or version string the plan is executed against')
  .option('--release <id>', 'Release ID the plan belongs to')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(createTestPlan);

// Add createBuild command (TCV-6794)
program
  .command('createBuild')
  .description('Record the build your pipeline just produced or deployed, so results are traceable to it')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--version <version>', 'Version that was built or deployed')
  .option('--environment <name>', 'Environment it was deployed to')
  .option('--deployment-url <url>', 'Link to the pipeline run or deployment')
  .option('--commit <sha>', 'Commit SHA the build was produced from')
  .option('--commit-url <url>', 'Link to the commit in your VCS (falls back to server-side resolution when omitted)')
  .option('--repo-url <url>', 'Link to the repository the build was produced from')
  .option('--notes <text>', 'Free-text note about the build')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(createBuild);

// Add report command
program
  .command('report')
  .description('Upload test results (Mochawesome JSON or JUnit XML) to TestCollab and attach to a Test Plan')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .option('--test-plan-id <id>', 'Test Plan ID (required unless --auto-create is used)')
  .requiredOption('--format <type>', 'Result format: mochawesome or junit')
  .requiredOption('--result-file <path>', 'Path to test result file')
  .option('--api-url <url>', 'TestCollab API base URL override', 'https://api.testcollab.io')
  .option('--skip-missing', 'Mark test cases in the test plan but not in the result file as skipped', false)
  .option('--auto-create', 'Auto-create missing tag, suites, test cases, folder, and test plan from result file')
  .action(report);

// Add getTestPlan command
program
  .command('getTestPlan')
  .description('Fetch a test plan and its test cases as JSON (for agent-driven execution)')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--test-plan-id <id>', 'Test plan ID to fetch')
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .option('--output <path>', 'Write JSON to file instead of stdout')
  .action(getTestPlan);

// Add gate command
program
  .command('gate')
  .description('Evaluate a Test Plan\'s results and fail the build (exit non-zero) when the quality gate is not met')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--test-plan-id <id>', 'Test Plan ID to evaluate')
  .option('--fail-on <statuses>', 'Comma-separated statuses that fail the gate', 'failed')
  .option('--max-failed <n>', 'Allow up to N cases in --fail-on statuses before failing', '0')
  .option('--min-pass-rate <pct>', 'Fail if the pass rate (passed / executed) is below this percent')
  .option('--require-complete', 'Fail if any case in the run is still unexecuted', false)
  .option('--config <id>', 'Evaluate a single Test Plan configuration')
  .option('--regression <id>', 'Evaluate a specific run/regression (default: latest)')
  .option('--wait <seconds>', 'Poll until the run has no unexecuted cases, up to this many seconds', '0')
  .option('--poll-interval <seconds>', 'Seconds between polls when --wait is set', '15')
  .option('--api-url <url>', 'TestCollab API base URL override', 'https://api.testcollab.io')
  .action(gate);

// Parse command line arguments and execute the program
program.parse(process.argv);

// Show help if no command is provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
