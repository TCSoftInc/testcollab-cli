#!/usr/bin/env node

/**
 * TestCollab CLI - Main Entry Point
 * 
 * A command-line interface for TestCollab operations.
 * Provides various commands for managing TestCollab projects.
 */

import { Command } from 'commander';
import { featuresync } from './commands/featuresync.js';

// Initialize commander
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

// Parse command line arguments and execute the program
program.parse(process.argv);

// Show help if no command is provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
