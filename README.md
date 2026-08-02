# Builder

Lazy-evaluation build system for mathematical documents with pull-based dependency tracking.

## Output

Documents:
- **HCT Primer** (157KB): Systematic introduction to higher category theory foundations
- **HCT Working** (160KB): Applications and concrete examples

Each document generates HTML, PDF, and Markdown. View at the [index portal](https://j0pari.github.io/Builder/output/).

## Usage

### Running the Builder

```bash
node scripts/builder.js  # Builds documents and enters watch mode
node scripts/query.js    # Optional: query interface for build metrics
```

The query system provides two interfaces:
- Web GUI at `http://localhost:3000` (opens automatically)
- CLI commands via TCP on port 9876

**Features:**
- Converts source text files to HTML, PDF, and Markdown
- Renders LaTeX mathematics using KaTeX
- Generates PDFs via Puppeteer (headless Chrome)
- Creates an index portal with file metadata
- Watches for changes and rebuilds incrementally

**Implementation:**
- Lazy evaluation: computation deferred until pulled
- Pull-based dependency graph
- Event tracing with timestamps
- Format pipeline: text → HTML → PDF → Markdown
- Files and dependencies defined in CONFIG

## License

MIT License - See LICENSE file for details.