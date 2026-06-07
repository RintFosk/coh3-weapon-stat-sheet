import json
from collections import Counter
from pathlib import Path


def main() -> None:
    path = Path("weapon.json")
    data = json.loads(path.read_text(encoding="utf-8"))

    weapon_rows = []
    bag_key_counts = Counter()
    leaf_counts = Counter()
    sample_values = {}
    section_leaf_counts = Counter()

    def walk_leaf(node, current_path):
        if isinstance(node, dict):
            for key, value in node.items():
                walk_leaf(value, current_path + [key])
            return
        if isinstance(node, list):
            key = ".".join(current_path) + "[]"
            leaf_counts[key] += 1
            if key not in sample_values and node:
                sample_values[key] = repr(node[0])[:120]
            return

        key = ".".join(current_path)
        leaf_counts[key] += 1
        section_leaf_counts[current_path[0] if current_path else "(root)"] += 1
        if key not in sample_values:
            sample_values[key] = repr(node)[:120]

    def walk(node, path_segments):
        if isinstance(node, dict):
            if "weapon_bag" in node and isinstance(node["weapon_bag"], dict):
                bag = node["weapon_bag"]
                weapon_rows.append((path_segments, bag))
                for key in bag:
                    bag_key_counts[key] += 1
                walk_leaf(bag, [])

            for key, value in node.items():
                walk(value, path_segments + [key])
            return

        if isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, path_segments + [str(i)])

    walk(data, [])

    print(f"WEAPON_ROWS\t{len(weapon_rows)}")
    print(f"TOP_LEVEL_FACTIONS\t{','.join(sorted(data.keys()))}")
    print(f"UNIQUE_BAG_SECTIONS\t{len(bag_key_counts)}")

    print("TOP_BAG_SECTIONS_BEGIN")
    for key, count in bag_key_counts.most_common():
        print(f"{key}\t{count}")
    print("TOP_BAG_SECTIONS_END")

    print(f"UNIQUE_LEAF_PATHS\t{len(leaf_counts)}")
    print("SECTION_LEAF_COUNTS_BEGIN")
    for key, count in section_leaf_counts.most_common():
        print(f"{key}\t{count}")
    print("SECTION_LEAF_COUNTS_END")

    print("OPTIONAL_LEAF_PATHS_BEGIN")
    for key, count in sorted(leaf_counts.items(), key=lambda item: item[1]):
        if count < len(weapon_rows):
            print(f"{key}\t{count}\t{sample_values.get(key, '')}")
    print("OPTIONAL_LEAF_PATHS_END")

    print("TOP_LEAF_PATHS_BEGIN")
    for key, count in leaf_counts.most_common():
        sample = sample_values.get(key, "")
        print(f"{key}\t{count}\t{sample}")
    print("TOP_LEAF_PATHS_END")


if __name__ == "__main__":
    main()
