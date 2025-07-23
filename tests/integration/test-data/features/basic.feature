Feature: Basic Feature File Sync

  Scenario: First Scenario
    Given a user is on the login page
    When the user enters valid credentials
    Then the user should be redirected to the dashboard

  Scenario: Second Scenario
    Given a user is on the dashboard
    When the user clicks on the "Create New" button
    Then a new item should be created
