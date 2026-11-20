#!/usr/bin/env python3
"""Print the screen point of an app tile's overflow (3-dot) button.

RESPECT renders each tile in the Apps grid as (AppLauncherScreen.kt):

    Column(clickable -> open the app)
      Box   -> app icon
      IconButton(Icon(MoreVert, contentDescription = ""))   <-- NO id, NO label
      Text(tile title)

so no Maestro selector can address that button: it is an unlabelled clickable
node, and `pm clear` cannot help either because RESPECT persists the apps added
to a school on its own server (only this menu's "Remove" un-adds one).

Instead of hard-coding a percentage of the screen, this helper derives the point
from the accessibility tree, which is what the driver dumps immediately before:

  1. find the node whose text is the tile title;
  2. walk up to the enclosing clickable node - that is the tile;
  3. take the smallest clickable node INSIDE that tile, excluding the tile
     itself. The only one is the overflow button.

usage: tile_overflow_point.py <uiautomator-dump.xml> <tile-title>

exit 0 + prints "x y"  -> point found
exit 2                 -> the tile (or its overflow) is not on screen
exit 1                 -> bad input
"""
import sys

import xml.etree.ElementTree as ET

MISSING = 2


def bounds(node):
    """Return (x1, y1, x2, y2) for a node, or None if it has no usable bounds."""
    raw = node.attrib.get("bounds", "")
    try:
        (x1, y1), (x2, y2) = [
            tuple(int(v) for v in part.strip("[]").split(","))
            for part in raw.split("][")
        ]
    except Exception:
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-4], file=sys.stderr)
        return 1

    dump_path, title = argv[1], argv[2]
    try:
        root = ET.parse(dump_path).getroot()
    except Exception as err:  # noqa: BLE001 - report any parse failure to the caller
        print(f"could not parse {dump_path}: {err}", file=sys.stderr)
        return 1

    parent = {child: par for par in root.iter() for child in par}

    title_node = next(
        (n for n in root.iter() if n.attrib.get("text", "") == title and bounds(n)),
        None,
    )
    if title_node is None:
        print(f"tile {title!r} is not on screen", file=sys.stderr)
        return MISSING

    tile = title_node
    while tile.attrib.get("clickable") != "true" and tile in parent:
        tile = parent[tile]
    if tile.attrib.get("clickable") != "true" or tile is title_node:
        print(f"no clickable tile around {title!r}", file=sys.stderr)
        return MISSING

    inner = [
        n
        for n in tile.iter()
        if n is not tile and n.attrib.get("clickable") == "true" and bounds(n)
    ]
    if not inner:
        print(
            f"tile {title!r} has no overflow button (not a school admin?)",
            file=sys.stderr,
        )
        return MISSING

    def area(node):
        x1, y1, x2, y2 = bounds(node)
        return (x2 - x1) * (y2 - y1)

    x1, y1, x2, y2 = bounds(min(inner, key=area))
    print((x1 + x2) // 2, (y1 + y2) // 2)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
