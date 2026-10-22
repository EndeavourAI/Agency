import random

# 300,000 lines in the common log format; one address has about twice the 500s of any other.
random.seed(7)
ips = ["10.0.0.%d" % i for i in range(1, 200)]
with open("access.log", "w") as f:
    for n in range(300000):
        ip = "10.0.0.77" if n % 97 == 0 else random.choice(ips)
        code = random.choice([200, 200, 200, 404, 500])
        f.write('%s - - [19/Oct/2026:10:%02d:%02d +0000] "GET /p%d HTTP/1.1" %d 512\n' % (ip, n // 3600 % 60, n % 60, n % 50, code))
