"""Parse exported Power BI TMDL semantic models into normalized ``ModelCard`` objects.

A semantic model is a folder ``<name>.SemanticModel`` produced by ``fab export`` with a
``definition/`` tree (``tables/*.tmdl``, ``relationships.tmdl``, ``expressions.tmdl``). We only
extract what the similarity scorer needs: tables, columns (+ type + hidden), measures (+ DAX),
relationships, and the logical/physical data source.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_USAGE_METRICS_RE = re.compile(r"usage\s*metrics", re.IGNORECASE)
_SQL_DATABASE_RE = re.compile(r'Sql\.Database\(\s*"([^"]+)"\s*,\s*"([^"]+)"', re.IGNORECASE)
_ENTITY_RE = re.compile(r"^\s*entityName:\s*(.+?)\s*$")
_SCHEMA_RE = re.compile(r"^\s*schemaName:\s*(.+?)\s*$")


def _tab_indent(line: str) -> int:
    return len(line) - len(line.lstrip("\t"))


def _unquote(name: str) -> str:
    name = name.strip()
    if name.startswith("'") and name.endswith("'") and len(name) >= 2:
        name = name[1:-1]
    return name.strip()


@dataclass
class Measure:
    """A single DAX measure (name + raw expression)."""

    name: str
    dax: str


@dataclass
class Column:
    """A table column with its data type and hidden flag."""

    table: str
    name: str
    data_type: str | None = None
    hidden: bool = False

    @property
    def qualified(self) -> str:
        """Return the ``Table[Column]`` qualified name (lower-cased)."""
        return f"{self.table}[{self.name}]".lower()


@dataclass
class ModelCard:  # pylint: disable=too-many-instance-attributes
    """Normalized, comparable view of one semantic model."""

    name: str
    workspace: str
    path: Path
    tables: list[str] = field(default_factory=list)
    columns: list[Column] = field(default_factory=list)
    measures: list[Measure] = field(default_factory=list)
    relationships: list[tuple[str, str]] = field(default_factory=list)
    source_logical: set[tuple[str, str]] = field(default_factory=set)
    source_physical: set[tuple[str, str]] = field(default_factory=set)
    has_rls: bool = False
    has_calc_groups: bool = False
    system_generated: bool = False

    @property
    def measure_count(self) -> int:
        """Number of measures in the model."""
        return len(self.measures)

    @property
    def table_count(self) -> int:
        """Number of tables in the model."""
        return len(self.tables)

    @property
    def qualified_columns(self) -> set[str]:
        """Set of lower-cased ``table[column]`` names."""
        return {c.qualified for c in self.columns}


def _read_measure(lines: list[str], i: int) -> tuple[Measure, int]:
    """Read one measure starting at line ``i``; return it and the next line index."""
    line = lines[i]
    indent = _tab_indent(line)
    match = re.match(r"^\t+measure\s+(.+?)\s*=\s*(.*)$", line)
    parts: list[str] = []
    if match is None:
        # A blank/placeholder measure declared with no `= expression` on the line (e.g. a
        # freshly-added `measure Medida` that carries only child properties). Real estates contain
        # these, so treat it as an empty measure instead of crashing the whole scan.
        name = _unquote(re.sub(r"^\t+measure\s+", "", line).strip())
        i += 1
    else:
        name = _unquote(match.group(1))
        inline = match.group(2).strip()
        i += 1
        if inline == "```":  # triple-backtick fenced multi-line expression
            while i < len(lines) and lines[i].strip() != "```":
                parts.append(lines[i].strip())
                i += 1
            i += 1  # consume closing fence
        elif inline == "":  # `=` on its own line: DAX continues at a deeper indent
            # The exporter emits a leading whitespace-only line before the body, so a blank line is
            # part of the expression block, not its terminator. Stop only at the first non-blank line
            # shallow enough to be a child property (indent + 1) or a sibling/parent (<= indent).
            while i < len(lines):
                cur = lines[i]
                if cur.strip() == "":
                    i += 1
                    continue
                if _tab_indent(cur) <= indent + 1:
                    break
                parts.append(cur.strip())
                i += 1
        else:  # single-line measure
            parts.append(inline)
    # Skip the measure's child property lines (formatString, displayFolder, kpi, ...).
    while i < len(lines):
        cur = lines[i]
        if cur.strip() == "":
            i += 1
            continue
        if _tab_indent(cur) <= indent:
            break
        i += 1
    return Measure(name=name, dax=" ".join(p for p in parts if p)), i


def _read_column(lines: list[str], i: int, table: str) -> tuple[Column, int]:
    """Read one column starting at line ``i``; return it and the next line index."""
    indent = _tab_indent(lines[i])
    body = lines[i].strip()[len("column") :].strip()
    if body.startswith("'"):
        name = body[1 : body.index("'", 1)]
    else:
        name = body.split("=")[0].strip()
    data_type: str | None = None
    hidden = False
    i += 1
    while i < len(lines):
        cur = lines[i]
        if cur.strip() == "":
            i += 1
            continue
        if _tab_indent(cur) <= indent:
            break
        stripped = cur.strip()
        if stripped.startswith("dataType:"):
            data_type = stripped.split(":", 1)[1].strip()
        elif stripped == "isHidden" or stripped.startswith("isHidden:"):
            hidden = True
        i += 1
    return Column(table=table, name=_unquote(name), data_type=data_type, hidden=hidden), i


def _parse_table_file(path: Path) -> tuple[str | None, list[Column], list[Measure], bool]:
    """Parse one ``tables/*.tmdl`` file into (table_name, columns, measures, is_calc_group)."""
    lines = path.read_text(encoding="utf-8").splitlines()
    table_name: str | None = None
    columns: list[Column] = []
    measures: list[Measure] = []
    is_calc_group = False
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if _tab_indent(line) == 0 and stripped.startswith("table "):
            table_name = _unquote(stripped[len("table ") :])
        elif stripped.startswith("calculationGroup"):
            is_calc_group = True
        elif re.match(r"^\t+measure\s", line):
            measure, i = _read_measure(lines, i)
            measures.append(measure)
            continue
        elif re.match(r"^\t+column\s", line):
            column, i = _read_column(lines, i, table_name or "")
            columns.append(column)
            continue
        i += 1
    return table_name, columns, measures, is_calc_group


def _parse_relationships(path: Path) -> list[tuple[str, str]]:
    """Parse ``relationships.tmdl`` into normalized (fromColumn, toColumn) lower-cased pairs."""
    if not path.exists():
        return []
    rels: list[tuple[str, str]] = []
    from_col: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("fromColumn:"):
            from_col = stripped.split(":", 1)[1].strip().lower()
        elif stripped.startswith("toColumn:") and from_col is not None:
            rels.append((from_col, stripped.split(":", 1)[1].strip().lower()))
            from_col = None
    return rels


def _parse_logical_source(table_files: list[Path]) -> set[tuple[str, str]]:
    """Collect (schema, entity) tuples from Direct Lake / entity partitions across table files."""
    entities: set[tuple[str, str]] = set()
    for path in table_files:
        schema: str | None = None
        entity: str | None = None
        for line in path.read_text(encoding="utf-8").splitlines():
            if (match := _SCHEMA_RE.match(line)) is not None:
                schema = _unquote(match.group(1)).lower()
            elif (match := _ENTITY_RE.match(line)) is not None:
                entity = _unquote(match.group(1)).lower()
        if entity is not None:
            entities.add((schema or "", entity))
    return entities


def _parse_physical_source(definition_dir: Path) -> set[tuple[str, str]]:
    """Collect (endpoint, database) tuples from any ``Sql.Database(...)`` in the definition."""
    physical: set[tuple[str, str]] = set()
    for path in definition_dir.rglob("*.tmdl"):
        for endpoint, database in _SQL_DATABASE_RE.findall(path.read_text(encoding="utf-8")):
            physical.add((endpoint.lower(), database.lower()))
    return physical


def parse_model(model_dir: Path, workspace: str) -> ModelCard:
    """Parse a single ``<name>.SemanticModel`` folder into a :class:`ModelCard`."""
    definition = model_dir / "definition"
    name = model_dir.name.removesuffix(".SemanticModel")
    card = ModelCard(name=name, workspace=workspace, path=model_dir)

    tables_dir = definition / "tables"
    table_files = sorted(tables_dir.glob("*.tmdl")) if tables_dir.exists() else []
    for table_file in table_files:
        table_name, columns, measures, is_calc_group = _parse_table_file(table_file)
        if table_name is None:
            continue
        card.tables.append(table_name)
        card.columns.extend(columns)
        card.measures.extend(measures)
        card.has_calc_groups = card.has_calc_groups or is_calc_group

    card.relationships = _parse_relationships(definition / "relationships.tmdl")
    card.source_logical = _parse_logical_source(table_files)
    card.source_physical = _parse_physical_source(definition) if definition.exists() else set()
    card.has_rls = _has_rls(definition)
    card.system_generated = bool(_USAGE_METRICS_RE.search(name))
    return card


def _has_rls(definition_dir: Path) -> bool:
    """Return True if any role defines a table permission (row-level security)."""
    if not definition_dir.exists():
        return False
    for path in definition_dir.rglob("*.tmdl"):
        if "tablePermission" in path.read_text(encoding="utf-8"):
            return True
    return False


def load_models(models_root: Path, *, keep_empty: bool = False) -> list[ModelCard]:
    """Load every semantic model under ``models_root`` (``<workspace>/<name>.SemanticModel``).

    Models with no tables (default lakehouse/warehouse/staging artifacts) are skipped unless
    ``keep_empty`` is set.
    """
    cards: list[ModelCard] = []
    for model_dir in sorted(models_root.glob("*/*.SemanticModel")):
        card = parse_model(model_dir, workspace=model_dir.parent.name)
        if not card.tables and not keep_empty:
            continue
        cards.append(card)
    return cards
