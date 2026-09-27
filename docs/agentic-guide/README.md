# Agentic capabilities guide

A detailed source-grounded reference for OpenHarness at commit
`30b7f628261bf5516c3b3e55871baeb3c80b3973` (27 September 2026).

- [PDF](OpenHarness-Agentic-Capabilities.pdf): typeset reference with contents,
  page numbers, bookmarks, tables, diagrams and source links.
- [Word document](OpenHarness-Agentic-Capabilities.docx): editable version with
  heading navigation, tables, diagrams and source links.
- [Markdown source](guide.md): content shared by both editions.

The guide covers the feature inventory, agent loops and budgets, four built-in
patterns, graph compositions, runtime and API delegation, memory and experiment
storage, human intervention, safety, recovery, scaling, device/fleet orchestration,
API capabilities and implementation limits. It does not change runtime behavior.

## Rebuild

All build inputs and pinned Python dependencies are in this directory. The
isolated one-off container below only mounts this checkout and does not connect
to the application stack or reuse service volumes. Run from the repository root:

```sh
mkdir -p data/agentic-guide-build
docker run --rm -v "$PWD:/work" -w /work python:3.12-slim \
  python -m venv data/agentic-guide-build/venv
docker run --rm -v "$PWD:/work" -w /work python:3.12-slim \
  data/agentic-guide-build/venv/bin/pip install -r docs/agentic-guide/requirements.txt
docker run --rm -v "$PWD:/work" -w /work python:3.12-slim \
  data/agentic-guide-build/venv/bin/python docs/agentic-guide/build.py
```

Python 3.12 with the same requirements installed locally also works. PDF text,
bookmarks and source references can be inspected with PyMuPDF, which is included
in the document dependencies. Temporary diagram renders live under ignored
`data/agentic-guide-build/`. No application credentials are required.

When updating the guide, change the reviewed revision/date, source links and
claims together, then regenerate and visually inspect both the source content
and representative PDF pages. This is a point-in-time reference, not an
automatically synchronized API specification.
