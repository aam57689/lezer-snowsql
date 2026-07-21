# lezer-snowsql
 
## Overview

This is a SnowSQL grammar for the [lezer](https://lezer.codemirror.net/) parser system.

### Statements and Features

- [x] Drop Statement
- [x] Describe Statement
- [x] Create Integration Statement
- [x] Create Account Statement
- [x] Create Resource Monitor Statement
- [x] Create Role Statement
- [x] Create Database Statement
- [x] Create Share Statement
- [x] Create Table Statement
- [x] Grant Statement 
- [x] Commit Statement
- [x] Get Statement
- [x] Use Statement
- [x] Truncate Statement
- [x] Copy Statement
- [x] Select Statement
- [x] Alter Statements
- [x] Call Statement
- [x] Insert Statement
- [x] Delete Statement
- [x] Merge Statement
- [x] Set Statement
- [x] Show / Describe / Undrop Statements
- [x] Generic (Tier-2) Create / Alter / Drop for the long-tail object types
- [x] Comments - Inline + Block

> **Toolchain:** built with `@lezer/generator` / `@lezer/lr` 1.x. The grammar
> generates a **conflict-free (deterministic)** parser — a prerequisite for
> turning parses into a stable JSON IR. See
> [`docs/GRAMMAR_DDL_EXPANSION_PLAN.md`](docs/GRAMMAR_DDL_EXPANSION_PLAN.md)
> for the roadmap to AST→JSON (Rego/Aspis) and provider-agnostic Terraform.

# SnowSQL Grammar Expansion Notes

Source grammar: `C:\Users\Amartya\Downloads\snowsql.grammar`

Expanded grammar: `outputs/snowsql.expanded.grammar`

Snowflake reference used:

- https://docs.snowflake.com/en/sql-reference-commands
- https://docs.snowflake.com/en/sql-reference/sql-all
- https://docs.snowflake.com/en/sql-reference/sql/delete
- https://docs.snowflake.com/en/sql-reference/sql/update
- https://docs.snowflake.com/en/sql-reference/sql/merge
- https://docs.snowflake.com/en/sql-reference/sql/set

Main additions:

- Wired missing top-level statements into `Stmt`: `CALL`, `DELETE`, `UPDATE`, `MERGE`, `SET`, `UNSET`, `BEGIN`, `COMMENT`, `REVOKE`, `EXECUTE`, `EXPLAIN`, `PUT`, `LIST`, `REMOVE`, `COPY FILES`, and `UNDROP`.
- Wired previously unreachable create rules: `CreateFunctionStmt`, `CreateProcedureStmt`, `CreateSchema`, and `CreateMaskingPolicy`.
- Added broad `CreateGenericObjectStmt` and `AlterStmt` scaffolds for Snowflake's large DDL object surface.
- Expanded `DROP`, `DESCRIBE`, and `SHOW` target coverage for newer Snowflake object families.
- Added concrete DML syntax for common `DELETE`, `UPDATE`, and `MERGE` forms from the Snowflake SQL reference.
- Added `SELECT *` modifiers for `ILIKE`, `EXCLUDE`, `REPLACE`, and `RENAME`, plus `FOR UPDATE`.
- Fixed small existing grammar issues: `CastExpression` now uses `Types`, `BinaryType` accepts `Binary` or `Varbinary`, `CreateSchema` uses `Eql`, and an undefined `BitwiseOrExpression` reference was replaced with `ScalarExpression`.



Note:

The generic DDL scaffolds intentionally parse a broad long tail of Snowflake object commands. They are meant to improve coverage and syntax highlighting tolerance, not to fully enforce every object-specific Snowflake clause.


## Installation

```bash
npm install
```

## Development
### Building

```bash
 npm run build 
```
### Testing

```bash
 npm test
```

(You can also use yarn instead of npm.)


## License

The code is licensed under an [Apache 2.0](./LICENSE) license.
