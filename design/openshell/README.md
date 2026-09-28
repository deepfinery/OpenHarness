# OpenShell integration design

The reviewable source is `design.md`. The generated PDF is
`../OpenHarness-OpenShell-Integration.pdf`. Diagrams are vector drawings generated
by `build.py`; they do not require an image service or external assets.

From the repository root, using Python 3.12 with venv support:

```sh
python3 -m venv data/openshell-design-venv
data/openshell-design-venv/bin/pip install -r design/openshell/requirements.txt
data/openshell-design-venv/bin/python design/openshell/build.py
```

The build is offline after dependency installation and uses only repository
inputs and fonts bundled with ReportLab. It checks page count and text bounds,
then writes review images to the ignored `data/openshell-design-review/` folder.
The document is a proposal for implementation issue #67, not implementation
evidence. Documentation work is tracked by #87.
