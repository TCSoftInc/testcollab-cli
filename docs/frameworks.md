# Framework Setup Guide

How to generate test result files compatible with `tc report` for each supported framework.

`tc report` accepts two formats:
- **Mochawesome JSON** (`--format mochawesome`)
- **JUnit XML** (`--format junit`)

Your test names must include a TestCollab case ID (e.g., `[TC-123]`, `TC-123`, `id-123`, or `testcase-123`) so results can be matched to test cases. See the [README](../README.md#mapping-test-cases) for all supported patterns.

### Supported frameworks

[Cypress](#cypress) | [Playwright](#playwright) | [Sauce Labs (`saucectl`)](#sauce-labs-saucectl) | [Jest](#jest) | [Pytest](#pytest) | [TestNG](#testng) | [JUnit 4/5](#junit-45) | [Robot Framework](#robot-framework) | [PHPUnit](#phpunit) | [Cucumber.js](#cucumberjs) | [Cucumber JVM](#cucumber-jvm) | [WebDriverIO](#webdriverio) | [TestCafe](#testcafe) | [Newman (Postman)](#newman-postman) | [Behave (Python)](#behave-python) | [Go (`go test`)](#go-go-test) | [Kaspresso / Kotlin](#kaspresso--kotlin)

### JUnit XML example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="My Test Suite">
  <testsuite name="Authentication" tests="3" failures="1" skipped="1">
    <testcase classname="Authentication.Login" name="[TC-123] should login with valid credentials" time="0.12" />
    <testcase classname="Authentication.Login" name="[TC-124] should reject invalid password" time="0.43">
      <failure message="Expected 401 but got 200">AssertionError: expected status 401 but got 200</failure>
    </testcase>
    <testcase classname="Authentication.Login" name="[TC-125] should support SSO login" time="0.07">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
```

### Mochawesome JSON example

```json
{
  "results": [
    {
      "title": "Authentication",
      "tests": [
        {
          "title": "[TC-123] should login with valid credentials",
          "fullTitle": "Authentication [TC-123] should login with valid credentials",
          "state": "passed",
          "pass": true,
          "fail": false
        },
        {
          "title": "[TC-124] should reject invalid password",
          "state": "failed",
          "pass": false,
          "fail": true,
          "err": { "message": "Expected 401 but got 200" }
        },
        {
          "title": "[TC-125] should support SSO login",
          "state": "pending",
          "pass": false,
          "fail": false,
          "pending": true
        }
      ]
    }
  ]
}
```

The key requirement is that each test name contains a TestCollab case ID (e.g., `[TC-123]`). The CLI extracts this ID to match results to the correct test case in your test plan.

### Attaching test artefacts

Screenshots, logs and traces your tests produce can travel with the result, so a failed automated case gives a tester something to look at. Name each file on its own line inside the test's `<system-out>` (JUnit XML only):

```xml
<testcase classname="Authentication.Login" name="[TC-124] should reject invalid password" time="0.43">
  <failure message="Expected 401 but got 200">AssertionError</failure>
  <system-out>
[[ATTACHMENT|test-results/login-failure.png]]
[[ATTACHMENT|test-results/browser.log]]
  </system-out>
</testcase>
```

`tc report` uploads each file and attaches it to that test case's execution. Paths may be absolute, relative to where you run `tc report`, or relative to the `--result-file` directory. Up to 10 files per case, 10 MB each; anything else is warned about and skipped, and `tc report` still exits 0.

**Playwright** writes these markers for you — its JUnit reporter emits an `[[ATTACHMENT|…]]` line for every screenshot, video and trace the test recorded, so no test code changes are needed.

**Any other runner**: print the line to the test's standard output and make sure the JUnit reporter records stdout in `<system-out>`. For example, in JavaScript:

```js
console.log(`[[ATTACHMENT|${screenshotPath}]]`);
```

or in Python:

```python
print(f"[[ATTACHMENT|{screenshot_path}]]")
```

The convention comes from the Jenkins JUnit Attachments plugin and is also read by Azure DevOps, so the same markers work whether or not you report to TestCollab.

All examples below assume you've set the `TESTCOLLAB_TOKEN` environment variable (or pass `--api-key` to each command). See [Authentication](../README.md#authentication).

---

## Cypress

Cypress has native Mochawesome support.

**Install:**

```bash
npm install --save-dev mochawesome mochawesome-merge mochawesome-report-generator
```

**Configure** (`cypress.config.js`):

```js
module.exports = {
  reporter: 'mochawesome',
  reporterOptions: {
    reportDir: 'mochawesome-report',
    overwrite: false,
    html: false,
    json: true
  }
};
```

**Run and upload:**

```bash
npx cypress run
tc report --project 123 --test-plan-id 456 \
  --format mochawesome --result-file ./mochawesome-report/mochawesome.json
```

---

## Playwright

Playwright has a built-in JUnit reporter.

**Run:**

```bash
npx playwright test --reporter=junit
```

This writes to stdout by default. To write to a file, set the `PLAYWRIGHT_JUNIT_OUTPUT_NAME` env var:

```bash
PLAYWRIGHT_JUNIT_OUTPUT_NAME=results.xml npx playwright test --reporter=junit
```

Or configure in `playwright.config.ts`:

```ts
export default {
  reporter: [['junit', { outputFile: 'results.xml' }]]
};
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## Sauce Labs (`saucectl`)

`saucectl` runs your suite on the Sauce Labs grid and writes its own JUnit summary of the whole run — one `<testsuite>` per job, with the browser, the platform and the session URL in that suite's `<properties>`.

**Run:**

```bash
saucectl run --reporters.junit.enabled=true
```

That writes `saucectl-report.xml` in the working directory (`--reporters.junit.filename` changes the name).

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./saucectl-report.xml
```

If the test plan has one configuration per browser, `tc report` matches each `saucectl` suite to its configuration and each browser keeps its own result — see [Configuration-specific runs](../README.md#configuration-specific-runs). The Sauce session URL is stored on each execution, so a failed result links straight back to its video and logs.

`.sauce/config.yml` for the two-browser example:

```yaml
apiVersion: v1alpha
kind: playwright
sauce:
  region: eu-central-1
playwright:
  version: 1.61.1
  configFile: playwright.config.js
rootDir: ./
suites:
  - name: "Chromium Win11"
    platformName: "Windows 11"
    testMatch: [".*.spec.js"]
    params:
      browserName: "chromium"
  - name: "Firefox Win11"
    platformName: "Windows 11"
    testMatch: [".*.spec.js"]
    params:
      browserName: "firefox"
reporters:
  junit:
    enabled: true
```

---

## Jest

Use the `jest-junit` package to generate JUnit XML.

**Install:**

```bash
npm install --save-dev jest-junit
```

**Run:**

```bash
JEST_JUNIT_OUTPUT_DIR=./reports npx jest --reporters=default --reporters=jest-junit
```

Or configure in `package.json`:

```json
{
  "jest": {
    "reporters": [
      "default",
      ["jest-junit", { "outputDirectory": "./reports", "outputName": "results.xml" }]
    ]
  }
}
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./reports/results.xml
```

---

## Pytest

Pytest has built-in JUnit XML output.

**Run:**

```bash
pytest --junitxml=results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## TestNG

TestNG generates JUnit-compatible XML by default.

**Run:**

The default output is at `test-output/junitreports/`. You can also configure the output in your `testng.xml` or build tool.

**Maven example:**

```bash
mvn test
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./test-output/junitreports/TEST-TestSuite.xml
```

---

## JUnit 4/5

JUnit is the native source of the XML format — no extra setup needed.

**Maven:**

```bash
mvn test
# Results at target/surefire-reports/
```

**Gradle:**

```bash
gradle test
# Results at build/test-results/test/
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./target/surefire-reports/TEST-com.example.MyTest.xml
```

---

## Robot Framework

Use the `--xunit` flag to generate JUnit-compatible XML.

**Run:**

```bash
robot --xunit results.xml tests/
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## PHPUnit

PHPUnit has built-in JUnit XML logging.

**Run:**

```bash
phpunit --log-junit results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## Cucumber.js

Use a JUnit formatter plugin.

**Install:**

```bash
npm install --save-dev cucumber-junit
```

**Run:**

```bash
npx cucumber-js --format json:./reports/cucumber.json
npx cucumber-junit < ./reports/cucumber.json > ./reports/results.xml
```

Or use `cucumber-junit-formatter` directly:

```bash
npm install --save-dev @cucumber/junit-xml-formatter
npx cucumber-js --format @cucumber/junit-xml-formatter:./reports/results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./reports/results.xml
```

---

## Cucumber JVM

Cucumber JVM has a built-in JUnit XML plugin.

**Configure** (in `@CucumberOptions` or `cucumber.properties`):

```java
@CucumberOptions(plugin = {"junit:target/cucumber-reports/results.xml"})
```

Or in `cucumber.properties`:

```
cucumber.plugin=junit:target/cucumber-reports/results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./target/cucumber-reports/results.xml
```

---

## WebDriverIO

Use the `@wdio/junit-reporter` package.

**Install:**

```bash
npm install --save-dev @wdio/junit-reporter
```

**Configure** (`wdio.conf.js`):

```js
exports.config = {
  reporters: [
    ['junit', {
      outputDir: './reports',
      outputFileFormat: () => 'results.xml'
    }]
  ]
};
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./reports/results.xml
```

---

## TestCafe

Use the `testcafe-reporter-junit` package.

**Install:**

```bash
npm install --save-dev testcafe-reporter-junit
```

**Run:**

```bash
npx testcafe chrome tests/ --reporter junit:results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## Newman (Postman)

Use the `newman-reporter-junit` package.

**Install:**

```bash
npm install --save-dev newman-reporter-junit
```

**Run:**

```bash
npx newman run collection.json --reporters cli,junit --reporter-junit-export results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## Behave (Python)

Behave has built-in JUnit output.

**Run:**

```bash
behave --junit --junit-directory ./reports
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./reports/TESTS-features.xml
```

---

## Go (`go test`)

Use `go-junit-report` to convert Go test output to JUnit XML.

**Install:**

```bash
go install github.com/jstemmer/go-junit-report/v2@latest
```

**Run:**

```bash
go test ./... -v 2>&1 | go-junit-report > results.xml
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
```

---

## Kaspresso / Kotlin

Kaspresso and Kotlin test frameworks inherit from the JUnit runner, so they produce JUnit XML natively.

**Run (Gradle):**

```bash
./gradlew connectedAndroidTest
# Results at app/build/outputs/androidTest-results/
```

**Upload:**

```bash
tc report --project 123 --test-plan-id 456 \
  --format junit --result-file ./app/build/outputs/androidTest-results/TEST-results.xml
```
