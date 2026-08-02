"""Adapt clean extracted core modules to ESM.

For modules with no Builder globals, only: strip the extraction header,
prepend the Lazy import where the module references Lazy, and export the
declaration. Mechanical, no retyping.
"""
import pathlib
import re

CORE = pathlib.Path(__file__).resolve().parents[1] / "kanforge" / "core"

# (filename, needs_lazy_import)
CLEAN = [
    ("functor.js", True),
    ("fix.js", True),
    ("lazify.js", True),
    ("stream.js", False),
    ("promise.js", False),
    ("cache.js", True),
    ("serialize.js", False),
]

def strip_header(text):
    lines = text.splitlines(keepends=True)
    # drop leading // comment lines
    while lines and lines[0].lstrip().startswith("//"):
        lines.pop(0)
    # drop stray leading blank lines
    while lines and lines[0].strip() == "":
        lines.pop(0)
    return "".join(lines)

def exportify(text):
    # export class/const at top-level declaration (first occurrence)
    m = re.search(r"^(export\s+)?(class\s+\w+|const\s+\w+\s*=)", text, re.M)
    if not m:
        raise RuntimeError(f"no top-level declaration found in {text[:60]!r}")
    if m.group(1):
        return text
    decl_start = m.start()
    return text[:decl_start] + "export " + text[decl_start:]

for name, needs_lazy in CLEAN:
    p = CORE / name
    text = p.read_text(encoding="utf-8")
    body = exportify(strip_header(text))
    if needs_lazy:
        header = "import { Lazy } from './lazy.js';\n\n"
    else:
        header = ""
    p.write_text(header + body, encoding="utf-8")
    print(f"adapted {name}")
