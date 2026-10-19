import unittest

from inventory.io import load
from inventory.report import low_stock, total_value

DATA = "# sku,qty,price\nA1, 3, 1.10\nB2, 10, 0.29\nC3, 5, 2.00\n"


class T(unittest.TestCase):
    def test_load(self):
        self.assertEqual([i.sku for i in load(DATA)], ["A1", "B2", "C3"])

    def test_price(self):
        self.assertEqual(load(DATA)[1].price_cents, 29)

    def test_total(self):
        self.assertEqual(total_value(load(DATA)), 330 + 290 + 1000)

    def test_low(self):
        self.assertEqual(low_stock(load(DATA)), ["A1"])


if __name__ == "__main__":
    unittest.main()
