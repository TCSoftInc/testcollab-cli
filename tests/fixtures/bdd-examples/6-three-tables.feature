Feature: Checkout discount

  Scenario Outline: A discount by cart total
    When the cart total is <total>
    Then the discount is <discount>

    Examples: Small carts
      | total | discount |
      | 50    | 0        |

    @smoke
    Examples: Large carts
      | total | discount |
      | 100   | 10       |
      | 500   | 40       |

    Examples: Huge carts
      | total | discount |
      | 900   | 40       |
