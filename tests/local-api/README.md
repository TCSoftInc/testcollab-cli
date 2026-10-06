# Local API verification

`report-custom-fields.cjs` runs the actual CLI against the sibling `tc-api`
checkout, using its test harness and a local MySQL database. Run the harness
with Node 10 and point `TC_CLI_NODE` at Node 22:

```bash
TC_CLI_NODE=/path/to/node22 /path/to/node10 tests/local-api/report-custom-fields.cjs
```

The harness resets the disposable `tc_cli_custom_fields_test` database and its
template, loads the backend's fixtures, and serves the API on a random loopback
port. Backend external services use the test harness's fakes and network guard.

The script checks text, textarea, editor, number, date, URL, user, dropdown,
multiple-select, and configuration dropdown fields through both JUnit and
Mochawesome uploads. It verifies creation, changes to every type, preservation
during a partial update, optional clearing, and required-field rejection. Values
and display labels are checked through the API and the database's custom-field
rows; execution statuses confirm the results were uploaded too.
