# Framework Setup Guide

How to generate test result files compatible with `tc report` for each supported framework.

`tc report` accepts two formats:
- **Mochawesome JSON** (`--format mochawesome`)
- **JUnit XML** (`--format junit`)

Your test names must include a TestCollab case ID (e.g., `[TC-123]`, `TC-123`, `id-123`, or `testcase-123`) so results can be matched to test cases. See the [README](../README.md#mapping-test-cases) for all supported patterns.

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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
  --format junit --result-file ./results.xml
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
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
tc report --api-key $TOKEN --project 123 --test-plan-id 456 \
  --format junit --result-file ./app/build/outputs/androidTest-results/TEST-results.xml
```
