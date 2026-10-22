from .models import Item


def parse_line(line):
    sku, qty, price = line.split(",")
    return Item(sku.strip(), int(qty), int(float(price) * 100))


def load(text):
    return [parse_line(l) for l in text.splitlines() if l.strip() and not l.startswith("#")]
