"""A small QR code encoder (byte mode, error correction level M, versions 1-6), as SVG.

Enough for a LAN address of up to 106 bytes, which is all the "view on phone" link needs.
Follows the QR specification (ISO/IEC 18004); module placement and format bits match the
well-known reference implementation by Project Nayuki.
"""

from typing import List

# Version: (data codewords per block, number of blocks, EC codewords per block) for level M.
_BLOCKS_M = {1: (16, 1, 10), 2: (28, 1, 16), 3: (44, 1, 26), 4: (32, 2, 18), 5: (43, 2, 24), 6: (27, 4, 16)}
_ALIGNMENT = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]}
_FORMAT_M = 0  # the two format bits for level M


def _gf_tables():
    exp, log = [0] * 512, [0] * 256
    x = 1
    for i in range(255):
        exp[i], log[x] = x, i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


_EXP, _LOG = _gf_tables()


def _mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def reed_solomon(data: List[int], ec_count: int) -> List[int]:
    """Error correction codewords for ``data`` (generator with roots 2^0 .. 2^(ec_count-1))."""
    gen = [1]
    for i in range(ec_count):
        gen = [a ^ _mul(b, _EXP[i]) for a, b in zip(gen + [0], [0] + gen)]
    rem = [0] * ec_count
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        for i in range(ec_count):
            rem[i] ^= _mul(gen[i + 1], factor)
    return rem


def format_bits(mask: int) -> int:
    """The 15 format bits for level M with ``mask``, BCH-coded and XOR-masked."""
    data = _FORMAT_M << 3 | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    return (data << 10 | rem) ^ 0x5412


def _codewords(text: bytes, version: int) -> List[int]:
    per_block, blocks, ec = _BLOCKS_M[version]
    capacity = per_block * blocks
    bits = [0, 1, 0, 0] + [int(b) for b in f"{len(text):08b}"]
    for byte in text:
        bits += [int(b) for b in f"{byte:08b}"]
    bits += [0] * min(4, capacity * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    data = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(data) < capacity:
        data.append(pad)
        pad ^= 0xEC ^ 0x11
    chunks = [data[i * per_block:(i + 1) * per_block] for i in range(blocks)]
    ecs = [reed_solomon(chunk, ec) for chunk in chunks]
    return [c[i] for i in range(per_block) for c in chunks] + [e[i] for i in range(ec) for e in ecs]


_MASKS = [
    lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0,
    lambda x, y: (x + y) % 3 == 0, lambda x, y: (x // 3 + y // 2) % 2 == 0,
    lambda x, y: x * y % 2 + x * y % 3 == 0, lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
]


class _Matrix:
    def __init__(self, version: int):
        self.size = 17 + 4 * version
        self.dark = [[False] * self.size for _ in range(self.size)]
        self.fixed = [[False] * self.size for _ in range(self.size)]
        self._function_patterns(version)

    def set(self, x: int, y: int, dark: bool) -> None:
        self.dark[y][x], self.fixed[y][x] = dark, True

    def _function_patterns(self, version: int) -> None:
        n = self.size
        for i in range(n):
            self.set(6, i, i % 2 == 0)
            self.set(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (n - 4, 3), (3, n - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < n and 0 <= y < n:
                        dist = max(abs(dx), abs(dy))
                        self.set(x, y, dist not in (2, 4))
        positions = _ALIGNMENT[version]
        for cy in positions:
            for cx in positions:
                if (cx, cy) in ((6, 6), (6, n - 7), (n - 7, 6)):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)
        self.draw_format(0)  # reserves the format areas; redrawn with the chosen mask

    def draw_format(self, mask: int) -> None:
        bits = format_bits(mask)
        bit = lambda i: (bits >> i) & 1 == 1  # noqa: E731
        n = self.size
        for i in range(6):
            self.set(8, i, bit(i))
        self.set(8, 7, bit(6))
        self.set(8, 8, bit(7))
        self.set(7, 8, bit(8))
        for i in range(9, 15):
            self.set(14 - i, 8, bit(i))
        for i in range(8):
            self.set(n - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.set(8, n - 15 + i, bit(i))
        self.set(8, n - 8, True)  # the dark module

    def place(self, codewords: List[int]) -> None:
        n, i = self.size, 0
        total = len(codewords) * 8
        right = n - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(n):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = n - 1 - vert if upward else vert
                    if not self.fixed[y][x] and i < total:
                        self.dark[y][x] = (codewords[i >> 3] >> (7 - (i & 7))) & 1 == 1
                        i += 1
            right -= 2

    def masked(self, mask: int) -> List[List[bool]]:
        test = _MASKS[mask]
        return [[self.dark[y][x] ^ (not self.fixed[y][x] and test(x, y)) for x in range(self.size)]
                for y in range(self.size)]


def _penalty(grid: List[List[bool]]) -> int:
    """Rules 1, 2 and 4 of the mask evaluation (runs, 2x2 blocks, dark/light balance)."""
    n, score = len(grid), 0
    for lines in (grid, [list(col) for col in zip(*grid)]):
        for line in lines:
            run = 1
            for a, b in zip(line, line[1:]):
                if a == b:
                    run += 1
                else:
                    score += run - 2 if run >= 5 else 0
                    run = 1
            score += run - 2 if run >= 5 else 0
    for y in range(n - 1):
        for x in range(n - 1):
            if grid[y][x] == grid[y][x + 1] == grid[y + 1][x] == grid[y + 1][x + 1]:
                score += 3
    dark = sum(map(sum, grid))
    score += abs(dark * 20 - n * n * 10) // (n * n) * 10
    return score


def encode(text: str) -> List[List[bool]]:
    """The QR matrix (True = dark) for ``text``, choosing the smallest version and best mask."""
    data = text.encode("utf-8")
    for version, (per_block, blocks, _ec) in _BLOCKS_M.items():
        if len(data) + 2 <= per_block * blocks:
            break
    else:
        raise ValueError("QR にするには長すぎます")
    matrix = _Matrix(version)
    matrix.place(_codewords(data, version))
    best = None
    for mask in range(8):
        matrix.draw_format(mask)
        grid = matrix.masked(mask)
        score = _penalty(grid)
        if best is None or score < best[0]:
            best = (score, mask, grid)
    matrix.draw_format(best[1])
    return matrix.masked(best[1])


def svg(text: str, scale: int = 6, border: int = 4) -> str:
    grid = encode(text)
    size = (len(grid) + 2 * border) * scale
    rects = "".join(f'<rect x="{(x + border) * scale}" y="{(y + border) * scale}" width="{scale}" height="{scale}"/>'
                    for y, row in enumerate(grid) for x, dark in enumerate(row) if dark)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
            f'<rect width="100%" height="100%" fill="#fff"/><g fill="#000">{rects}</g></svg>')
