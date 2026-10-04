Feature: Checkout discount

  Scenario: An empty cart has no discount
    When the cart total is 0
    Then the discount is 0

  Scenario Outline: A discount by cart total
    When the cart total is <total>
    Then the discount is <discount>

    Examples: Small carts
      | total | discount |
      | 50    | 0        |
      | 99    | 0        |

    @smoke
    Examples: Large carts
      | total | discount |
      | 100   | 10       |
      | 500   | 40       |

  Scenario Outline: Coupon <code> gives <percent> percent
    When the coupon is "<code>"
    Then the coupon discount is <percent>

    Examples:
      | code   | percent |
      | SAVE10 | 10      |
      | SAVE20 | 20      |
