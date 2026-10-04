/** TCV-7070: Cucumber JUnit failures must not expose CDATA wrappers. */
import { parseJUnitReport } from '../src/commands/report.js';

describe('parseJUnitReport Cucumber failure text (TCV-7070)', () => {
  test('unwraps CDATA, decodes escaped XML, and preserves literal CDATA entities', () => {
    const xml = `<testsuite name="Cucumber failures">
      <testcase classname="Feature A" name="[TC-1] CDATA only">
        <failure><![CDATA[Error: one &amp; two]]></failure>
      </testcase>
      <testcase classname="Feature A" name="[TC-2] escaped only">
        <failure>Error: one &lt; two &amp;&amp; three &gt; two</failure>
      </testcase>
      <testcase classname="Feature A" name="[TC-3] mixed content">
        <error>Before &lt; <![CDATA[literal &amp; text]]> after &gt;</error>
      </testcase>
    </testsuite>`;

    const records = parseJUnitReport(xml).resultsToUpload['0'];

    expect(records.map(record => record.errDetails)).toEqual([
      'Error: one &amp; two',
      'Error: one < two && three > two',
      'Before < literal &amp; text after >'
    ]);
  });
});
