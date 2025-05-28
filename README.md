# testcollab-cli

A command-line toolkit for Test Collab operations, with `tc-gherkin-push` as the first available tool. This toolkit is designed to be extensible, with more tools to be added in the future.

## Available Tools

### tc-gherkin-push

A command-line tool that uploads local Gherkin `.feature` files to Test Collab, allowing for seamless integration of BDD test cases with your Test Collab project.

#### Description

`tc-gherkin-push` recursively scans a directory for Gherkin feature files and either creates new test cases or updates existing ones in Test Collab. It uses the filename as the test case title and automatically manages the synchronization process.

- ➕ Creates new test cases when they don't exist in Test Collab
- 🔄 Updates existing test cases when they already exist

## Installation

### Global Installation

```bash
npm install -g testcollab-cli
```

This allows you to run the commands from anywhere in your system.

### Local Installation

```bash
npm install --save-dev testcollab-cli
```

With local installation, you can run the tool using npx:

```bash
npx tc-gherkin-push --project <id>
```

## Authentication

The tools require a Test Collab API token for authentication, which should be set as an environment variable:

```bash
export TESTCOLLAB_TOKEN=your_api_token_here
```

For Windows Command Prompt:
```cmd
set TESTCOLLAB_TOKEN=your_api_token_here
```

For Windows PowerShell:
```powershell
$env:TESTCOLLAB_TOKEN = "your_api_token_here"
```

You can obtain an API token from your Test Collab account settings.

## Usage

### tc-gherkin-push

#### Basic Usage

```bash
tc-gherkin-push --project <project_id>
```

This will scan the default `features` directory for `.feature` files.

#### Specify a Different Directory

```bash
tc-gherkin-push --project <project_id> --dir path/to/features
```

#### Command-line Options

- `--project <id>` (required): The Test Collab project ID
- `--dir <path>` (optional): Directory containing feature files (default: "features")
- `--help`: Display help information
- `--version`: Display version information

### How It Works

1. The tool recursively scans the specified directory for all `.feature` files
2. For each file, it extracts the filename to use as the test case title
3. It queries Test Collab to check if a test case with that title already exists
4. If the test case exists, it updates it with the current file content
5. If the test case doesn't exist, it creates a new one

### Examples

#### Example 1: Upload All Feature Files from the Default Directory

```bash
tc-gherkin-push --project 123
```

#### Example 2: Upload Feature Files from a Custom Directory

```bash
tc-gherkin-push --project 123 --dir tests/acceptance
```

### Notes

- The tool treats the entire filename (including extension) as the test case title
- Test cases are identified by title matching only
- All feature files are uploaded with test_type set to "gherkin"
- Feature files with the same filename in different subdirectories may cause conflicts

## Development

### Future Enhancements

- Additional tools for Test Collab operations
- AST parsing for more granular Gherkin handling
- Pull functionality to download test cases from Test Collab
- Conflict resolution options for duplicate titles

## License

MIT
