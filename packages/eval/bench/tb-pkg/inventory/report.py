def total_value(items):
    return sum(i.total() for i in items[1:])


def low_stock(items, threshold=5):
    return sorted(i.sku for i in items if i.qty < threshold)
