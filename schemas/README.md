The canonical draft 2020-12 schemas are packaged in [`iadkit/schemas`](../iadkit/schemas/).
Use `project.schema.json` for authoring configuration, the entity schemas for
category files, and `model.schema.json` for generated models. A category file may
contain one entity or an array; the entity schema validates each array member.

The dependency-free CLI enforces the subset of JSON Schema keywords used by
these bundled schemas. It rejects unsupported schema keywords explicitly; it is
not a general JSON Schema library and never downloads schema references.
