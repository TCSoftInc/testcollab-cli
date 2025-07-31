import * as gherkin from '@cucumber/gherkin';

const content = `Feature: User Login
  As a registered user
  I want to log in to the system
  So that I can access my account

  Background:
    Given the application is running
    And I am on the login page

  Scenario: Successful login with valid credentials
    When I enter "valid@example.com" in the email field
    And I enter "correctpassword" in the password field
    And I click the login button
    Then I should be redirected to the dashboard
    And I should see a welcome message

  Scenario: Failed login with incorrect password
    When I enter "valid@example.com" in the email field
    And I enter "wrongpassword" in the password field
    And I click the login button
    Then I should see an error message
    And I should remain on the login page`;

console.log('Testing generateMessages...');

try {
  // Try using Parser directly
  console.log('Trying Parser class...');
  const parser = new gherkin.Parser(new gherkin.AstBuilder(), new gherkin.GherkinClassicTokenMatcher());
  const gherkinDocument = parser.parse(content);
  
  if (gherkinDocument) {
    console.log('Parser succeeded!');
    console.log('Feature:', gherkinDocument.feature?.name);
    if (gherkinDocument.feature) {
      console.log('Children count:', gherkinDocument.feature.children?.length);
      gherkinDocument.feature.children?.forEach((child, idx) => {
        console.log(`  Child ${idx}:`, Object.keys(child));
        if (child.scenario) {
          console.log(`    Scenario: ${child.scenario.name} (${child.scenario.steps?.length} steps)`);
        }
        if (child.background) {
          console.log(`    Background: ${child.background.steps?.length} steps`);
        }
      });
    }
  } else {
    console.log('Parser returned null');
  }
  
  console.log('\nTrying generateMessages...');
  const messages = gherkin.generateMessages(content, 'temp.feature', 'text/x.cucumber.gherkin+plain', {});
  console.log('Messages length:', messages.length);
  
} catch (error) {
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
}
