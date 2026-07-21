# SnowSQL Grammar → DDL-Complete → JSON (Rego / Aspis) → Terraform — Expansion Plan

_Branch: `claude/grammar-ddl-parsing-expansion-l5h07z`_

This document (1) assesses the current state of the grammar on the `updates`
branch, and (2) lays out a phased plan to make it parse **any Snowflake DDL**,
emit a **stable JSON IR** that Rego/OPA policies (Aspis) can evaluate, and be
**compiled to Terraform**.

---

## 1. Current state assessment

The current branch is byte-identical to `updates` (`git rev-list --count
updates...HEAD` = 0). The grammar is `src/snowsql.grammar` (~4,100 lines) plus a
keyword tokenizer in `src/tokens.js`. Build: `lezer-generator` → rollup;
tests are golden parse-tree files under `test/*.txt` run via `mocha`.

### 1.1 What is genuinely good

The grammar has surprisingly broad **statement coverage** with real structure:

- **DML / queries**: `SELECT` (joins, CTEs, window funcs, set ops, sampling,
  `QUALIFY`, `CONNECT BY`, `GROUP BY ROLLUP/CUBE/GROUPING SETS`), `INSERT`
  (single + multi-table), `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`.
- **Transactions / session**: `BEGIN`, `COMMIT`, `ROLLBACK`, `USE`, `SET`,
  `UNSET`, `CALL`, `COMMENT`, `EXECUTE`, `EXPLAIN`.
- **Data movement**: `COPY INTO`, `COPY FILES`, `GET`, `PUT`, `LIST`,
  `REMOVE`, plus stage/URL identifiers and file-format option blocks
  (CSV/JSON/AVRO/ORC/PARQUET/XML).
- **DDL with dedicated rules**: `CREATE` for Account, Database, Schema, Table,
  View, Materialized View, Stream, Task, Pipe, Function, Procedure, Role,
  Share, Sequence, Resource Monitor, Row Access Policy, Masking Policy,
  Network Policy, Integration, Managed Account. `DROP`, `DESCRIBE`, `SHOW`,
  `UNDROP`, `GRANT`/`REVOKE` (role, privileges, database/application/service
  roles) with categorized object-type lists.
- A reasonable **type system** (`Types`, numeric/precision, timestamps,
  interval, variant/array/object) and a full **scalar-expression** grammar.

This is a strong syntactic skeleton — well beyond a toy grammar.

### 1.2 Critical defects (blockers today)

1. **It does not build.** `lezer-generator` aborts with
   `Duplicate definition of rule 'Network'` — `Network` appears in **both** the
   `@external specialize` list (line ~4064) and the `@external extend` list
   (line ~4087). Because `package.json`'s `prepare` script runs the build,
   even `npm install` fails. **The published parser cannot currently be
   regenerated from source.**

2. **Even with that fixed, parser generation does not terminate in practical
   time.** After removing the duplicate, `lezer-generator` ran for **>9
   minutes without producing `parser.js`**. The cause is
   **`GenericCommandTail`** (`GenericCommandAtom+`, where an atom is "almost any
   token, including nested `( … )` / `[ … ]`"). It is referenced from ~13 sites
   (`AlterStmt` actions, `CreateGenericClause`, `ShowQualifier`, `EXECUTE`,
   `COPY FILES`, grant/revoke `CALLER`). A rule that matches arbitrary token
   soup is ambiguous against essentially every other rule and against itself,
   which explodes the LR automaton. This is the single most important thing to
   fix.

3. **Stale/duplicate keyword maps.** `tokens.js` has typo keys
   (`bernoulii`, `datetieme`, `extact`, `precsion`, `undbounded`,
   `initiallly`) and duplicate keys (`group`, `values`, `immediate`,
   `restrictions`) — so some keywords silently never tokenize.

4. **Many dedicated rules are too loose for a semantic JSON.**
   - `CreateTableStmt` uses `CTP` = `(Identifier Identifier … )*` — columns,
     types, and constraints are undifferentiated `Identifier` tokens, not
     named nodes. (Meanwhile a much better `ColumnDef` rule exists but is only
     wired into `ALTER TABLE ADD COLUMN`.)
   - `CREATE DATABASE/SCHEMA` bind the name as a raw `Identifier`, not
     `ObjName`, losing `db.schema.object` qualification.
   - Option clauses are frequently `Key Eql Identifier` with the value as an
     opaque `Identifier` rather than a typed literal.

### 1.3 The deeper gap for the stated goal

**Lezer emits a Concrete Syntax Tree (CST), not JSON.** Nothing in the repo
turns a parse into the structured JSON that Rego needs. Two things are missing:

- an **AST/IR builder** that walks the lezer tree and produces normalized JSON;
- a **stable, documented JSON contract** (schema) that is the interface to both
  Rego (Aspis) and the Terraform emitter.

And the "**any DDL**" ambition collides with reality: Snowflake has 80+ object
types with deep, frequently-changing option clauses. Fully enforcing every
clause of every object is a moving target. The plan below handles this with a
**two-tier** strategy rather than pretending to model everything.

### 1.4 Completeness scorecard

| Area | Parses? | Structured enough for JSON/Rego? |
|---|---|---|
| SELECT / DML | ✅ broad | ✅ (queries usually not the policy target) |
| GRANT / REVOKE | ✅ | ⚠️ needs named privilege/on/to nodes |
| CREATE TABLE | ✅ | ❌ columns are token soup (`CTP`) |
| CREATE SCHEMA/DB/WAREHOUSE/ROLE/USER | ✅/partial | ⚠️ names + options under-typed |
| Masking / Row-Access / Tag / Network policy | ✅ partial | ⚠️ predicate/columns need nodes |
| Stage / File Format / Pipe / Stream / Task | ✅ | ⚠️ options under-typed |
| Long tail (agents, services, cortex, etc.) | ⚠️ generic scaffold | ❌ token soup |
| **Build reproducible from source** | ❌ | — |

---

## 2. Target architecture

```
             ┌───────────────┐   CST    ┌────────────────┐   JSON IR   ┌──────────────────┐
  SQL text → │ lezer parser  │ ───────► │  AST/IR builder │ ─────────► │  IR document      │
             │ (snowsql.gr)  │          │  (tree-walk, TS)│            │  (array of Stmt)  │
             └───────────────┘          └────────────────┘            └───────┬───────────┘
                                                                              │
                                          ┌───────────────────────────────────┼─────────────────┐
                                          ▼                                   ▼                 ▼
                                 ┌─────────────────┐               ┌────────────────┐  ┌────────────────┐
                                 │  JSON Schema     │               │  Rego / OPA     │  │  Terraform      │
                                 │  (validation)    │               │  (Aspis policy) │  │  emitter (HCL)  │
                                 └─────────────────┘               └────────────────┘  └────────────────┘
```

Design principles:

- **The JSON IR is the product**, not the parse tree. Grammar node names exist
  to make the tree-walk trivial; the IR is the stable public contract.
- **Semantic, not syntactic.** IR normalizes: upper-cases keywords, resolves
  `key = value` option lists into typed maps, splits qualified names into
  `{database, schema, object}`, coerces boolean/number/string literals.
- **Every statement carries a source span** (`{offset, length, line, col}` and
  raw text) so Aspis can point a violation back to the exact SQL.
- **Two tiers of fidelity** (see §4.1) so "any DDL" is achievable without
  modeling every clause of every object.

---

## 3. The JSON IR (contract sketch)

Top-level output is `{ "dialect": "snowflake", "statements": [ Stmt, … ] }`.
Every `Stmt` has: `statement` (discriminator), `source`, and a `raw` fallback.

### 3.1 `create_table`

```json
{
  "statement": "create_table",
  "or_replace": true,
  "kind": "TRANSIENT",
  "if_not_exists": false,
  "name": { "database": "SALES", "schema": "PUBLIC", "object": "CUSTOMERS" },
  "columns": [
    { "name": "ID",
      "type": { "base": "NUMBER", "precision": 38, "scale": 0 },
      "nullable": false,
      "identity": { "start": 1, "increment": 1 },
      "constraints": [{ "kind": "PRIMARY_KEY" }] },
    { "name": "EMAIL",
      "type": { "base": "VARCHAR", "length": 255 },
      "nullable": true,
      "masking_policy": { "name": { "object": "PII_EMAIL" }, "using": ["EMAIL"] },
      "tags": [{ "name": "PII", "value": "EMAIL" }] }
  ],
  "constraints": [
    { "kind": "FOREIGN_KEY", "columns": ["ACCOUNT_ID"],
      "references": { "name": { "object": "ACCOUNTS" }, "columns": ["ID"] } }
  ],
  "cluster_by": ["ID"],
  "properties": { "DATA_RETENTION_TIME_IN_DAYS": 90, "CHANGE_TRACKING": true },
  "copy_grants": false,
  "comment": "customer master",
  "source": { "offset": 0, "length": 412, "line": 3, "col": 1 }
}
```

### 3.2 `grant_privileges`

```json
{
  "statement": "grant_privileges",
  "privileges": ["SELECT", "INSERT"],
  "on": { "object_type": "TABLE",
          "name": { "database": "SALES", "schema": "PUBLIC", "object": "CUSTOMERS" } },
  "to": { "grantee_type": "ROLE", "name": "ANALYST" },
  "with_grant_option": false,
  "source": { "offset": 500, "length": 68 }
}
```

### 3.3 Tier-2 generic object (the long tail)

```json
{
  "statement": "create_object",
  "object_type": "CORTEX SEARCH SERVICE",
  "or_replace": false,
  "name": { "schema": "AI", "object": "DOC_SEARCH" },
  "properties": { "WAREHOUSE": "AI_WH", "TARGET_LAG": "1 hour", "ON": "BODY" },
  "unmodeled": ["… any clauses not recognized, preserved as raw text …"],
  "source": { "offset": 0, "length": 220 }
}
```

Even for un-modeled objects, `properties` is a **typed key/value map** — not a
token stream — so Rego can still assert on common options (`WAREHOUSE`,
`COMMENT`, `OWNER`, etc.).

A JSON Schema (draft 2020-12) for every `statement` variant lives in
`schema/ir/*.schema.json` and is enforced in CI against all golden fixtures.

---

## 4. Grammar workstream

### 4.1 Kill the token-soup; introduce a structured generic

The core move that fixes both the perf explosion **and** the JSON-usefulness
problem: replace `GenericCommandTail`/`GenericCommandAtom` with a **bounded,
structured option grammar**:

```
GenericObjectBody { PropertyList? GenericTailClause* }
PropertyList      { Property (Comma? Property)* }
Property          { PropertyKey Eql PropertyValue }
PropertyValue     { Literal | ObjName | ParenList | PropertyList /* nested */ }
```

- `Property` reuses the existing `KeyValueProperty` machinery, so option
  clauses become inspectable named nodes.
- The grammar stops trying to match "any token in any order," which removes the
  ambiguity that stalls `lezer-generator`.
- Anything genuinely free-form (e.g. a procedure body, an `AS <select>`) is
  captured by a **narrow, explicitly-delimited** rule, not a global catch-all.

### 4.2 Tier-1 (fully modeled) objects — priority order

Governance-critical objects get precise rules with named nodes for names,
columns, types, constraints, predicates, and typed options:

1. **Table** — replace `CTP` with the existing `ColumnDef`/`InlineTableConstraint`/
   `OutOfLineTableConstraint` machinery; add masking-policy/tag/`WITH` clauses;
   make the name an `ObjName`.
2. **Schema, Database, Warehouse** — `ObjName` names + typed `PropertyList`.
3. **Role, Database Role, User** — for RBAC policies.
4. **Grant / Revoke** — wrap privilege list, `On` target, and grantee in named
   nodes (`PrivilegeList`, `GrantTarget`, `Grantee`).
5. **Masking Policy, Row-Access Policy, Tag, Aggregation/Projection Policy** —
   capture signature, predicate/body, and `EXEMPT`/`ALLOWED` lists.
6. **Network Policy / Network Rule / Secret** — IP lists, value lists.
7. **Stage, File Format, Pipe, Stream, Task, Sequence, View / Materialized
   View, Integrations, Functions/Procedures** — typed option lists + `AS` body.

### 4.3 Tier-2 (structured-generic) objects

Everything else in Snowflake's object list routes through
`create_object` / `alter_object` / `drop_object` with `object_type` + typed
`PropertyList`. New object types become a one-line addition to an object-type
list — no new bespoke rule required.

### 4.4 Fixes bundled in

- Remove the duplicate `Network` (specialize vs extend).
- De-dupe and de-typo `tokens.js` keys.
- Point `CREATE DATABASE/SCHEMA` at `ObjName`.
- Add `@detectDelim` / explicit conflict markers only where needed.
- Delete the ~20 unused rules the generator warns about (or wire them in).

### 4.5 Toolchain decision

The repo uses **`lezer` 0.13 / `lezer-generator` 0.13** (pre-1.0, ~2020). The
maintained packages are `@lezer/lr` + `@lezer/generator` 1.x with `@lezer/common`
tree cursors — a better fit for building an AST walker and for long-term
maintenance. **Recommendation:** upgrade as Phase 0.5 (mechanical but breaking:
import paths, `fileTests` location, node-prop API). If we must stay on 0.13, the
plan still holds; only the tree-walker imports change.

---

## 5. AST / IR builder workstream

- **Language: TypeScript** (same ecosystem as lezer; ships as an npm module
  alongside the parser). One `buildIR(tree, sourceText)` entry point.
- Walk with a `TreeCursor`; a **dispatch table keyed by node name** produces one
  IR object per top-level `Stmt`. Each handler is small and independently
  testable.
- Shared helpers: `qualifiedName(node) → {database,schema,object}`,
  `literal(node) → string|number|boolean|null`, `propertyList(node) → object`,
  `span(node) → source`.
- **Golden IR fixtures**: for every `test/*.txt` case, add an expected
  `*.ir.json`. CI asserts CST (existing) **and** IR (new) **and** JSON-Schema
  validity.

---

## 6. Rego / Aspis integration workstream

- **Input contract**: Aspis/OPA receives the IR document as `input`. Document
  the exact shape (this doc + JSON Schema) so policy authors have a stable
  target.
- **Harness**: wrap `opa eval` / `conftest test` in a thin CLI:
  `sqlguard <file.sql> --policy ./policy/` → parse → IR → OPA → violations
  (each carrying the statement's `source` span for editor/CI annotations).
- **Starter policy pack** (`policy/*.rego`) to prove the contract, e.g.:
  - PII-tagged columns must have a masking policy.
  - No `GRANT … TO ROLE PUBLIC` of write/ownership privileges.
  - `CREATE TABLE` must set `DATA_RETENTION_TIME_IN_DAYS >= N`.
  - New databases/schemas must carry an `OWNER`/`COST_CENTER` tag.
  - No `CREATE … OR REPLACE` on protected schemas.
- **Open question for you:** is "Aspis" an existing tool with a fixed input
  contract we must match, or do we define the contract here? (See §9.)

---

## 7. Terraform emitter workstream

- IR → HCL via a per-`statement` mapping to **`snowflakedb/snowflake`**
  provider resources (formerly `Snowflake-Labs/snowflake`):
  - `create_table` → `snowflake_table` (+ `column` blocks, `snowflake_table_constraint`).
  - `create_schema`/`create_database` → `snowflake_schema` / `snowflake_database`.
  - `grant_privileges` → `snowflake_grant_privileges_to_account_role` (or
    `…_to_database_role`).
  - masking/row-access/tag/warehouse/user/role → corresponding resources.
- Deterministic resource addresses derived from qualified names → enables
  `terraform import` and stable diffs.
- **Round-trip test**: SQL → IR → HCL → `terraform validate` in CI (provider in
  a stub/offline mode). Tier-2 objects that lack a first-class resource emit a
  clearly-marked `# unsupported: <object_type>` stub rather than silently
  dropping.
- **Reality check:** the SQL→HCL mapping is lossy and provider-version
  sensitive; scope the emitter to Tier-1 objects first.

---

## 8. Phased delivery

| Phase | Outcome | Rough size |
|---|---|---|
| **0. Unblock** | Fix `Network` dupe + `tokens.js`; get `npm run build && npm test` green; add CI matrix. | S |
| **0.5. Toolchain** | Upgrade to `@lezer/generator` 1.x (optional but recommended). | S–M |
| **1. De-ambiguate** | Replace `GenericCommandTail` with structured `PropertyList`; confirm generator terminates < seconds; keep golden tests passing. | M |
| **2. Tier-1 grammar** | Rebuild `CREATE TABLE` on `ColumnDef`; model schema/db/warehouse/role/user/grant/policies with named nodes. | L |
| **3. IR builder + schema** | TS tree-walker, JSON Schema, golden `*.ir.json`, validation in CI. | L |
| **4. Rego/Aspis** | Input contract doc, `sqlguard` CLI, starter policy pack, conftest in CI. | M |
| **5. Terraform** | IR→HCL emitter for Tier-1, `terraform validate` round-trip tests. | M–L |
| **6. Long tail + hardening** | Tier-2 object coverage, fuzz corpus from real DDL dumps, docs. | ongoing |

Phases 0–1 are the unlock; nothing downstream can be trusted until the grammar
builds fast and deterministically.

---

## 9. Decisions needed from you

1. **Aspis contract** — existing tool with a fixed input JSON we must conform
   to, or do we define the IR/schema here?
2. **Scope of "any DDL"** — full Tier-1 modeling for the governance-relevant
   set (recommended), with Tier-2 structured-generic for the rest? Or an
   attempt to fully model every object type (much larger, moving target)?
3. **Terraform** — target `snowflakedb/snowflake` provider? Is generated HCL
   the deliverable, or would you rather emit provider-agnostic JSON that a
   separate step renders (keeps us out of provider-version churn)?
4. **Toolchain** — OK to upgrade off `lezer` 0.13 to `@lezer/*` 1.x?
5. **IR style** — faithful syntactic AST, or normalized semantic IR
   (recommended — much easier for Rego and TF)?

---

## 10. Immediate next step

Regardless of the above, **Phase 0 is unambiguous and safe**: fix the duplicate
`Network` rule and the `tokens.js` typos so the parser builds again, then lock
it in with CI. That can start now.
