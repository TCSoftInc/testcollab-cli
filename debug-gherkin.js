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
    And I should see a welcome message`;

try {
  console.log('Testing Gherkin parser...');
  console.log('Gherkin exports:', Object.keys(gherkin));
  
  // Try using generateMessages to get the AST  
  const sourceEnvelope = gherkin.makeSourceEnvelope(content, 'test.feature');
  console.log('Source envelope created');
  console.log('Source envelope:', JSON.stringify(sourceEnvelope, null, 2));
  
  const messages = gherkin.generateMessages(sourceEnvelope.source.data, sourceEnvelope.source.uri, sourceEnvelope.source.mediaType, {});
  console.log('Messages generated:', messages.length);
  
  for (const message of messages) {
    if (message.gherkinDocument) {
      console.log('Found Gherkin Document!');
      console.log('Feature name:', message.gherkinDocument.feature?.name);
      console.log('Children count:', message.gherkinDocument.feature?.children?.length);
      
      const feature = message.gherkinDocument.feature;
      if (feature) {
        console.log('\nFeature children:');
        feature.children?.forEach((child, i) => {
          console.log(`  ${i}: ${Object.keys(child)[0]}`);
          if (child.scenario) {
            console.log(`    Scenario: ${child.scenario.name}`);
            console.log(`    Steps: ${child.scenario.steps?.length}`);
          }
          if (child.background) {
            console.log(`    Background: ${child.background.steps?.length} steps`);
          }
        });
      }
    }
  }
} catch (error) {
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
}
