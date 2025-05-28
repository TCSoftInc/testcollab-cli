Feature: Account Settings Management
  As a registered user
  I want to manage my account settings
  So that I can personalize my experience and maintain my information

  Background:
    Given I am logged in as a registered user
    And I am on the account settings page

  Scenario: Update personal information
    When I change my name to "John Doe"
    And I change my phone number to "555-123-4567"
    And I click the save button
    Then I should see a success notification
    And my personal information should be updated in the system

  Scenario: Change password successfully
    When I enter my current password "oldpassword"
    And I enter "newpassword" in the new password field
    And I enter "newpassword" in the confirm password field
    And I click the change password button
    Then I should see a success message "Password changed successfully"
    And I should be able to log in with the new password

  Scenario: Password change failure with incorrect confirmation
    When I enter my current password "oldpassword"
    And I enter "newpassword" in the new password field
    And I enter "different" in the confirm password field
    And I click the change password button
    Then I should see an error message "Passwords do not match"
    And my password should not be changed
