"""Extract module blocks from scripts/builder.js by line range.

Writes each block to kanforge/_extracted/<name>.src.js with an ESM export header.
These are FAITHFUL slices (no retyping). Subsequent hand-editing strips the
Builder globals (pullGraph, traceOrchestrator, CONFIG, HMAC_KEY) and converts
to clean ESM. Line refs from docs/blueprint.md §3.
"""
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
SRC = REPO / "scripts" / "builder.js"
OUT = REPO / "kanforge" / "_extracted"

# (module name, start line (1-indexed, inclusive), end line (exclusive))
MODULES = [
    ("lazy", 79, 155),
    ("lazy_template", 158, 192),
    ("lazy_functor", 195, 220),
    ("pipeline", 222, 278),
    ("config_context", 281, 321),
    ("lazy_stream", 324, 439),
    ("lazify", 444, 472),
    ("fix", 475, 478),
    ("pull_graph", 481, 786),
    ("pull_promise", 789, 818),
    ("pull_cache", 821, 837),
    ("state_serializer", 1250, 1266),
    ("hasher", 4211, 4329),
]

def main():
    text = SRC.read_text(encoding="utf-8").splitlines(keepends=True)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, start, end in MODULES:
        block = "".join(text[start - 1:end])  # end is inclusive (the module's closing line)
        header = (
            f"// Source: scripts/builder.js:{start}-{end} (extracted by tools/extract_modules.py)\n"
            f"// TODO: strip Builder globals (pullGraph, traceOrchestrator, CONFIG, HMAC_KEY), "
            f"convert to ESM exports.\n\n"
        )
        (OUT / f"{name}.src.js").write_text(header + block, encoding="utf-8")
        lines = block.count("\n")
        print(f"{name}: lines {start}-{end-1} ({lines} lines) -> _extracted/{name}.src.js")

if __name__ == "__main__":
    main()
