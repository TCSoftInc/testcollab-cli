# Gherkin Sync Integration Tests

This directory contains integration tests for the TestCollab Gherkin feature file synchronization system.

## Prerequisites

1. **TestCollab API Running**: Ensure your TestCollab API is running on `http://localhost:1337` (or set `TESTCOLLAB_URL` to your API URL)
2. **API Token**: You need a valid TestCollab API token with permissions to create/modify test suites and test cases
3. **Test Project**: A project in TestCollab where the tests will create test suites and cases

## Environment Variables

Set these environment variables before running tests:

```bash
# Required
export TESTCOLLAB_TOKEN="your-api-token-here"

# Optional (with defaults)
export TESTCOLLAB_URL="http://localhost:1337"  # Default: http://localhost:1337
export TEST_PROJECT_ID="1"                     # Default: 1
```

## Available Tests

### 1.1 Single Feature File Sync (`single-feature`)

**Test File**: `01-single-feature-sync.test.js`

**What it tests**:
- Creates a single `.feature` file with multiple scenarios
- Syncs it to TestCollab using the CLI tool
- Verifies the sync was successful
- Checks that test suites and test cases were created correctly

**Feature file created**:
- `login.feature` with "User Login" feature
- Contains 3 scenarios: successful login, failed login, empty credentials

## Running Tests

### Run All Tests

```bash
cd cli/tests/integration
node run-test.js
```

### Run Specific Test

```bash
cd cli/tests/integration
node run-test.js single-feature
```

### Get Help

```bash
cd cli/tests/integration
node run-test.js --help
```

## Test Output

The tests provide detailed output including:

- ✅ Setup and teardown status
- 📝 Feature file creation details
- 🚀 CLI command execution and output
- 🔍 Result verification (both CLI output and API verification)
- 🧹 Cleanup status

### Example Output

```
🚀 Gherkin Sync Integration Test Runner

🔧 Environment Configuration:
   TESTCOLLAB_URL: http://localhost:1337
   TEST_PROJECT_ID: 1
   TESTCOLLAB_TOKEN: abc12345...

🧪 Running 1 test(s):

============================================================
🔍 Test: single-feature
============================================================
🧪 Running Test: Single Feature File Sync
📍 Base URL: http://localhost:1337
🔑 API Token: abc12345...
📁 Project ID: 1

📁 Setting up test environment...
✅ Test environment ready
📝 Creating test feature file...
✅ Created feature file: /path/to/test-data/single-feature/login.feature
📄 Feature file contains:
   - 1 Feature: User Login
   - 3 Scenarios: Successful login, Failed login, Empty credentials
🚀 Running Gherkin sync...
📋 Command: node "/path/to/tc-gherkin-push.js" --project 1 --dir "/path/to/test-data/single-feature"
📤 Sync output:
Processing feature file: login.feature
Feature: User Login
Successfully uploaded to TestCollab
🔍 Verifying results...
✅ Output verification passed
🌐 Verifying API results...
📊 Found 1 suite(s) in project
✅ Found "User Login" suite with ID: 123
📋 Found 3 test case(s) in suite
✅ Expected number of test cases found
   1. Successful login with valid credentials
   2. Failed login with invalid credentials
   3. Login with empty credentials
🧹 Cleaning up test data...
✅ Test data cleaned up
✅ Test passed!

✅ single-feature: PASSED

============================================================
📊 TEST SUMMARY
============================================================
Total Tests: 1
✅ Passed: 1
❌ Failed: 0
📈 Success Rate: 100%

🎉 All tests passed successfully!
```

## Test Structure

Each test follows this structure:

1. **Setup**: Create test directories and clean up any existing data
2. **Create Test Data**: Generate `.feature` files with specific content
3. **Execute CLI**: Run the `tc-gherkin-push.js` CLI tool
4. **Verify Output**: Check CLI output for success indicators
5. **Verify API**: Make API calls to confirm data was created in TestCollab
6. **Cleanup**: Remove test data and temporary files

## Troubleshooting

### Common Issues

1. **"TESTCOLLAB_TOKEN environment variable is required"**
   - Set the API token: `export TESTCOLLAB_TOKEN="your-token"`

2. **"API call failed: 401"**
   - Check that your API token is valid and has sufficient permissions

3. **"API call failed: 404"**
   - Verify the TestCollab URL is correct and the API is running
   - Check that the project ID exists

4. **"CLI execution failed"**
   - Ensure the CLI tool is working: `node ../../tc-gherkin-push.js --help`
   - Check that all dependencies are installed in the CLI directory

5. **"Could not find suite in API response"**
   - This might be a timing issue or the suite was created with a different name
   - Check the TestCollab UI to see if the data was actually created

### Debug Mode

For more detailed debugging, you can:

1. Run the CLI tool manually to see detailed output:
   ```bash
   export TESTCOLLAB_TOKEN="your-token"
   node ../../tc-gherkin-push.js --project 1 --dir ./test-data/single-feature
   ```

2. Check the TestCollab API directly:
   ```bash
   curl -H "Authorization: Bearer your-token" http://localhost:1337/api/suites?project=1
   ```

## Adding New Tests

To add a new test:

1. Create a new test file: `XX-test-name.test.js`
2. Follow the same class structure as existing tests
3. Add the test to the `availableTests` object in `run-test.js`
4. Update this README with the new test description

## Test Data

Test data is created in `test-data/` subdirectories and automatically cleaned up after each test. The directory structure is:

```
test-data/
├── single-feature/
│   └── login.feature
└── (other test directories)
