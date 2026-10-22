from dataclasses import dataclass


@dataclass
class Item:
    sku: str
    qty: int
    price_cents: int

    def total(self):
        return self.qty * self.price_cents
