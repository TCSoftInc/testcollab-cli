#!/usr/bin/env node

/**
 * TestCollab CLI - Main Entry Point
 * 
 * A command-line interface for TestCollab operations.
 * Provides various commands for managing TestCollab projects.
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { featuresync } from './commands/featuresync.js';
import { createTestPlan } from './commands/createTestPlan.js';
import { createBuild } from './commands/createBuild.js';
import { report } from './commands/report.js';
import { getTestPlan } from './commands/getTestPlan.js';
import { gate } from './commands/gate.js';
import { collectAttachment, reportCase } from './commands/reportCase.js';
import {
  describeSecret,
  exportSecrets,
  listSecrets,
  safeSecretCommandError
} from './commands/secret.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// Initialize commanderq
const program = new Command();

program
  .name('tc')
  .description('TestCollab CLI - Command-line interface for TestCollab operations')
  .version(version)
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
  // TCV-6891: off by default, which keeps the default assignee each test case
  // carries (TCV-6779) and gives --assignee-id only the cases without one.
  .option('--override-assignees', 'Assign every test case to --assignee-id, replacing the default assignees inherited from the test cases', false)
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(createTestPlan);

// Add createBuild command (TCV-6794)
program
  .command('createBuild')
  .description('Record the build your pipeline just produced or deployed, so results are traceable to it')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  // TCV-6794: these are read from the CI provider's environment when omitted
  // (Azure DevOps, GitHub Actions, GitLab CI, Bitbucket, CircleCI, Jenkins).
  .option('--version <version>', 'Version that was built or deployed (default: the CI build number)')
  .option('--environment <name>', 'Environment it was deployed to')
  .option('--deployment-url <url>', 'Link to the pipeline run or deployment (default: from CI)')
  .option('--commit <sha>', 'Commit SHA the build was produced from (default: from CI)')
  .option('--commit-url <url>', 'Link to the commit in your VCS (default: detected from the CI environment)')
  .option('--repo-url <url>', 'Link to the repository the build was produced from (default: from CI)')
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
  .option('--build <idOrVersion>', 'Build the results were run against, by id or version; the version is created as a build if no build records it yet (requires --auto-create)')
  .option('--environment <name>', 'Environment recorded on the build when --build creates it (e.g. Staging)')
  .action(report);

// Report one execution as soon as it finishes. This is the Agent-friendly
// counterpart to the file-oriented bulk `report` command.
program
  .command('reportCase')
  .description('Report one assigned test case execution immediately')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--test-plan-run-id <id>', 'Exact Test Plan run/regression ID')
  .requiredOption('--executed-test-case-id <id>', 'Executed Test Case ID from tc getTestPlan')
  .requiredOption('--status <system-name>', 'Active status system name, including custom statuses')
  .option('--comment <text>', 'Execution comment')
  .option('--time-taken <seconds>', 'Seconds spent executing this case')
  .option('--step-results-file <path>', 'JSON array of step-wise results')
  .option('--attachment <path>', 'Attach a file to this execution; repeatable', collectAttachment, [])
  .option('--api-url <url>', 'TestCollab API base URL', 'https://api.testcollab.io')
  .action(reportCase);

// Add getTestPlan command
program
  .command('getTestPlan')
  .description('Fetch a test plan and its test cases as JSON (for agent-driven execution)')
  .option('--api-key <key>', 'TestCollab API key (or set TESTCOLLAB_TOKEN env var)')
  .requiredOption('--project <id>', 'TestCollab project ID')
  .requiredOption('--test-plan-id <id>', 'Test plan ID to fetch')
  .option('--test-plan-run-id <id>', 'Include exact executions assigned to this caller in the run')
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

const secret = program
  .command('secret')
  .description('Inspect or export the Secrets granted to this Agent run');

secret
  .command('list')
  .description('List secret names and types granted to this Agent run (never values)')
  .action(() => {
    try {
      listSecrets();
    } catch (error) {
      console.error(`❌ Error: ${safeSecretCommandError(error)}`);
      process.exitCode = 2;
    }
  });

secret
  .command('describe <name>')
  .description('Show allowlisted metadata for one granted secret (never its value)')
  .action((name) => {
    try {
      describeSecret(name);
    } catch (error) {
      console.error(`❌ Error: ${safeSecretCommandError(error)}`);
      process.exitCode = 2;
    }
  });

secret
  .command('export')
  .description('Print every Secret granted to this Agent run as one JSON object of TC_SECRET_* variables (run by the Agent runtime at boot)')
  .option('--api-url <url>', 'TestCollab API base URL override (defaults to TESTCOLLAB_API_URL)')
  .action(async (options) => {
    try {
      await exportSecrets({ apiUrl: options.apiUrl });
    } catch (error) {
      console.error(`❌ Error: ${safeSecretCommandError(error)}`);
      process.exitCode = 2;
    }
  });

// Parse command line arguments and execute the program
program.parse(process.argv);

// Show help if no command is provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
